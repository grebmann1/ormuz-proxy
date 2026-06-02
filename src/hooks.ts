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

function safelyEmit(
  hook: ((payload: RequestLifecyclePayload) => void) | undefined,
  payload: RequestLifecyclePayload
): void {
  if (!hook) {
    return;
  }
  try {
    hook(payload);
  } catch {
    // Hook failures are intentionally ignored to keep the proxy path stable.
  }
}

export class HookRegistry {
  public constructor(private readonly hooks: OrmuzHooks = {}) {}

  public emitRequestReceived(payload: RequestLifecyclePayload): void {
    safelyEmit(this.hooks.onRequestReceived, payload);
  }

  public emitProviderResolved(payload: RequestLifecyclePayload): void {
    safelyEmit(this.hooks.onProviderResolved, payload);
  }

  public emitQueued(payload: RequestLifecyclePayload): void {
    safelyEmit(this.hooks.onQueued, payload);
  }

  public emitForwardStart(payload: RequestLifecyclePayload): void {
    safelyEmit(this.hooks.onForwardStart, payload);
  }

  public emitForwardResult(payload: RequestLifecyclePayload): void {
    safelyEmit(this.hooks.onForwardResult, payload);
  }

  public emitUpstream429(payload: RequestLifecyclePayload): void {
    safelyEmit(this.hooks.onUpstream429, payload);
  }

  public emitRequestCompleted(payload: RequestLifecyclePayload): void {
    safelyEmit(this.hooks.onRequestCompleted, payload);
  }
}
