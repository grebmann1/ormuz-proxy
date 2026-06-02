# Architecture

This document is the structural map of Ormuz. If you spend fifteen minutes
here you should be able to open any source file and know roughly what role
it plays, what calls it, and why it exists. For the operational side of
how a single request moves through the system over time, see
[how-it-works.md](./how-it-works.md). For deployment and configuration
in a real environment, see [install.md](./install.md).

Ormuz is a small, opinionated outbound proxy. Its single job is to take
HTTP traffic destined for a small set of upstream LLM providers, hold
that traffic against a per-key token-bucket rate limit, and either
forward it or fail fast with a local 429. It is intentionally not a
general forward proxy.

## 1. Component map

The runtime is a single Node.js process built around one Fastify
instance. Fastify owns the listening socket; we hijack its underlying
`http.Server` to handle CONNECT tunnels alongside HTTP requests on the
same port. A single in-process `RequestScheduler` maintains one
`(TokenBucket, BoundedQueue)` pair per bucket key. Provider routing,
metrics, and lifecycle hooks are side concerns: they observe the request
path or react to it, but they don't sit on the critical path of
"is there a token? if not, wait."

```
                       +---------------------+
                       |       client        |
                       +----------+----------+
                                  |
                                  v
                  +-----------------------------+
                  |   Fastify app (server.ts)   |
                  |  - removes default parsers  |
                  |  - wildcard buffer parser   |
                  +-----+-----------------+-----+
                        |                 |
            HTTP /v1/*  |                 |  CONNECT host:port
                        v                 v
   +--------------------------+   +-----------------------------+
   | route resolution         |   | parseConnectTarget()        |
   | (providerRouter.ts)      |   | allowedConnectHosts check   |
   |  1. header rule          |   |  (collectAllowedHosts)      |
   |  2. path prefix          |   +--------------+--------------+
   |  3. provider prefix      |                  |
   +-------------+------------+                  |
                 |                               |
                 v                               v
         deriveBucketKey               bucketKey = host:<host>
         (proxy.ts)
                 |                               |
                 +---------------+---------------+
                                 |
                                 v
                    +------------------------+
                    |   RequestScheduler     |
                    |      (scheduler.ts)    |
                    |  per-key state:        |
                    |   TokenBucket + Queue  |
                    +-----+------------+-----+
                          |            |
            tryTake()     |            |  enqueue / drain
                          v            v
                  +-----------+   +---------------+
                  | TokenBucket|  | BoundedQueue  |
                  |  refill    |  | projectedWait |
                  +-----------+   +---------------+
                          |
                          v
                +---------------------+
                |  forwardRequest     |       (HTTP path)
                |  (proxy.ts)         |  --->  upstream via undici
                +---------------------+
                          |
                          v
                  upstream provider
                                                 (CONNECT path)
                  net.connect(host, port) ----->  raw TLS tunnel
                                                  (no termination)

  side concerns:
    metrics.ts   <-- scheduler hooks + recordUpstreamStatus / recordForwarded
    hooks.ts     <-- HookRegistry, fan-out for embedders
    config.ts    <-- env + provider-targets file -> AppConfig (loaded once)
```

The call graph for a normal HTTP request is roughly:

```
buildApp -> request handler -> resolveConfiguredRoute / resolveProviderRoute
        -> deriveBucketKey -> scheduler.submit
        -> (queue & token bucket loop) -> forwardRequest -> reply
```

For CONNECT it is:

```
http.Server "connect" event -> parseConnectTarget -> allowlist check
        -> scheduler.submit("host:<host>") -> net.connect -> tunnelSockets
```

## 2. Two request paths

Both paths go through the same scheduler, but they differ in where the
bucket key comes from and what "forward" means. Each diagram below shows
one request, with the key entry-point symbols labelled.

### 2.1 HTTP `POST /v1/openai/chat/completions`

