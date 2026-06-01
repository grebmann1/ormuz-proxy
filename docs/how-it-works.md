# How Ormuz Works

This document explains the internal flow so engineers can reason about behavior under load. For setup steps see `docs/install.md`; for the broader system context (deployments, integration points) see `docs/architecture.md`.

## High-Level Architecture

Ormuz is a single-process proxy with five core parts:

- `src/server.ts`: Fastify app for HTTP `/v1/*` traffic, plus a raw `'connect'` handler on the underlying `http.Server` for `CONNECT` tunnels
- `src/scheduler.ts`: decides when a request can run (token bucket + bounded FIFO queue); also clamps upstream `Retry-After`
- `src/proxy.ts`: forwards HTTP requests to the resolved upstream and streams the response back; derives the bucket key
- `src/providerRouter.ts`: resolves a target by header rule, path prefix, or provider-prefix fallback
- `src/tokenBucket.ts` + `src/queue.ts`: the primitives the scheduler is built on

The same Node `http.Server` carries both modes. Ordinary `/v1/*` requests go through Fastify; `CONNECT` is intercepted before Fastify ever sees the socket (`onListen` hook in `src/server.ts`).

## Request Lifecycle

For HTTP `/v1/*` requests:

1. Client sends a request to `http://ormuz/v1/...` (`app.all("/v1/*", ...)` in `src/server.ts`).
2. Server resolves the route in this precedence (see `resolveConfiguredRoute` / `resolveProviderRoute` in `src/providerRouter.ts`):
   - configured header rule (exact `header=value` match)
   - configured `pathPrefixes` (longest prefix wins)
   - provider-prefix fallback (e.g. `/v1/openai/...`)
3. Server computes a bucket key from `ORMUZ_BUCKET_KEY` (`deriveBucketKey` in `src/proxy.ts`).
4. The request is submitted to the scheduler for that key (`scheduler.submit` in `src/server.ts`).
5. The scheduler either:
   - takes a token and runs the task immediately,
   - enqueues FIFO until a token is free, or
   - rejects synchronously with `QueueRejectedError` if the queue is full or projected wait exceeds `ORMUZ_MAX_QUEUE_WAIT_MS` (see `src/scheduler.ts`); the server maps this to local `429` (`reply.code(429)` in `src/server.ts`).
6. `forwardRequest` (`src/proxy.ts`) cleans hop-by-hop and internal routing headers, calls `undici.request`, then streams the upstream response back to the caller.
7. If upstream answers `429` on the first attempt, the request is re-queued at the front once (see "Upstream 429 Handling").

```
Client -> /v1/...  -> route resolve -> bucket key -> scheduler.submit
                                                        |
                                                token? --+--> forwardRequest -> undici -> upstream
                                                        |        |
                                                        |        +-- 429 first try -> re-queue front (1x)
                                                        +-- queue full / wait > cap -> local 429
```

## HTTPS via CONNECT (system-proxy mode)

When a client (browser, `curl --proxy`, language SDK, OS proxy setting) needs to reach an HTTPS upstream through Ormuz, it sends `CONNECT host:port HTTP/1.1`. Ormuz must hand back a raw TCP tunnel — it never sees the TLS-encrypted bytes that follow. This lets Ormuz pace HTTPS traffic to providers without owning the TLS material.

The handler is wired by attaching a `'connect'` listener to the underlying Node `http.Server` from Fastify's `onListen` hook (`src/server.ts`).

### Lifecycle of a CONNECT

For example, `CONNECT api.openai.com:443 HTTP/1.1`:

1. **Parse target** (`handleConnect` in `src/server.ts`). `parseConnectTarget` splits the URL on the last colon and validates the port. Malformed targets get `400 Bad Request` and the socket is destroyed.
2. **Allowlist check.** The host (lowercased) must be in the set computed by `collectAllowedHosts(config)`. The set is built once at app construction from the hostnames of:
   - `config.upstreamBaseUrl`
   - every value in `config.providerTargets`
   - every value in `config.routingRules.pathPrefixes`
   - every `config.routingRules.headers[].target`
   If the set is empty (no routing configured) **all** CONNECTs are denied. This is intentional — Ormuz is not a general-purpose forward proxy, so a misconfigured instance fails closed. Denied CONNECTs get `403 Forbidden`.
