import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Agent, MockAgent, setGlobalDispatcher } from "undici";

import { buildApp } from "../src/server.js";
import type { OrmuzHooks, RequestLifecyclePayload } from "../src/hooks.js";
import { makeConfig } from "./helpers/config.js";

const upstream = "https://hook-path.example.com";

describe("hook payload originalPath", () => {
  let mockAgent: MockAgent;
  let app: ReturnType<typeof buildApp> | undefined;

  beforeEach(() => {
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
  });

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
    await mockAgent.close();
    setGlobalDispatcher(new Agent());
  });

  it("strips the query string from originalPath so endpoint cardinality stays bounded", async () => {
    const pool = mockAgent.get(upstream);
    pool.intercept({ path: /\/v1\/chat\/completions/, method: "POST" }).reply(200, { ok: true }).times(2);

    const received: RequestLifecyclePayload[] = [];
    const hooks: OrmuzHooks = {
      onRequestReceived: (p) => received.push(p)
    };

    app = buildApp(makeConfig({ upstreamBaseUrl: upstream }), hooks);

    await app.inject({ method: "POST", url: "/v1/chat/completions?trace=a", payload: { model: "x" } });
    await app.inject({ method: "POST", url: "/v1/chat/completions?trace=b", payload: { model: "x" } });

    expect(received.map((p) => p.originalPath)).toEqual([
      "/v1/chat/completions",
      "/v1/chat/completions"
    ]);
  });
});
