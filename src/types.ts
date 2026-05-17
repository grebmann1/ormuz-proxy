export type ScheduledResult<T> = { kind: "ok"; value: T } | { kind: "upstream_429"; retryAfterMs: number };

export type ScheduledTask<T> = (attempt: number, bucketKey: string) => Promise<ScheduledResult<T>>;

export class QueueRejectedError extends Error {
  public constructor(public readonly retryAfterMs: number, message = "Queue is full or wait too long") {
    super(message);
    this.name = "QueueRejectedError";
  }
}
