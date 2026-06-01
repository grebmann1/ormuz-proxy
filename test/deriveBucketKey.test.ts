import { describe, expect, it } from "vitest";

import { deriveBucketKey } from "../src/proxy.js";

describe("deriveBucketKey", () => {
  it("returns 'global' in global mode regardless of inputs", () => {
    expect(deriveBucketKey("global", { authorization: "Bearer x" }, { model: "gpt-4o" }, "host.x")).toBe("global");
  });

  it("hashes the auth header in auth mode so the raw token never leaks into logs/metrics", () => {
    const key = deriveBucketKey("auth", { authorization: "Bearer sk-secret-abc" }, undefined);
    expect(key).toMatch(/^auth:[0-9a-f]{8}$/);
    expect(key).not.toContain("sk-secret-abc");
    expect(key).not.toContain("Bearer");
  });

  it("derives a stable bucket key per token", () => {
    const a = deriveBucketKey("auth", { authorization: "Bearer same" }, undefined);
    const b = deriveBucketKey("auth", { authorization: "Bearer same" }, undefined);
    const c = deriveBucketKey("auth", { authorization: "Bearer different" }, undefined);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("falls back to anonymous when no auth header is present", () => {
    expect(deriveBucketKey("auth", {}, undefined)).toBe("auth:anonymous");
  });

  it("reads model from the request body in model mode", () => {
    expect(deriveBucketKey("model", {}, { model: "gpt-4o-mini" })).toBe("model:gpt-4o-mini");
  });

  it("returns model:unknown when body lacks a model field", () => {
    expect(deriveBucketKey("model", {}, {})).toBe("model:unknown");
    expect(deriveBucketKey("model", {}, undefined)).toBe("model:unknown");
  });

  it("uses the lowercased upstream host in host mode", () => {
    expect(deriveBucketKey("host", {}, undefined, "API.OpenAI.com")).toBe("host:api.openai.com");
  });

  it("returns host:unknown in host mode without a host", () => {
    expect(deriveBucketKey("host", {}, undefined)).toBe("host:unknown");
  });
});