3. **Scheduler submit.** The bucket key is `host:<lowercased-host>`, which deliberately matches what `deriveBucketKey` produces in `host` mode for HTTP traffic (`src/proxy.ts`) — see "Bucket Key Strategies" below.
4. **Open upstream socket.** Once a token is available, Ormuz calls `net.connect({ host, port })`.
   - On `connect`: write `HTTP/1.1 200 Connection established\r\n\r\n` to the client, then call `tunnelSockets` to `pipe` both directions and tear both sockets down on either `error` or `close`. Any TLS bytes already buffered in `head` are flushed to the upstream first.
   - On upstream `error`: write `HTTP/1.1 502 Bad Gateway\r\n\r\n` and destroy the client socket.
5. **Queue rejection.** If the scheduler throws `QueueRejectedError` synchronously (queue full / projected wait too high) or asynchronously (rejected later), Ormuz writes `HTTP/1.1 429 Too Many Requests` with a `Retry-After` header in seconds and destroys the socket.

### Response codes the client may see

| Code | Cause |
|------|-------|
| `200 Connection established` | tunnel ready, bytes flow both ways |
| `400 Bad Request` | malformed `CONNECT` target |
| `403 Forbidden` | host not in allowlist (or no routing configured) |
| `429 Too Many Requests` | local queue rejected; `Retry-After` set |
| `502 Bad Gateway` | upstream TCP `connect` failed |

CONNECT does not retry on upstream 429. There is no application-layer 429 to detect — Ormuz cannot read inside the tunnel.

### What CONNECT does *not* do

- No body inspection, no header inspection past the `CONNECT` line, no TLS termination.
- No `model`-mode bucket key (the model name lives inside the encrypted body). With `ORMUZ_BUCKET_KEY=model`, CONNECT traffic still uses `host:<host>`, so the two paths diverge — pick `host` mode if you want unified pacing.

## Rate Limiting Model

Each bucket key has a token bucket (`src/tokenBucket.ts`):

- `capacity = effectiveRpm` where `effectiveRpm = floor(ORMUZ_RPM * ORMUZ_SAFETY_FACTOR)` (`src/config.ts`)
- `refillPerSec = effectiveRpm / 60`
- each request costs 1 token (`src/tokenBucket.ts`)

A fresh bucket starts **full** (`src/tokenBucket.ts`), so the first burst can be as large as `effectiveRpm`. See the operational note about this below.

### Why token bucket

- Tolerates short bursts within the configured average rate.
- Easy to compute "wait until next token", which the scheduler uses for projected-wait checks.
- Minimal state, predictable for a single-process service.

## Queueing and Rejection Policy

Each bucket has a bounded FIFO queue (`src/queue.ts`):

- max depth: `ORMUZ_MAX_QUEUE_DEPTH`
- max projected wait: `ORMUZ_MAX_QUEUE_WAIT_MS`

`projectedWait = queue.projectedWaitMs(refillPerSec) + bucket.waitUntilNextTokenMs()` (`src/scheduler.ts`). If the queue is full or this wait would exceed the cap, the scheduler throws `QueueRejectedError` immediately. For HTTP this becomes a local `429` with `Retry-After` (`src/server.ts`); for CONNECT, `HTTP/1.1 429 Too Many Requests` on the raw socket (`src/server.ts`).

This bounds tail latency. The alternative — letting the queue grow without bound — turns the proxy into a latency amplifier under sustained overload.

## Upstream 429 Handling

When the upstream answers `429` and it is the first attempt (`src/proxy.ts`):

1. `forwardRequest` parses `Retry-After` (seconds or HTTP-date, `src/proxy.ts`) and returns `{ kind: "upstream_429", retryAfterMs }` instead of forwarding to the client.
2. The scheduler clamps the wait against `ORMUZ_MAX_RETRY_AFTER_MS` if set (`src/scheduler.ts`):

   ```ts
   const cappedRetryAfterMs = this.options.maxRetryAfterMs
     ? Math.min(result.retryAfterMs, this.options.maxRetryAfterMs)
     : result.retryAfterMs;
   ```

