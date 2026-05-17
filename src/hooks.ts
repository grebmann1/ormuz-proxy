export type RequestLifecyclePayload = {
  requestId: string;
  method: string;
  originalPath: string;
  bucketKey?: string;
  provider?: string;
  routeStrategy?: "providerPrefix" | "pathPrefix" | "header";
  upstreamBaseUrl?: string;
  upstreamPath?: string;
  statusCode?: number;
  durationMs?: number;
  queueDepth?: number;
  retryAfterMs?: number;
  error?: unknown;
};

export type OrmuzHooks = {
  onRequestReceived?: (payload: RequestLifecyclePayload) => void;
  onProviderResolved?: (payload: RequestLifecyclePayload) => void;
  onQueued?: (payload: RequestLifecyclePayload) => void;
  onForwardStart?: (payload: RequestLifecyclePayload) => void;
  onForwardResult?: (payload: RequestLifecyclePayload) => void;
  onUpstream429?: (payload: RequestLifecyclePayload) => void;
  onRequestCompleted?: (payload: RequestLifecyclePayload) => void;
};

function safelyRun(hook: (() => void) | undefined): void {
  if (!hook) {
    return;
  }
  try {
    hook();
  } catch {
    // Hook failures are intentionally ignored to keep the proxy path stable.
  }
}

export class HookRegistry {
  public constructor(private readonly hooks: OrmuzHooks = {}) {}

  public emitRequestReceived(payload: RequestLifecyclePayload): void {
    safelyRun(this.hooks.onRequestReceived ? () => this.hooks.onRequestReceived?.(payload) : undefined);
  }

  public emitProviderResolved(payload: RequestLifecyclePayload): void {
    safelyRun(this.hooks.onProviderResolved ? () => this.hooks.onProviderResolved?.(payload) : undefined);
  }

  public emitQueued(payload: RequestLifecyclePayload): void {
    safelyRun(this.hooks.onQueued ? () => this.hooks.onQueued?.(payload) : undefined);
  }

  public emitForwardStart(payload: RequestLifecyclePayload): void {
    safelyRun(this.hooks.onForwardStart ? () => this.hooks.onForwardStart?.(payload) : undefined);
  }

  public emitForwardResult(payload: RequestLifecyclePayload): void {
    safelyRun(this.hooks.onForwardResult ? () => this.hooks.onForwardResult?.(payload) : undefined);
  }

  public emitUpstream429(payload: RequestLifecyclePayload): void {
    safelyRun(this.hooks.onUpstream429 ? () => this.hooks.onUpstream429?.(payload) : undefined);
  }

  public emitRequestCompleted(payload: RequestLifecyclePayload): void {
    safelyRun(this.hooks.onRequestCompleted ? () => this.hooks.onRequestCompleted?.(payload) : undefined);
  }
}