```
client                Fastify app           providerRouter         scheduler           upstream
  |  POST request          |                       |                  |                  |
  |----------------------->|                       |                  |                  |
  |  (body buffered as     | wildcard "*" parser   |                  |                  |
  |   raw Buffer via       |                       |                  |                  |
  |   wildcard parser)     |                       |                  |                  |
  |                        | resolveConfigured     |                  |                  |
  |                        |   /ProviderRoute      |                  |                  |
  |                        |---------------------->|                  |                  |
  |                        |  app.all("/v1/*")     | providerRouter   |                  |
  |                        |<----------------------| .ts              |                  |
  |                        |                       |                  |                  |
  |                        | deriveBucketKey       |                  |                  |
  |                        |  (proxy.ts)           |                  |                  |
  |                        |                       |                  |                  |
  |                        | scheduler.submit(key,task) ------------->|                  |
  |                        |  (server.ts handler)                     | scheduler.submit |
  |                        |                                          | (sync admission) |
  |                        |                                          |  enqueue + drain |
  |                        |                                          |                  |
  |                        |                                          | forwardRequest ->|
  |                        |                                          | (proxy.ts)       |
  |                        |                                          |                  |
  |                        |                                          |  upstream reply  |
  |                        |                                          |<-----------------|
  |                        |                                          |                  |
  |                        | reply.code/.send (proxy.ts)              |                  |
  |  response              |<-----------------------------------------|                  |
  |<-----------------------|                                          |                  |
```

If admission fails, `scheduler.submit` throws `QueueRejectedError`
synchronously. The handler catches it and replies `429` with
`Retry-After` and `retryAfterMs` (see the `QueueRejectedError` branch
in `server.ts`).

### 2.2 `CONNECT api.openai.com:443`

```
client                http.Server          server.ts          scheduler         net (TCP)
  |  CONNECT host:port      |                  |                  |                  |
  |------------------------>|                  |                  |                  |
  |                         | "connect" event  |                  |                  |
  |                         | (onListen hook)  |                  |                  |
  |                         |----------------->|                  |                  |
  |                         |                  | parseConnectTarget                  |
  |                         |                  | (server.ts)      |                  |
  |                         |                  | allowlist check  |                  |
  |                         |                  | (allowedConnect  |                  |
  |                         |                  |   Hosts)         |                  |
  |                         |                  | bucketKey =      |                  |
  |                         |                  | "host:<host>"    |                  |
  |                         |                  | scheduler.submit |                  |
  |                         |                  |----------------->|                  |
  |                         |                  |                  | (admission ok)   |
  |                         |                  |                  | task: net.connect|
  |                         |                  |                  |----------------->|
  |                         |                  |                  |     "connect"    |
  |                         |                  |                  |<-----------------|
  |  HTTP/1.1 200 Conn est. |                  |                  |                  |
  |<------------------------|<-----------------|  (handleConnect) |                  |
  |                         |                  |                  |                  |
  |  raw TLS bytes both ways (tunnelSockets, server.ts)           |                  |
  |<==============================================================================>|
```

If the host is not allowlisted, the response is
`HTTP/1.1 403 Forbidden`. If admission fails, it is
`HTTP/1.1 429 Too Many Requests` with `Retry-After`. Both paths live
in `handleConnect` in `server.ts`. No TLS termination ever happens
here; see section 9 for the rationale.

## 3. Rate limiting design

The rate limiter is a per-bucket token bucket with a FIFO queue in
front of it. Both pieces are deliberately small.

### 3.1 Token bucket math

`TokenBucket` (`tokenBucket.ts`) keeps a floating-point token count and
a `lastRefillMs` timestamp. Every `tryTake()` calls `refill(nowMs)`,
which adds `(nowMs - lastRefillMs) / 1000 * refillPerSec` tokens up to
`capacity`, then deducts one if at least one is available. If not, it
returns the number of milliseconds the caller must wait for the next
whole token.

The bucket's capacity is set to `effectiveRpm` (passed as
`bucketCapacity` when the `RequestScheduler` is constructed in
`buildApp`). This is
intentional: it gives each bucket a full minute of burst credit on
startup or after a period of idleness. It is also the most surprising
piece of behavior to operators. In load testing at `RPM=1200`, roughly
1000 requests went through in the first ~480 ms because the bucket
started full; pacing only began after the burst credit was drained.
This is by design — clients with a real per-minute budget should be
allowed to spend it however they like — but it means short-window
throughput will exceed the configured RPM, and dashboards that average
over a minute should be preferred over second-level views.

Once tokens are exhausted, the rate is purely `refillPerSec`, which
`loadConfig` derives as `effectiveRpm / 60`.

### 3.2 FIFO admission predicate

The queue is the load-shedding instrument. `BoundedQueue.projectedWaitMs`
(`queue.ts`) divides the current depth by `refillPerSec` to estimate
how long a newly enqueued item would wait. The scheduler adds the
bucket's own `waitUntilNextTokenMs()` to that:

```
projectedWaitMs = queue.projectedWaitMs(refillPerSec)
                + bucket.waitUntilNextTokenMs()
```

This expression is checked **synchronously** inside
`RequestScheduler.submit` (`scheduler.ts`) before the request is
enqueued. If the queue is full or the projected wait exceeds
`maxQueueWaitMs`, `submit` throws
`QueueRejectedError` immediately. That synchronous behavior is what
gives Ormuz its fast-fail property: the caller does not have to wait
in line to find out the line is too long. The HTTP and CONNECT
handlers both rely on this — they catch `QueueRejectedError` and
translate it into `429 Retry-After` without ever queuing the work.

### 3.3 Drain loop and retry path

After enqueue, `submit` calls the private `schedule(bucketKey, state)`
loop in `scheduler.ts`. The drain loop tries to take a token; on
success it dequeues the head and runs it. On token exhaustion it sets
a single `setTimeout` for the wait time and returns; the timer
re-enters `schedule` later. There is exactly one drain loop active per
bucket because of the `state.draining` guard.

If the upstream returns 429, the task returns
`{ kind: "upstream_429", retryAfterMs }`. The `executeItem` branch
(`scheduler.ts`) then:

1. Optionally clamps the wait to `maxRetryAfterMs`. This option exists
   because a hostile or buggy upstream sending `Retry-After: 60` would
   otherwise freeze the bucket for a full minute. In practice
   operators set this to something like 5–10 seconds and rely on
   natural retries.
2. Calls `bucket.pauseUntil(Date.now() + cappedRetryAfterMs)`, which
   zeroes tokens and refuses to refill until the deadline (see
   `pauseUntil` / `refill` in `tokenBucket.ts`).
3. If this is the first attempt, re-queues the item at the **front**
   of the queue (`enqueueFront`) so it does not lose its place. On a
   second 429, it gives up and rejects with a plain Error.

There is exactly one retry. No exponential backoff, no random jitter:
the design assumes the upstream's `Retry-After` is the source of truth
about when to try again, and that the bucket pause prevents any other
work from racing through during that window.

## 4. Bucket key strategies

The bucket key is what determines isolation: every request with the
same key shares one `(TokenBucket, BoundedQueue)` pair. There are four
modes, computed in `deriveBucketKey` (`proxy.ts`):

- `auth` (default) — keys on a SHA-256 hash prefix of the
  `Authorization` header value, falling back to `auth:anonymous` when
  absent. The hash keeps raw tokens out of `/metrics` labels, log
  lines, and hook payloads while still giving each tenant their own
  bucket. This is the right choice when the proxy fronts a
  multi-tenant upstream and each tenant has their own RPM allowance.
- `global` — one bucket for the entire process. Useful when the proxy
  is a single client of a single upstream and the whole RPM budget is
  pooled.
- `model` — keys on the `model` field of a parsed JSON body. Falls
  back to `model:unknown` when the body is not JSON or has no `model`
  key. Useful when each model has its own RPM budget upstream.
- `host` — keys on the resolved upstream hostname
  (lower-cased). This mode is the only one that **shares budgets
  between HTTP and CONNECT** to the same upstream, because the CONNECT
  handler always uses `host:<target.host>` regardless of mode (see
  `handleConnect` in `server.ts`). If you intend to mix CONNECT and
  HTTP traffic against the same provider and want them throttled
  together, use `host`.

## 5. Routing resolution

For HTTP requests, three strategies decide where the request goes and
what path is sent upstream. Their precedence is fixed in
`resolveConfiguredRoute` (`providerRouter.ts`):

1. **Header rule** — the first rule in `routingRules.headers` whose
   header value matches wins (see `resolveByHeader`). The rewritten
   path is the original path, untouched, except for the subtlety
   described below.
2. **Path prefix** — the longest matching prefix in
   `routingRules.pathPrefixes` wins. The matched prefix is stripped
   from the path (see `resolveByPathPrefix`).
3. **Provider prefix (legacy)** — used only if `resolveConfiguredRoute`
   returns nothing. Looks for a known provider name as the first or
   second path segment, removes that segment, and forwards the rest
   (`resolveProviderRoute` in `providerRouter.ts`). This exists for
   backward compatibility with the original `--target=openai` style of
   configuration; it is automatically materialized by `loadConfig`
   from a flat provider→target map.

### 5.1 The header-plus-path-prefix subtlety