3. The bucket is paused until `Date.now() + cappedRetryAfterMs` (`src/scheduler.ts`, `src/tokenBucket.ts`). While paused, no new tokens become available for that key.
4. The same task is re-queued at the front with `attempt = 1` (`src/scheduler.ts`). On a second 429 the request is rejected (`src/scheduler.ts`).

`ORMUZ_MAX_RETRY_AFTER_MS` exists because the upstream gateway has been observed to send `Retry-After: 60` under contention, and freezing a heavily loaded bucket for 60 seconds destroys throughput for everyone sharing that key. With a clamp of, say, 5000 ms, the bucket pauses briefly, then resumes pacing — which usually drains the contention faster than honoring the full hint. The clamp only applies to the bucket pause; we still send the upstream's original `Retry-After` to clients on a final 429 because clients should respect the upstream signal.

## Bucket Key Strategies

`ORMUZ_BUCKET_KEY` selects how `deriveBucketKey` (`src/proxy.ts`) labels each request:

| Mode | Key shape | Notes |
|------|-----------|-------|
| `auth` (default) | `auth:<authorization-header-verbatim>` or `auth:anonymous` | Best fairness when many internal users share one Ormuz |
| `global` | `global` | One bucket for everything; simplest |
| `model` | `model:<body.model>` or `model:unknown` | Per-model pacing; requires JSON body |
| `host` | `host:<lowercased-upstream-hostname>` or `host:unknown` | Per-upstream pacing |

For `host` mode, the upstream hostname comes from the resolved route's `upstreamBaseUrl` (`src/server.ts`). Because the CONNECT path uses the same `host:<lowercased-host>` shape (`src/server.ts`), a CONNECT to `api.openai.com:443` and an HTTP request that resolves to `https://api.openai.com/...` share one bucket. This is the only mode where HTTP and CONNECT pace against each other — the others fall back to `host:<host>` for CONNECT regardless.

Pick `host` when you want a single budget per provider regardless of how clients reach it. Pick `auth` when you need per-caller fairness and clients only use HTTP.

## Header and Body Handling

For HTTP traffic (`src/proxy.ts`):

- Hop-by-hop headers (`connection`, `keep-alive`, `proxy-authenticate`, `proxy-authorization`, `te`, `trailer`, `transfer-encoding`, `upgrade`) are stripped on both directions.
- Internal routing headers (`x-ormuz-target`, `x-ormuz-provider`, `x-ormuz-route`) are not forwarded upstream.
- The inbound `host` header is dropped; `undici` sets the right one for the upstream URL.
- Caller `Authorization` is forwarded unchanged. Ormuz does not store keys.
- The body is buffered as a `Buffer` (`src/server.ts`) so the single retry on upstream 429 can replay byte-for-byte.
- The upstream response is streamed back via `reply.send(upstream.body)` (`src/proxy.ts`), so streaming completions work end to end.

For CONNECT, none of this applies — Ormuz pipes raw bytes after the `200`.

## Provider Target Configuration

Targets and routing are loaded from (highest to lowest precedence merged per-key, `src/config.ts`):

- `ORMUZ_PROVIDER_TARGETS` — JSON inline; either the legacy provider map or the structured `{ providers, routes }` form.
- `ORMUZ_PROVIDER_TARGETS_FILE` — explicit path; same shapes, plus a minimal YAML form for the legacy map.
- `config/provider-targets.json` — auto-loaded if neither env var is set and the file exists.

`config/provider-targets.json` in this repo points the three common providers (`openai`, `anthropic`, `gemini`) at their public API hostnames (`api.openai.com`, `api.anthropic.com`, `generativelanguage.googleapis.com`), with matching `routes.pathPrefixes` and `routes.headers` for header-based routing. Replace the targets with your own gateway URLs if you front the providers behind one. `collectAllowedHosts` collects every distinct hostname across all four sources, which is the set of CONNECT destinations the proxy will allow.

Routing rules:

- `routes.headers`: exact `header == value` matches (header names are lowercased on load, `src/config.ts`).
- `routes.pathPrefixes`: longest prefix wins; the matched prefix is stripped from the upstream path (`src/providerRouter.ts`).
- Provider-prefix fallback only applies if the first or second path segment matches a configured provider (`src/providerRouter.ts`).

