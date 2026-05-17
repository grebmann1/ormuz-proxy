import { describe, expect, it } from "vitest";

import { TokenBucket } from "../src/tokenBucket.js";

describe("TokenBucket", () => {
  it("consumes available tokens immediately", () => {
    const bucket = new TokenBucket(2, 1, 0);
    expect(bucket.tryTake(0)).toEqual({ ok: true });
    expect(bucket.tryTake(0)).toEqual({ ok: true });
    expect(bucket.tryTake(0)).toEqual({ ok: false, waitMs: 1000 });
  });

  it("refills over time", () => {
    const bucket = new TokenBucket(1, 2, 0);
    expect(bucket.tryTake(0)).toEqual({ ok: true });
    expect(bucket.tryTake(200)).toEqual({ ok: false, waitMs: 300 });
    expect(bucket.tryTake(500)).toEqual({ ok: true });
  });

  it("respects pauseUntil", () => {
    const bucket = new TokenBucket(1, 1, 0);
    expect(bucket.tryTake(0)).toEqual({ ok: true });
    bucket.pauseUntil(5000);
    expect(bucket.tryTake(3000)).toEqual({ ok: false, waitMs: 1000 });
    expect(bucket.tryTake(5000)).toEqual({ ok: false, waitMs: 1000 });
    expect(bucket.tryTake(6000)).toEqual({ ok: true });
  });
});