`resolveConfiguredRoute` has a small but load-bearing block:

```ts
const byHeader = resolveByHeader(headers, rules.headers, path);
if (byHeader) {
  const byPrefix = resolveByPathPrefix(path, rules.pathPrefixes);
  if (byPrefix && byPrefix.upstreamBaseUrl === byHeader.upstreamBaseUrl) {
    return { ...byHeader, rewrittenPath: byPrefix.rewrittenPath };
  }
  return byHeader;
}
```

The header strategy by itself does not strip path prefixes. That used
to cause a real bug: a client running with both
`x-ormuz-target=openai` (header rule) and `/v1/openai` (path prefix)
configured against the same upstream would send the unstripped path
`/v1/openai/chat/completions` upstream, where the API expects
`/chat/completions`. The fix is exactly what the block does: when the
header rule and a path-prefix rule agree on the upstream, prefer the
header rule's targeting but borrow the path-prefix rule's path
rewriting. When they disagree, the header rule wins as-is, on the
assumption that the operator deliberately chose two different routes.

## 6. CONNECT allowlist

CONNECT is the only path in Ormuz that can produce arbitrary outbound
connections, so it has its own gate. `collectAllowedHosts(config)`
(`server.ts`) builds a `Set<string>` of hostnames from four sources,
in order:

1. `config.upstreamBaseUrl` — the fallback upstream, if configured.
2. Every value in `config.providerTargets` — the legacy provider map.
3. Every value in `config.routingRules.pathPrefixes` — the modern
   path-prefix routing table.
4. Every `target` in `config.routingRules.headers` — header rules.

Each URL is parsed with `safeHostname`, lower-cased, and added; bad
URLs are silently skipped. The CONNECT handler (`handleConnect` in
`server.ts`) then checks two things in order: the request must parse
to a `(host, port)` pair, and the host must be in the allowlist. If
the allowlist is empty (no routing of any kind is
configured), every CONNECT returns `403 Forbidden`. This is
intentional: an unconfigured Ormuz is a closed door. Ormuz is not
trying to be a general-purpose forward proxy — it is a guardrail in
front of a known set of LLM providers, and the empty-set behavior
keeps misconfiguration from accidentally turning it into an open
relay.

There is no per-host budgeting beyond this; once admitted, a CONNECT
goes through the same scheduler as everyone else, with bucket key
`host:<target.host>`.

## 7. Configuration loading

`loadConfig(env)` (`config.ts`) is called once at startup inside
`startServer`. The flow:

1. **Zod parse the env vars.** The schema covers port, host, fallback
   upstream URL, RPM, safety factor, bucket key mode, queue depth/wait,
   retry-after cap, and log level. Any bad value throws and the
   process fails to start.
2. **Compute `effectiveRpm`**:

   ```ts
   const effectiveRpm = Math.max(1, Math.floor(parsed.ORMUZ_RPM * parsed.ORMUZ_SAFETY_FACTOR));
   ```

   This single number is both the bucket capacity and (divided by 60)
   the refill rate. The safety factor (default 0.95) gives a small
   margin under the published upstream RPM, so a clock-skew between
   client and upstream does not cause spurious upstream 429s.
3. **Load provider targets** through `loadProviderTargets`
   (`config.ts`). Three sources are merged, with file values
   overriding env values:
   - The `ORMUZ_PROVIDER_TARGETS` env var (raw JSON or YAML-ish text).
   - The file at `ORMUZ_PROVIDER_TARGETS_FILE`, if set.
   - As an auto-load fallback, `config/provider-targets.json` in the
     current working directory, but only when neither of the above is
     set.
4. **Choose a parse mode** (`parseProviderTargetsValue`). If the JSON
   has a `providers` or `routes` top-level key, it's the structured
   format (validated by `providerRoutingConfigSchema`). Otherwise it
   is treated as the legacy flat `provider → URL` map; in that case
   path-prefix rules are auto-generated as `/v1/<provider> -> <url>`.
   `.yaml`/`.yml` files always go through the legacy parser via
   `parseYamlLikeObject`.

The returned `AppConfig` is read-only after this point. There is no
hot reload.

## 8. Observability surface

All metrics are Prometheus-format and exposed at `GET /metrics`. Default
Node.js process metrics are registered via `collectDefaultMetrics` (see
`metrics.ts`). The Ormuz-specific metrics are:

