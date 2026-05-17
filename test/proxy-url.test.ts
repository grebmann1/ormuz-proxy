import { describe, expect, it } from "vitest";

import { buildUpstreamUrl } from "../src/proxy.js";

describe("buildUpstreamUrl", () => {
  it("does not duplicate /v1 when base and path share prefix", () => {
    const url = buildUpstreamUrl(
      "https://gateway.example.com/v1",
      "/v1/chat/completions",
      ""
    );
    expect(url).toBe("https://gateway.example.com/v1/chat/completions");
  });

  it("appends path when request path does not include base prefix", () => {
    const url = buildUpstreamUrl(
      "https://gateway.example.com/v1",
      "/chat/completions",
      "a=1"
    );
    expect(url).toBe("https://gateway.example.com/v1/chat/completions?a=1");
  });
});
