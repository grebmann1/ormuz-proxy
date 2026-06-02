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

  it("evicts idle bucket state so long-lived schedulers don't leak memory", async () => {
    const scheduler = new RequestScheduler<string>({
      bucketCapacity: 10,
      refillPerSec: 10_000, // refills capacity in ~1ms; eviction delay below dominates
      maxQueueDepth: 10,
      maxQueueWaitMs: 10_000,
      idleEvictionMs: 30
    });

    await scheduler.submit("transient-caller-1", async () => ({ kind: "ok", value: "ok" }));
    await scheduler.submit("transient-caller-2", async () => ({ kind: "ok", value: "ok" }));
    expect(scheduler.bucketCount()).toBe(2);

    await new Promise((r) => setTimeout(r, 80));
    expect(scheduler.bucketCount()).toBe(0);
  });

  it("does not evict a bucket while it has in-flight work", async () => {
    const scheduler = new RequestScheduler<string>({
      bucketCapacity: 10,
      refillPerSec: 10_000,
      maxQueueDepth: 10,
      maxQueueWaitMs: 10_000,
      idleEvictionMs: 10
    });

    let release: (() => void) | undefined;
    const taskPromise = scheduler.submit("busy", () => {
      return new Promise((resolve) => {
        release = () => resolve({ kind: "ok", value: "done" });
      });
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(scheduler.bucketCount()).toBe(1);
    release?.();
    await taskPromise;
    await new Promise((r) => setTimeout(r, 50));
    expect(scheduler.bucketCount()).toBe(0);
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
