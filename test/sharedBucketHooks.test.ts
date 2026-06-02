import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Agent, MockAgent, setGlobalDispatcher } from "undici";

import { buildApp } from "../src/server.js";
import type { OrmuzHooks, RequestLifecyclePayload } from "../src/hooks.js";
import { makeConfig } from "./helpers/config.js";

const upstream = "https://shared-bucket.example.com";

describe("hook payloads with same-bucket concurrent requests", () => {
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

  it("each request sees its own requestId in onQueued, even when sharing one bucket", async () => {
    const pool = mockAgent.get(upstream);
    pool.intercept({ path: "/v1/chat/completions", method: "POST" }).reply(200, { ok: true }).times(2);

    const queuedPayloads: RequestLifecyclePayload[] = [];
    const completedPayloads: RequestLifecyclePayload[] = [];
    const hooks: OrmuzHooks = {
      onQueued: (p) => queuedPayloads.push(p),
      onRequestCompleted: (p) => completedPayloads.push(p)
    };

    app = buildApp(
      makeConfig({
        upstreamBaseUrl: upstream,
        bucketKeyMode: "global",
        effectiveRpm: 1,
        refillPerSec: 1
      }),
      hooks
    );

    const [first, second] = await Promise.all([
      app.inject({ method: "POST", url: "/v1/chat/completions", payload: { model: "x" } }),
      app.inject({ method: "POST", url: "/v1/chat/completions", payload: { model: "x" } })
    ]);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);

    // wait briefly for the second onRequestCompleted to fire after inject resolves
    await new Promise((r) => setTimeout(r, 50));

    const queuedIds = new Set(queuedPayloads.map((p) => p.requestId));
    expect(queuedIds.size).toBe(queuedPayloads.length);

    const completedIds = new Set(completedPayloads.map((p) => p.requestId));
    expect(completedIds.size).toBe(2);
    expect(completedIds).toEqual(new Set(queuedIds));
  });

  it("upstream-429 retry routes the hook to the request that actually saw the 429", async () => {
    const pool = mockAgent.get(upstream);
    // first request: 429 then 200 on retry
    pool.intercept({ path: "/v1/chat/completions", method: "POST" }).reply(429, { error: "slow" }, {
      headers: { "retry-after": "1" }
    });
    pool.intercept({ path: "/v1/chat/completions", method: "POST" }).reply(200, { ok: true, n: 1 });
    // second request, sharing the bucket
    pool.intercept({ path: "/v1/chat/completions", method: "POST" }).reply(200, { ok: true, n: 2 });

    const requestReceived: RequestLifecyclePayload[] = [];
    const upstream429Payloads: RequestLifecyclePayload[] = [];
    const hooks: OrmuzHooks = {
      onRequestReceived: (p) => requestReceived.push(p),
      onUpstream429: (p) => upstream429Payloads.push(p)
    };

    app = buildApp(
      makeConfig({
        upstreamBaseUrl: upstream,
        bucketKeyMode: "global",
        effectiveRpm: 10,
        refillPerSec: 10
      }),
      hooks
    );

    const firstPromise = app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-trace": "first" },
      payload: { model: "x" }
    });
    // Submit the second request while the first is paused on its retry-after.
    await new Promise((r) => setTimeout(r, 100));
    const secondPromise = app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-trace": "second" },
      payload: { model: "x" }
    });

    const [firstRes, secondRes] = await Promise.all([firstPromise, secondPromise]);
    expect(firstRes.statusCode).toBe(200);
    expect(secondRes.statusCode).toBe(200);

    expect(upstream429Payloads).toHaveLength(1);
    // The 429 belongs to the first request — verify by matching against the order of requestReceived.
    expect(requestReceived).toHaveLength(2);
    const firstRequestId = requestReceived[0]?.requestId;
    expect(upstream429Payloads[0]?.requestId).toBe(firstRequestId);
  }, 10_000);
});
