# How Ormuz Works

This document explains the internal flow so engineers can reason about behavior under load.

## High-Level Architecture

Ormuz is a single-process HTTP proxy with four core parts:

- `server.ts`: accepts incoming `/v1/*` requests, resolves provider target, computes bucket key, and delegates to scheduler
- `scheduler.ts`: decides when a request can run (token bucket + bounded FIFO queue)
- `proxy.ts`: forwards the request to the upstream LLM Gateway and streams the response back
- `providerRouter.ts`: resolves provider by URL prefix and rewrites request path

## Request Lifecycle

1. Client sends request to `http://ormuz/v1/...`.
2. Server resolves route using precedence:
   - header-value exact match rules
   - path-prefix rules (longest prefix wins)
   - provider-prefix fallback
   and then picks the target endpoint.
3. Server computes a bucket key (`auth`, `global`, or `model`) based on `ORMUZ_BUCKET_KEY`.
4. Request is submitted to the scheduler for that key.
5. Scheduler either:
   - forwards immediately (token available), or
   - enqueues in FIFO until token is available, or
   - rejects early with local `429` if queue is full / projected wait too high.
6. Proxy sends the request to the provider-specific upstream target with cleaned headers.
7. Upstream response is streamed directly back to the caller.

## Rate Limiting Model

Ormuz uses a **token bucket** per bucket key:

- `capacity = effectiveRpm` (after applying safety factor)
- `refillPerSec = effectiveRpm / 60`
- each request costs 1 token

This allows short bursts while keeping average traffic under the configured RPM.

### Why token bucket

- Better burst handling than fixed-window counters.
- Easy to compute wait time until next request can run.
- Minimal state and predictable behavior for a single-instance service.

## Queueing and Rejection Policy

Each bucket has a bounded FIFO queue:

- max depth: `ORMUZ_MAX_QUEUE_DEPTH`
- max projected wait: `ORMUZ_MAX_QUEUE_WAIT_MS`

If either threshold is exceeded, Ormuz returns local `429` immediately instead of letting latency grow without bound.

## Upstream 429 Handling

When upstream responds with `429`:

1. Ormuz parses `Retry-After`.
2. It pauses the token bucket for that key until that time.
3. The same request is re-queued at the **front** once (single retry).
4. If it fails again with `429`, the error is surfaced.

This protects clients from transient upstream pressure while avoiding infinite retry loops.

## Bucket Key Strategies

- `auth` (default): isolates each caller token into its own bucket; best fairness for internal users
- `global`: one shared bucket for all requests
- `model`: separate bucket per `model` in JSON body

## Header and Body Handling

- Hop-by-hop headers are removed before forwarding.
- Caller authorization is passed through unchanged; keys are not stored in Ormuz configuration.
- Request body is buffered once so retries can replay exactly the same payload.
- Responses are streamed back to the client to support completion streaming.

## Provider Target Configuration

Provider targets are loaded in a flexible way:

- `ORMUZ_PROVIDER_TARGETS` JSON map
- optional `ORMUZ_PROVIDER_TARGETS_FILE` (JSON/YAML), which overrides env map keys

This allows easy addition of future providers without code changes.

Routing rules can be configured in `routes.pathPrefixes` and `routes.headers`:

- `routes.headers`: map exact header/value pairs to targets
- `routes.pathPrefixes`: map incoming path prefixes to targets

## Hook Lifecycle

Ormuz exposes lifecycle hooks for extension and custom monitoring:

- `onRequestReceived`
- `onProviderResolved`
- `onQueued`
- `onForwardStart`
- `onForwardResult`
- `onUpstream429`
- `onRequestCompleted`

Hook handlers are best-effort and never block request processing.

## Observability

Use `/metrics` to monitor behavior:

- `ormuz_queue_depth{key}`: current queue size per bucket
- `ormuz_queue_wait_seconds{key}`: queued wait latency distribution
- `ormuz_tokens_available{key}`: current token availability
- `ormuz_requests_total{outcome}`: forwarded, queued, client_429, upstream_429
- `ormuz_upstream_status_total{code}`: upstream status distribution

Suggested alerts:

- sustained growth in `ormuz_queue_depth`
- spikes in `client_429` (local overload)
- spikes in `upstream_429` (gateway pressure or shared-key contention)

## Operational Tuning

Start with:

- `ORMUZ_RPM`: your known upstream limit
- `ORMUZ_SAFETY_FACTOR=0.95`
- `ORMUZ_MAX_QUEUE_DEPTH=200`
- `ORMUZ_MAX_QUEUE_WAIT_MS=60000`

Then tune based on metrics:

- If queue is usually empty and no 429s, you can increase RPM/safety slightly.
- If local 429s appear too often, increase queue bounds or lower incoming concurrency.
- If upstream 429s persist, reduce effective RPM or separate traffic into more bucket keys.
