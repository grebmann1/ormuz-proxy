import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Agent, MockAgent, setGlobalDispatcher } from "undici";

import { buildApp } from "../src/server.js";
import { makeConfig } from "./helpers/config.js";

const fallbackUpstream = "https://your-llm-gateway.example.com";
const baseConfig = makeConfig({ port: 8787, upstreamBaseUrl: fallbackUpstream });

describe("Ormuz proxy integration", () => {
  let mockAgent: MockAgent;
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }
    await mockAgent.close();
    setGlobalDispatcher(new Agent());
  });

  it("reports version and uptime at /health", async () => {
    app = buildApp(baseConfig);
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(typeof body.version).toBe("string");
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(typeof body.uptimeSec).toBe("number");
    expect(body.uptimeSec).toBeGreaterThanOrEqual(0);
  });

  it("exposes Prometheus metrics at /metrics", async () => {
    app = buildApp(baseConfig);
    const response = await app.inject({ method: "GET", url: "/metrics" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toMatch(/text\/plain/);
    const body = response.body;
    expect(body).toContain("ormuz_queue_depth");
    expect(body).toContain("ormuz_tokens_available");
    expect(body).toContain("ormuz_requests_total");
    expect(body).toContain("# HELP ");
    expect(body).toContain("# TYPE ");
  });

  it("exposes effective config at /config without leaking secrets", async () => {
    app = buildApp({
      ...baseConfig,
      upstreamToken: "shhh",
      providerTargets: { openai: "https://api.openai.com" }
    });
    const response = await app.inject({ method: "GET", url: "/config" });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;
    expect(body.upstreamTokenSet).toBe(true);
    expect(body).not.toHaveProperty("upstreamToken");
    expect(body.providers).toEqual({ openai: "https://api.openai.com" });
    expect(body.effectiveRpm).toBe(60);
  });

  it("passes through under-rate traffic", async () => {
    const pool = mockAgent.get(fallbackUpstream);
    pool.intercept({ path: "/v1/chat/completions", method: "POST" }).reply(200, { ok: true });

    app = buildApp(baseConfig);
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "x", messages: [] }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });

  it("queues over-rate traffic and eventually forwards it", async () => {
    const pool = mockAgent.get(fallbackUpstream);
    pool.intercept({ path: "/v1/chat/completions", method: "POST" }).reply(200, { ok: true });
    pool.intercept({ path: "/v1/chat/completions", method: "POST" }).reply(200, { ok: true, second: true });

    app = buildApp({
      ...baseConfig,
      effectiveRpm: 1,
      refillPerSec: 1
    });

    const start = Date.now();
    const first = app.inject({ method: "POST", url: "/v1/chat/completions", payload: { model: "x" } });
    const second = app.inject({ method: "POST", url: "/v1/chat/completions", payload: { model: "x" } });

    const [firstRes, secondRes] = await Promise.all([first, second]);
    const elapsed = Date.now() - start;

    expect(firstRes.statusCode).toBe(200);
    expect(secondRes.statusCode).toBe(200);
    expect(elapsed).toBeGreaterThanOrEqual(900);
  });

  it("rejects quickly when projected queue wait exceeds max", async () => {
    const pool = mockAgent.get(fallbackUpstream);
    pool.intercept({ path: "/v1/chat/completions", method: "POST" }).reply(200, { ok: true });

    app = buildApp({
      ...baseConfig,
      effectiveRpm: 1,
      refillPerSec: 1,
      maxQueueWaitMs: 10
    });

    const first = app.inject({ method: "POST", url: "/v1/chat/completions", payload: { model: "x" } });
    const second = app.inject({ method: "POST", url: "/v1/chat/completions", payload: { model: "x" } });
    const [firstRes, secondRes] = await Promise.all([first, second]);

    expect(firstRes.statusCode).toBe(200);
    expect(secondRes.statusCode).toBe(429);
    expect(secondRes.json().error).toBe("rate_limited");
  });

  it("retries once after upstream 429 retry-after", async () => {
    const pool = mockAgent.get(fallbackUpstream);
    pool.intercept({ path: "/v1/chat/completions", method: "POST" }).reply(429, { error: "slow_down" }, {
      headers: {
        "retry-after": "1"
      }
    });
    pool.intercept({ path: "/v1/chat/completions", method: "POST" }).reply(200, { ok: true, retried: true });

    app = buildApp({
      ...baseConfig,
      effectiveRpm: 10,
      refillPerSec: 10
    });

    const start = Date.now();
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "x" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, retried: true });
    expect(Date.now() - start).toBeGreaterThanOrEqual(900);
  }, 10_000);

  it("routes to provider target and rewrites path prefix", async () => {
    const openaiPool = mockAgent.get("https://api.openai.com");
    let upstreamAuth = "";
    openaiPool.intercept({ path: "/v1/chat/completions", method: "POST" }).reply((options) => {
      const headers = options.headers;
      let headerValue: string | string[] | null | undefined;
      if (headers && typeof (headers as { get?: unknown }).get === "function") {
        headerValue = (headers as { get: (name: string) => string | null }).get("authorization");
      } else {
        headerValue = (headers as Record<string, string | string[] | undefined> | undefined)?.authorization;
      }
      upstreamAuth = Array.isArray(headerValue) ? headerValue[0] ?? "" : String(headerValue ?? "");
      return {
        statusCode: 200,
        data: { provider: "openai" }
      };
    });

    app = buildApp({
      ...baseConfig,
      upstreamBaseUrl: undefined,
      providerTargets: {
        openai: "https://api.openai.com",
        anthropic: "https://api.anthropic.com",
        gemini: "https://generativelanguage.googleapis.com"
      }
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/openai/chat/completions",
      payload: { model: "x" },
      headers: {
        authorization: "Bearer REQUEST_KEY"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ provider: "openai" });
    expect(upstreamAuth).toBe("Bearer REQUEST_KEY");
  });

  it("returns 400 for unknown provider when provider targets configured", async () => {
    app = buildApp({
      ...baseConfig,
      upstreamBaseUrl: undefined,
      providerTargets: {
        openai: "https://api.openai.com"
      }
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/unknown/chat/completions",
      payload: { model: "x" }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: "unmatched_route"
    });
  });

  it("routes by header mapping with precedence over path", async () => {
    const anthropicPool = mockAgent.get("https://api.anthropic.com");
    let forwardedRoutingHeader = "present";
    anthropicPool.intercept({ path: "/v1/openai/chat/completions", method: "POST" }).reply((options) => {
      const headers = options.headers;
      if (headers && typeof headers.get === "function") {
        forwardedRoutingHeader = headers.get("x-ormuz-target") ?? "";
      } else {
        const objHeaders = headers as Record<string, string> | undefined;
        forwardedRoutingHeader = objHeaders?.["x-ormuz-target"] ?? "";
      }
      return { statusCode: 200, data: { provider: "anthropic" } };
    });

    app = buildApp({
      ...baseConfig,
      routingRules: {
        pathPrefixes: {
          "/v1/openai": "https://api.openai.com"
        },
        headers: [
          {
            header: "x-ormuz-target",
            value: "anthropic",
            target: "https://api.anthropic.com"
          }
        ]
      }
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/openai/chat/completions",
      headers: {
        "x-ormuz-target": "anthropic"
      },
      payload: { model: "x" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ provider: "anthropic" });
    expect(forwardedRoutingHeader).toBe("");
  });
});
