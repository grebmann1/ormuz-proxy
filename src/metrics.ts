import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
  type CounterConfiguration,
  type GaugeConfiguration,
  type HistogramConfiguration
} from "prom-client";

type LabelNames<T extends string> = Record<T, string>;

function makeCounter<T extends string>(
  registry: Registry,
  config: Omit<CounterConfiguration<T>, "registers">
): Counter<T> {
  return new Counter({ ...config, registers: [registry] });
}

function makeGauge<T extends string>(registry: Registry, config: Omit<GaugeConfiguration<T>, "registers">): Gauge<T> {
  return new Gauge({ ...config, registers: [registry] });
}

function makeHistogram<T extends string>(
  registry: Registry,
  config: Omit<HistogramConfiguration<T>, "registers">
): Histogram<T> {
  return new Histogram({ ...config, registers: [registry] });
}

export class OrmuzMetrics {
  public readonly registry = new Registry();

  private readonly queueDepth: Gauge<"key">;
  private readonly queueWaitSeconds: Histogram<"key">;
  private readonly tokensAvailable: Gauge<"key">;
  private readonly requestsTotal: Counter<"outcome">;
  private readonly upstreamStatusTotal: Counter<"code">;

  public constructor() {
    collectDefaultMetrics({ register: this.registry });

    this.queueDepth = makeGauge(this.registry, {
      name: "ormuz_queue_depth",
      help: "Current queued requests per bucket key",
      labelNames: ["key"]
    });
    this.queueWaitSeconds = makeHistogram(this.registry, {
      name: "ormuz_queue_wait_seconds",
      help: "How long requests wait in queue",
      labelNames: ["key"],
      buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10, 30, 60]
    });
    this.tokensAvailable = makeGauge(this.registry, {
      name: "ormuz_tokens_available",
      help: "Available tokens in bucket",
      labelNames: ["key"]
    });
    this.requestsTotal = makeCounter(this.registry, {
      name: "ormuz_requests_total",
      help: "Total request outcomes",
      labelNames: ["outcome"]
    });
    this.upstreamStatusTotal = makeCounter(this.registry, {
      name: "ormuz_upstream_status_total",
      help: "Upstream status code count",
      labelNames: ["code"]
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

export function labels<T extends string>(values: LabelNames<T>): LabelNames<T> {
  return values;
}
