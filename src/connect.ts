import { connect as netConnect, type Socket } from "node:net";
import type { IncomingMessage } from "node:http";

import type { OrmuzMetrics } from "./metrics.js";
import type { RequestScheduler } from "./scheduler.js";
import { QueueRejectedError } from "./types.js";

function parseConnectTarget(rawUrl: string): { host: string; port: number } | undefined {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return undefined;
  }
  const colonIdx = trimmed.lastIndexOf(":");
  if (colonIdx <= 0 || colonIdx === trimmed.length - 1) {
    return undefined;
  }
  const host = trimmed.slice(0, colonIdx).toLowerCase();
  const port = Number(trimmed.slice(colonIdx + 1));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return undefined;
  }
  return { host, port };
}

function writeAndDestroy(socket: Socket, response: string): void {
  try {
    socket.write(response, () => socket.destroy());
  } catch {
    socket.destroy();
  }
}

function tunnelSockets(client: Socket, upstream: Socket, head: Buffer | undefined): void {
  if (head && head.length > 0) {
    upstream.write(head);
  }
  let closed = false;
  const closeBoth = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    client.destroy();
    upstream.destroy();
  };
  client.on("error", closeBoth);
  client.on("close", closeBoth);
  upstream.on("error", closeBoth);
  upstream.on("close", closeBoth);
  client.pipe(upstream);
  upstream.pipe(client);
}

export function createConnectHandler(
  scheduler: RequestScheduler<void>,
  metrics: OrmuzMetrics,
  allowedHosts: Set<string>
): (req: IncomingMessage, clientSocket: Socket, head: Buffer) => void {
  return (req, clientSocket, head) => {
    const target = parseConnectTarget(req.url ?? "");
    if (!target) {
      writeAndDestroy(clientSocket, "HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    if (allowedHosts.size === 0 || !allowedHosts.has(target.host)) {
      writeAndDestroy(clientSocket, "HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const bucketKey = `host:${target.host}`;

    const respondToError = (error: unknown): void => {
      if (error instanceof QueueRejectedError) {
        const retrySec = Math.ceil(error.retryAfterMs / 1000);
        writeAndDestroy(clientSocket, `HTTP/1.1 429 Too Many Requests\r\nRetry-After: ${retrySec}\r\n\r\n`);
        return;
      }
      writeAndDestroy(clientSocket, "HTTP/1.1 502 Bad Gateway\r\n\r\n");
    };

    let pending: Promise<void>;
    try {
      pending = scheduler.submit(bucketKey, () => {
        return new Promise((resolveTask) => {
          const upstream = netConnect({ host: target.host, port: target.port });
          let settled = false;
          upstream.once("connect", () => {
            if (settled) {
              return;
            }
            settled = true;
            metrics.recordUpstreamStatus(200);
            metrics.recordForwarded();
            clientSocket.write("HTTP/1.1 200 Connection established\r\n\r\n", () => {
              tunnelSockets(clientSocket, upstream, head);
            });
            resolveTask({ kind: "ok", value: undefined });
          });
          upstream.once("error", () => {
            if (settled) {
              return;
            }
            settled = true;
            writeAndDestroy(clientSocket, "HTTP/1.1 502 Bad Gateway\r\n\r\n");
            resolveTask({ kind: "ok", value: undefined });
          });
        });
      });
    } catch (error) {
      respondToError(error);
      return;
    }
    pending.catch(respondToError);
  };
}
