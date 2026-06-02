import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";

export class OrmuzMetrics {
  public readonly registry = new Registry();

  private readonly queueDepth: Gauge<"key">;
  private readonly queueWaitSeconds: Histogram<"key">;
  private readonly tokensAvailable: Gauge<"key">;
  private readonly requestsTotal: Counter<"outcome">;
  private readonly upstreamStatusTotal: Counter<"code">;

  public constructor() {
    collectDefaultMetrics({ register: this.registry });
    const registers = [this.registry];

    this.queueDepth = new Gauge({
      name: "ormuz_queue_depth",
      help: "Current queued requests per bucket key",
      labelNames: ["key"],
      registers
    });
    this.queueWaitSeconds = new Histogram({
      name: "ormuz_queue_wait_seconds",
      help: "How long requests wait in queue",
      labelNames: ["key"],
      buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10, 30, 60],
      registers
    });
    this.tokensAvailable = new Gauge({
      name: "ormuz_tokens_available",
      help: "Available tokens in bucket",
      labelNames: ["key"],
      registers
    });
    this.requestsTotal = new Counter({
      name: "ormuz_requests_total",
      help: "Total request outcomes",
      labelNames: ["outcome"],
      registers
    });
    this.upstreamStatusTotal = new Counter({
      name: "ormuz_upstream_status_total",
      help: "Upstream status code count",
      labelNames: ["code"],
      registers
    });
  }

  public schedulerHooks() {
    return {
      onQueued: (bucketKey: string, depth: number) => {
        this.queueDepth.labels({ key: bucketKey }).set(depth);
        this.requestsTotal.labels({ outcome: "queued" }).inc();
      },
      onQueueRejected: () => {
        this.requestsTotal.labels({ outcome: "client_429" }).inc();
      },
      onDequeued: (bucketKey: string, waitMs: number, depth: number) => {
        this.queueDepth.labels({ key: bucketKey }).set(depth);
        this.queueWaitSeconds.labels({ key: bucketKey }).observe(waitMs / 1000);
      },
      onUpstream429: () => {
        this.requestsTotal.labels({ outcome: "upstream_429" }).inc();
      },
      onTokensAvailable: (bucketKey: string, tokens: number) => {
        this.tokensAvailable.labels({ key: bucketKey }).set(tokens);
      }
    };
  }

  public recordUpstreamStatus(code: number): void {
    this.upstreamStatusTotal.labels({ code: String(code) }).inc();
  }

  public recordForwarded(): void {
    this.requestsTotal.labels({ outcome: "forwarded" }).inc();
  }

  public async snapshot(): Promise<string> {
    return this.registry.metrics();
  }

  public contentType(): string {
    return this.registry.contentType;
  }
}