## Hook Lifecycle

The HTTP path emits these via `HookRegistry` (`src/hooks.ts`):

- `onRequestReceived`
- `onProviderResolved`
- `onQueued`
- `onForwardStart`
- `onForwardResult`
- `onUpstream429`
- `onRequestCompleted`

Hook handlers run inside `safelyRun` (`src/hooks.ts`); thrown errors are swallowed so a buggy hook can't break the proxy path. CONNECT does not currently emit lifecycle hooks — this is a known gap.

## Observability

`/metrics` exposes Prometheus output (`src/metrics.ts`):

- `ormuz_queue_depth{key}` — current queued requests per bucket
- `ormuz_queue_wait_seconds{key}` — histogram of dequeue wait
- `ormuz_tokens_available{key}` — current token level per bucket
- `ormuz_requests_total{outcome}` — `forwarded` | `queued` | `client_429` | `upstream_429`
- `ormuz_upstream_status_total{code}` — count per upstream status code (also incremented as `200` for successful CONNECT establishments, `src/server.ts`)

Under `ORMUZ_BUCKET_KEY=host`, the `key` label looks like `host:api.openai.com`, which makes per-provider dashboards a one-line PromQL query (`sum by (key) (rate(ormuz_requests_total[1m]))` filtered to `key=~"host:.*"`). Under `auth`, `key` contains the raw `Authorization` header value — be careful where you ship those metrics.

Suggested alerts:

- sustained growth in `ormuz_queue_depth{key=...}` (the bucket is structurally undersized)
- spikes in `ormuz_requests_total{outcome="client_429"}` (local overload — clients should back off)
- spikes in `ormuz_requests_total{outcome="upstream_429"}` (gateway pressure or shared-key contention)
- `ormuz_upstream_status_total{code="502"}` rising for `host`-mode buckets that map to CONNECT (likely DNS or network problem to that provider)

## Operational Tuning

Start with:

- `ORMUZ_RPM`: the upstream RPM you have committed to.
- `ORMUZ_SAFETY_FACTOR=0.95`: small headroom under the announced limit.
- `ORMUZ_MAX_QUEUE_DEPTH=200`, `ORMUZ_MAX_QUEUE_WAIT_MS=60000`: reasonable defaults for chat-style workloads.
- `ORMUZ_MAX_RETRY_AFTER_MS`: leave unset until you see the upstream send long Retry-After values; then start with 5000–10000 ms.

Things to know before tuning:

- **The bucket starts full.** At `ORMUZ_RPM=1200`, a fresh bucket lets ~1000 requests through in under half a second before pacing kicks in. If your upstream cannot absorb that initial burst, lower `ORMUZ_SAFETY_FACTOR` or split traffic across more bucket keys (e.g. switch from `global` to `host` or `auth`).
- **Choosing `host` vs `auth`.** Use `host` when you want one shared budget per provider (good when one Ormuz fronts a small number of providers and many callers, and you want CONNECT to share with HTTP). Use `auth` when you want per-caller fairness and you control all clients. `model` is only useful when several models share an upstream and have different commercial limits.
- **`ORMUZ_MAX_RETRY_AFTER_MS`.** Set this when you've seen an upstream send `Retry-After: 60` under contention — letting Ormuz freeze a busy bucket for 60 s tanked throughput in our load tests. A clamp around 5–10 s usually recovers faster than honoring the full hint.

Iterate based on metrics:

- Queue empty, no 429s -> raise `ORMUZ_RPM` or `ORMUZ_SAFETY_FACTOR` modestly.
- Frequent local 429s (`outcome="client_429"`) -> raise queue bounds, lower client concurrency, or split into more bucket keys.
- Persistent upstream 429s -> lower effective RPM, narrow bucket keys (so noisy neighbors don't drag everyone), or set `ORMUZ_MAX_RETRY_AFTER_MS`.
- CONNECT clients seeing `403` -> the destination host is not in `collectAllowedHosts(config)`. Add it via `providerTargets`, `pathPrefixes`, or a `headers` rule (`src/server.ts`).
