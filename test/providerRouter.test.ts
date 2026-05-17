import { describe, expect, it } from "vitest";

import { resolveByPathPrefix, resolveConfiguredRoute, resolveProviderRoute } from "../src/providerRouter.js";

describe("resolveProviderRoute", () => {
  const targets = {
    openai: "https://api.openai.com",
    anthropic: "https://api.anthropic.com",
    gemini: "https://generativelanguage.googleapis.com"
  };

  it("resolves provider from /v1/{provider}/... path", () => {
    const route = resolveProviderRoute("/v1/openai/chat/completions", targets);
    expect(route).toEqual({
      provider: "openai",
      upstreamBaseUrl: "https://api.openai.com",
      rewrittenPath: "/v1/chat/completions",
      routeStrategy: "providerPrefix"
    });
  });

  it("resolves provider from top-level /{provider}/... path", () => {
    const route = resolveProviderRoute("/anthropic/v1/messages", targets);
    expect(route?.provider).toBe("anthropic");
    expect(route?.rewrittenPath).toBe("/v1/messages");
  });

  it("returns undefined for unknown provider", () => {
    const route = resolveProviderRoute("/v1/unknown/chat/completions", targets);
    expect(route).toBeUndefined();
  });
});

describe("resolveConfiguredRoute", () => {
  it("matches by exact header value", () => {
    const route = resolveConfiguredRoute(
      "/v1/whatever",
      { "x-ormuz-target": "openai" },
      {
        pathPrefixes: { "/v1/openai": "https://api.openai.com" },
        headers: [{ header: "x-ormuz-target", value: "openai", target: "https://api.openai.com" }]
      }
    );
    expect(route?.routeStrategy).toBe("header");
    expect(route?.upstreamBaseUrl).toBe("https://api.openai.com");
  });

  it("uses longest path prefix match", () => {
    const route = resolveByPathPrefix("/v1/openai/chat/completions", {
      "/v1": "https://example.com",
      "/v1/openai": "https://api.openai.com"
    });
    expect(route?.routeStrategy).toBe("pathPrefix");
    expect(route?.upstreamBaseUrl).toBe("https://api.openai.com");
    expect(route?.rewrittenPath).toBe("/chat/completions");
  });

  it("header mapping takes precedence over path prefix", () => {
    const route = resolveConfiguredRoute(
      "/v1/openai/chat/completions",
      { "x-ormuz-target": "anthropic" },
      {
        pathPrefixes: { "/v1/openai": "https://api.openai.com" },
        headers: [{ header: "x-ormuz-target", value: "anthropic", target: "https://api.anthropic.com" }]
      }
    );
    expect(route?.routeStrategy).toBe("header");
    expect(route?.upstreamBaseUrl).toBe("https://api.anthropic.com");
  });

  it("strips a matching path prefix even when the header rule wins", () => {
    const route = resolveConfiguredRoute(
      "/v1/openai/chat/completions",
      { "x-ormuz-target": "openai" },
      {
        pathPrefixes: { "/v1/openai": "https://gateway.example.com/v1" },
        headers: [{ header: "x-ormuz-target", value: "openai", target: "https://gateway.example.com/v1" }]
      }
    );
    expect(route?.routeStrategy).toBe("header");
    expect(route?.upstreamBaseUrl).toBe("https://gateway.example.com/v1");
    expect(route?.rewrittenPath).toBe("/chat/completions");
  });

  it("leaves the path untouched when no path prefix rule applies", () => {
    const route = resolveConfiguredRoute(
      "/custom/path",
      { "x-ormuz-target": "openai" },
      {
        pathPrefixes: {},
        headers: [{ header: "x-ormuz-target", value: "openai", target: "https://gateway.example.com" }]
      }
    );
    expect(route?.routeStrategy).toBe("header");
    expect(route?.rewrittenPath).toBe("/custom/path");
  });
});