| Name                          | Type      | Labels   | Updated by                                  |
|-------------------------------|-----------|----------|---------------------------------------------|
| `ormuz_queue_depth`           | Gauge     | `key`    | scheduler `onQueued`, `onDequeued`          |
| `ormuz_queue_wait_seconds`    | Histogram | `key`    | scheduler `onDequeued` (wait at dequeue)    |
| `ormuz_tokens_available`      | Gauge     | `key`    | scheduler `onTokensAvailable` (every drain) |
| `ormuz_requests_total`        | Counter   | `outcome`| scheduler hooks + `recordForwarded`         |
| `ormuz_upstream_status_total` | Counter   | `code`   | `recordUpstreamStatus` per upstream reply   |

The `outcome` label takes the values `queued`, `client_429`,
`upstream_429`, and `forwarded`. `client_429` counts admission
rejections from the local queue, while `upstream_429` counts when the
upstream itself returned 429.

For consumers who want richer telemetry than counters allow — for
example, per-request structured events, custom tracing, or a side
channel into another monitoring system — there is a parallel
extension surface in `hooks.ts`. `HookRegistry` wraps an `OrmuzHooks`
object and fans out the same lifecycle events the metrics see
(`onRequestReceived`, `onProviderResolved`, `onQueued`,
`onForwardStart`, `onForwardResult`, `onUpstream429`,
`onRequestCompleted`). Every hook is called inside a `try/catch` that
swallows errors; a misbehaving hook cannot take down the proxy path.
Hooks receive a `RequestLifecyclePayload` with the request id, method,
path, bucket key, provider, route strategy, status code, duration,
and so on. Embedders pass the hooks object to
`buildApp(config, hooks)`.

## 9. Design decisions and rationale

Several non-obvious choices shaped the code. They are recorded here
together so future work can revisit them deliberately.

- **Fastify as the host framework.** Fastify gives us request
  logging, an `IncomingMessage`-based request model, content-type
  parser machinery, and direct access to the underlying
  `http.Server` instance — all of which we use. We hijack
  `app.server.on("connect", ...)` (inside the `onListen` hook in
  `server.ts`) precisely because Fastify exposes the raw server. A
  more abstract framework would have made the CONNECT path harder to
  wire in cleanly.

- **Wildcard buffer body parser.** The first thing `buildApp` does
  after constructing Fastify is `app.removeAllContentTypeParsers()`
  followed by adding a `*` parser that returns the raw `Buffer`.
  Without this, Fastify's built-in JSON parser would consume
  `application/json` request bodies, leaving us with a parsed object
  and no way to forward the original bytes; that mismatch caused
  upstream 400s in early testing. We still optionally re-parse the
  body for `model`-mode bucket keying via `parseBodyForBucket`, but
  only as JSON-or-nothing, so a non-JSON or malformed body is just
  treated as having no model.

- **Single in-process scheduler.** There is no Redis, no shared
  queue, no horizontal coordination. Ormuz is meant to run as a
  sidecar or single replica next to the workload it is throttling.
  When you scale the workload horizontally, you scale Ormuz with it
  and accept that each replica has its own budget. This is fine for
  the design point — small to medium internal LLM gateways — and it
  keeps the failure modes limited to a single Node process.

- **No automatic upstream-token injection.** `ORMUZ_UPSTREAM_TOKEN`
  exists in the env schema and is parsed into
  `AppConfig.upstreamToken`, but `forwardRequest` does not consult
  it. The proxy forwards whatever `Authorization` the client supplies,
  minus hop-by-hop headers (see `buildUpstreamHeaders` in `proxy.ts`).
  This is deliberate: the proxy never holds a privileged credential
  on behalf of the caller, which keeps the trust boundary clean and
  makes per-tenant `auth`-mode bucket keying meaningful. The field is
  left in place for embedders that want to write a hook that injects
  it.

- **CONNECT does not terminate TLS.** The CONNECT handler opens a
  raw TCP socket to the upstream and pipes bytes both ways (see
  `tunnelSockets` and `handleConnect` in `server.ts`). It never
  decrypts the
  payload. This means we cannot inspect or rate-limit traffic by
  body (model, prompt size, etc.) for CONNECT flows — they are
  opaque past the host header — but it also means we don't need a
  custom CA, don't take on key custody, and can't accidentally log
  request bodies for those flows. The trade-off is that
  `bucketKeyMode=model` is effectively meaningless for CONNECT
  traffic; operators mixing transport types should use `host` or
  `auth`.
