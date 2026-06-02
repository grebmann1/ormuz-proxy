import { BoundedQueue } from "./queue.js";
import { TokenBucket } from "./tokenBucket.js";
import { QueueRejectedError, type ScheduledTask } from "./types.js";

type QueueItem<T> = {
  attempt: number;
  task: ScheduledTask<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  enqueuedAtMs: number;
  submitHooks?: SubmitHooks;
};

type BucketState<T> = {
  bucket: TokenBucket;
  queue: BoundedQueue<QueueItem<T>>;
  timer: NodeJS.Timeout | undefined;
  evictTimer: NodeJS.Timeout | undefined;
  draining: boolean;
  inFlight: number;
};

export type SchedulerHooks = {
  onQueued?: (bucketKey: string, depth: number) => void;
  onQueueRejected?: (bucketKey: string, projectedWaitMs: number) => void;
  onDequeued?: (bucketKey: string, waitMs: number, depth: number) => void;
  onUpstream429?: (bucketKey: string, retryAfterMs: number) => void;
  onTokensAvailable?: (bucketKey: string, tokens: number) => void;
};

export type SchedulerOptions = {
  bucketCapacity: number;
  refillPerSec: number;
  maxQueueDepth: number;
  maxQueueWaitMs: number;
  maxRetryAfterMs?: number;
  // Evict idle bucket state this long after a bucket becomes empty + fully refilled.
  // Default 60s. Eviction is observationally equivalent to keeping the bucket since a
  // fresh bucket starts full at the same capacity. Set to 0 to disable.
  idleEvictionMs?: number;
  hooks?: SchedulerHooks;
};

export type SubmitHooks = {
  onQueued?: (depth: number) => void;
  onUpstream429?: (retryAfterMs: number) => void;
};

export class RequestScheduler<T> {
  private readonly buckets = new Map<string, BucketState<T>>();

  public constructor(private readonly options: SchedulerOptions) {}

  public submit(bucketKey: string, task: ScheduledTask<T>, submitHooks?: SubmitHooks): Promise<T> {
    const state = this.getOrCreateState(bucketKey);
    const projectedWaitMs =
      state.queue.projectedWaitMs(this.options.refillPerSec) + state.bucket.waitUntilNextTokenMs();
    if (state.queue.isFull() || projectedWaitMs > this.options.maxQueueWaitMs) {
      this.options.hooks?.onQueueRejected?.(bucketKey, projectedWaitMs);
      throw new QueueRejectedError(Math.max(1_000, projectedWaitMs));
    }

    if (state.evictTimer) {
      clearTimeout(state.evictTimer);
      state.evictTimer = undefined;
    }

    return new Promise<T>((resolve, reject) => {
      const item: QueueItem<T> = {
        attempt: 0,
        task,
        resolve,
        reject,
        enqueuedAtMs: Date.now(),
        submitHooks
      };
      state.queue.enqueue(item);
      const depth = state.queue.size();
      this.options.hooks?.onQueued?.(bucketKey, depth);
      submitHooks?.onQueued?.(depth);
      this.schedule(bucketKey, state);
    });
  }

  public queueDepth(bucketKey: string): number {
    return this.buckets.get(bucketKey)?.queue.size() ?? 0;
  }

  public bucketCount(): number {
    return this.buckets.size;
  }

  private getOrCreateState(bucketKey: string): BucketState<T> {
    const existing = this.buckets.get(bucketKey);
    if (existing) {
      return existing;
    }

    const state: BucketState<T> = {
      bucket: new TokenBucket(this.options.bucketCapacity, this.options.refillPerSec),
      queue: new BoundedQueue<QueueItem<T>>(this.options.maxQueueDepth),
      timer: undefined,
      evictTimer: undefined,
      draining: false,
      inFlight: 0
    };
    this.buckets.set(bucketKey, state);
    return state;
  }

  private maybeScheduleEviction(bucketKey: string, state: BucketState<T>): void {
    const idleEvictionMs = this.options.idleEvictionMs ?? 60_000;
    if (idleEvictionMs <= 0 || state.evictTimer) {
      return;
    }
    if (state.queue.size() > 0 || state.inFlight > 0 || state.timer) {
      return;
    }
    // Delay long enough for the token bucket to refill to capacity. After that,
    // the in-memory state is observationally equivalent to a freshly created bucket.
    const tokensMissing = Math.max(0, this.options.bucketCapacity - state.bucket.availableTokens());
    const refillMs =
      this.options.refillPerSec > 0
        ? Math.ceil((tokensMissing / this.options.refillPerSec) * 1000)
        : 0;
    const delay = Math.max(idleEvictionMs, refillMs);
    state.evictTimer = setTimeout(() => {
      state.evictTimer = undefined;
      const live = this.buckets.get(bucketKey);
      if (!live || live !== state) {
        return;
      }
      if (live.queue.size() === 0 && live.inFlight === 0 && !live.timer) {
        this.buckets.delete(bucketKey);
      }
    }, delay);
    state.evictTimer.unref();
  }

  private schedule(bucketKey: string, state: BucketState<T>): void {
    if (state.draining) {
      return;
    }

    state.draining = true;
    try {
      while (state.queue.size() > 0) {
        const take = state.bucket.tryTake();
        this.options.hooks?.onTokensAvailable?.(bucketKey, state.bucket.availableTokens());
        if (!take.ok) {
          if (!state.timer) {
            state.timer = setTimeout(() => {
              state.timer = undefined;
              this.schedule(bucketKey, state);
            }, take.waitMs);
          }
          return;
        }

        const item = state.queue.dequeue();
        if (!item) {
          return;
        }

        this.options.hooks?.onDequeued?.(bucketKey, Date.now() - item.enqueuedAtMs, state.queue.size());
        state.inFlight += 1;
        void this.executeItem(bucketKey, state, item);
      }
    } finally {
      state.draining = false;
    }
  }

  private async executeItem(bucketKey: string, state: BucketState<T>, item: QueueItem<T>): Promise<void> {
    try {
      const result = await item.task(item.attempt, bucketKey);
      if (result.kind === "ok") {
        item.resolve(result.value);
        return;
      }

      const cappedRetryAfterMs = this.options.maxRetryAfterMs
        ? Math.min(result.retryAfterMs, this.options.maxRetryAfterMs)
        : result.retryAfterMs;
      this.options.hooks?.onUpstream429?.(bucketKey, cappedRetryAfterMs);
      item.submitHooks?.onUpstream429?.(cappedRetryAfterMs);
      state.bucket.pauseUntil(Date.now() + cappedRetryAfterMs);
      if (item.attempt === 0) {
        state.queue.enqueueFront({ ...item, attempt: 1, enqueuedAtMs: Date.now() });
        return;
      }

      item.reject(new Error("Upstream returned 429 after retry"));
    } catch (error) {
      item.reject(error);
    } finally {
      state.inFlight -= 1;
      this.schedule(bucketKey, state);
      this.maybeScheduleEviction(bucketKey, state);
    }
  }
}
