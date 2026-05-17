import { describe, expect, it } from "vitest";

import { RequestScheduler } from "../src/scheduler.js";

describe("RequestScheduler", () => {
  it("re-enqueues at head on upstream 429 once", async () => {
    const scheduler = new RequestScheduler<string>({
      bucketCapacity: 10,
      refillPerSec: 10,
      maxQueueDepth: 10,
      maxQueueWaitMs: 10_000
    });
    let calls = 0;

    const result = await scheduler.submit("global", async (attempt) => {
      calls += 1;
      if (attempt === 0) {
        return { kind: "upstream_429", retryAfterMs: 10 };
      }
      return { kind: "ok", value: "ok" };
    });

    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });
});
