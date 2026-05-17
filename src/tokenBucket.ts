export type TakeResult = { ok: true } | { ok: false; waitMs: number };

export class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;
  private pausedUntilMs: number;

  public constructor(
    public readonly capacity: number,
    public readonly refillPerSec: number,
    nowMs = Date.now()
  ) {
    this.tokens = capacity;
    this.lastRefillMs = nowMs;
    this.pausedUntilMs = 0;
  }

  public availableTokens(nowMs = Date.now()): number {
    this.refill(nowMs);
    return this.tokens;
  }

  public tryTake(nowMs = Date.now()): TakeResult {
    this.refill(nowMs);
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return { ok: true };
    }

    if (this.refillPerSec <= 0) {
      return { ok: false, waitMs: 60_000 };
    }

    const waitMs = Math.ceil(((1 - this.tokens) / this.refillPerSec) * 1000);
    return { ok: false, waitMs: Math.max(1, waitMs) };
  }

  public waitUntilNextTokenMs(nowMs = Date.now()): number {
    this.refill(nowMs);
    if (this.tokens >= 1) {
      return 0;
    }
    if (this.refillPerSec <= 0) {
      return 60_000;
    }
    return Math.max(1, Math.ceil(((1 - this.tokens) / this.refillPerSec) * 1000));
  }

  public pauseUntil(epochMs: number): void {
    if (epochMs <= this.pausedUntilMs) {
      return;
    }
    this.pausedUntilMs = epochMs;
    this.tokens = 0;
    this.lastRefillMs = epochMs;
  }

  private refill(nowMs: number): void {
    if (nowMs < this.pausedUntilMs) {
      this.tokens = 0;
      return;
    }

    if (this.lastRefillMs > nowMs) {
      this.lastRefillMs = nowMs;
      return;
    }

    const elapsedSec = (nowMs - this.lastRefillMs) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillPerSec);
    this.lastRefillMs = nowMs;
  }
}
