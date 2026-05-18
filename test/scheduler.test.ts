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

  it("caps the upstream retry-after pause at maxRetryAfterMs", async () => {
    let observedPauseMs = -1;
    const scheduler = new RequestScheduler<string>({
      bucketCapacity: 10,
      refillPerSec: 10,
      maxQueueDepth: 10,
      maxQueueWaitMs: 10_000,
      maxRetryAfterMs: 50,
      hooks: {
        onUpstream429: (_bucketKey, pauseMs) => {
          observedPauseMs = pauseMs;
        }
      }
    });

    const startedAt = Date.now();
    const result = await scheduler.submit("global", async (attempt) => {
      if (attempt === 0) {
        return { kind: "upstream_429", retryAfterMs: 60_000 };
      }
      return { kind: "ok", value: "ok" };
    });
    const elapsed = Date.now() - startedAt;

    expect(result).toBe("ok");
    expect(observedPauseMs).toBe(50);
    expect(elapsed).toBeLessThan(2_000);
  });
});
