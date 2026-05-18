import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer as createTcpServer, connect as netConnect, type Server as TcpServer, type Socket } from "node:net";
import type { AddressInfo } from "node:net";

import { type AppConfig } from "../src/config.js";
import { buildApp } from "../src/server.js";

const baseConfig: AppConfig = {
  port: 0,
  upstreamBaseUrl: undefined,
  providerTargets: {},
  routingRules: { pathPrefixes: {}, headers: [] },
  rpm: 60,
  effectiveRpm: 60,
  refillPerSec: 1,
  bucketKeyMode: "global",
  maxQueueDepth: 200,
  maxQueueWaitMs: 60_000,
  upstreamToken: undefined,
  safetyFactor: 1,
  logLevel: "error"
};

type EchoUpstream = {
  server: TcpServer;
  port: number;
  host: string;
  close: () => Promise<void>;
};

async function startEchoUpstream(): Promise<EchoUpstream> {
  const server = createTcpServer((socket) => {
    socket.on("data", (chunk) => socket.write(chunk));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return {
    server,
    port: addr.port,
    host: "127.0.0.1",
    close: () => new Promise((resolve) => server.close(() => resolve()))
  };
}

type ConnectResult = {
  statusLine: string;
  socket: Socket;
};

function sendConnect(targetHost: string, targetPort: number, proxyPort: number): Promise<ConnectResult> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host: "127.0.0.1", port: proxyPort });
    let buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        return;
      }
      socket.removeListener("data", onData);
      const head = buffer.slice(0, headerEnd).toString("utf-8");
      const firstLine = head.split("\r\n")[0] ?? "";
      resolve({ statusLine: firstLine, socket });
    };
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n\r\n`);
    });
    socket.on("data", onData);
  });
}

describe("Ormuz CONNECT proxy", () => {
  let app: ReturnType<typeof buildApp> | undefined;
  let proxyPort = 0;
  let upstream: EchoUpstream | undefined;

  beforeEach(async () => {
    upstream = await startEchoUpstream();
  });

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
    if (upstream) {
      await upstream.close();
      upstream = undefined;
    }
  });

  async function startProxy(config: AppConfig): Promise<number> {
    app = buildApp(config);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address() as AddressInfo;
    proxyPort = addr.port;
    return proxyPort;
  }

  it("tunnels bytes for an allowed host", async () => {
    if (!upstream) throw new Error("upstream missing");
    const upstreamUrl = `http://${upstream.host}:${upstream.port}`;
    await startProxy({
      ...baseConfig,
      providerTargets: { test: upstreamUrl }
    });

    const { statusLine, socket } = await sendConnect(upstream.host, upstream.port, proxyPort);
    expect(statusLine).toBe("HTTP/1.1 200 Connection established");

    const echoed = await new Promise<string>((resolve, reject) => {
      socket.once("data", (chunk: Buffer) => resolve(chunk.toString("utf-8")));
      socket.once("error", reject);
      socket.write("hello-tunnel");
    });
    expect(echoed).toBe("hello-tunnel");
    socket.destroy();
  });

  it("rejects an unknown host with 403", async () => {
    if (!upstream) throw new Error("upstream missing");
    await startProxy({
      ...baseConfig,
      providerTargets: { test: `http://${upstream.host}:${upstream.port}` }
    });

    const { statusLine, socket } = await sendConnect("not-allowed.example.com", 443, proxyPort);
    expect(statusLine).toBe("HTTP/1.1 403 Forbidden");
    socket.destroy();
  });

  it("rejects with 403 when no routing is configured", async () => {
    if (!upstream) throw new Error("upstream missing");
    await startProxy({ ...baseConfig });

    const { statusLine, socket } = await sendConnect(upstream.host, upstream.port, proxyPort);
    expect(statusLine).toBe("HTTP/1.1 403 Forbidden");
    socket.destroy();
  });

  it("returns 429 with Retry-After when the queue rejects", async () => {
    if (!upstream) throw new Error("upstream missing");
    const upstreamUrl = `http://${upstream.host}:${upstream.port}`;
    await startProxy({
      ...baseConfig,
      providerTargets: { test: upstreamUrl },
      bucketKeyMode: "host",
      effectiveRpm: 1,
      refillPerSec: 1,
      maxQueueWaitMs: 5
    });

    const first = await sendConnect(upstream.host, upstream.port, proxyPort);
    expect(first.statusLine).toBe("HTTP/1.1 200 Connection established");

    const second = await sendConnect(upstream.host, upstream.port, proxyPort);
    expect(second.statusLine).toBe("HTTP/1.1 429 Too Many Requests");
    second.socket.destroy();
    first.socket.destroy();
  });
});
