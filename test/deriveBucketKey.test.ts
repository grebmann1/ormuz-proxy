import { describe, expect, it } from "vitest";

import { deriveBucketKey } from "../src/proxy.js";

describe("deriveBucketKey", () => {
  it("returns 'global' in global mode regardless of inputs", () => {
    expect(deriveBucketKey("global", { authorization: "Bearer x" }, { model: "gpt-4o" }, "host.x")).toBe("global");
  });

  it("uses the auth header in auth mode", () => {
    expect(deriveBucketKey("auth", { authorization: "Bearer abc" }, undefined)).toBe("auth:Bearer abc");
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
