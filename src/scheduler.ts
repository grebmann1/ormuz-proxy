import { BoundedQueue } from "./queue.js";
import { TokenBucket } from "./tokenBucket.js";
import { QueueRejectedError, type ScheduledTask } from "./types.js";

type QueueItem<T> = {
  attempt: number;
  task: ScheduledTask<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  enqueuedAtMs: number;
};

type BucketState<T> = {
  bucket: TokenBucket;
  queue: BoundedQueue<QueueItem<T>>;
  timer: NodeJS.Timeout | undefined;
  draining: boolean;
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
  hooks?: SchedulerHooks;
};

export class RequestScheduler<T> {
  private readonly buckets = new Map<string, BucketState<T>>();

  public constructor(private readonly options: SchedulerOptions) {}

  public submit(bucketKey: string, task: ScheduledTask<T>): Promise<T> {
    const state = this.getOrCreateState(bucketKey);
    const projectedWaitMs =
      state.queue.projectedWaitMs(this.options.refillPerSec) + state.bucket.waitUntilNextTokenMs();
    if (state.queue.isFull() || projectedWaitMs > this.options.maxQueueWaitMs) {
      this.options.hooks?.onQueueRejected?.(bucketKey, projectedWaitMs);
      throw new QueueRejectedError(Math.max(1_000, projectedWaitMs));
    }

    return new Promise<T>((resolve, reject) => {
      const item: QueueItem<T> = {
        attempt: 0,
        task,
        resolve,
        reject,
        enqueuedAtMs: Date.now()
      };
      state.queue.enqueue(item);
      this.options.hooks?.onQueued?.(bucketKey, state.queue.size());
      this.schedule(bucketKey, state);
    });
  }

  public queueDepth(bucketKey: string): number {
    return this.buckets.get(bucketKey)?.queue.size() ?? 0;
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
      draining: false
    };
    this.buckets.set(bucketKey, state);
    return state;
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
      state.bucket.pauseUntil(Date.now() + cappedRetryAfterMs);
      if (item.attempt === 0) {
        state.queue.enqueueFront({ ...item, attempt: 1, enqueuedAtMs: Date.now() });
        this.schedule(bucketKey, state);
        return;
      }

      item.reject(new Error("Upstream returned 429 after retry"));
    } catch (error) {
      item.reject(error);
    } finally {
      this.schedule(bucketKey, state);
    }
  }
}
