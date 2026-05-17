# Ormuz

Ormuz is a lightweight Node.js/TypeScript proxy that sits in front of your LLM Gateway and smooths outbound traffic with:

- token-bucket rate control
- bounded FIFO queueing
- adaptive retry when upstream returns `429 Retry-After`
- Prometheus metrics for queue depth and rate pressure
- provider-based target routing via URL prefixes
- lifecycle hooks for extension and monitoring

## Why this exists

The gateway can reject bursts with `429` instead of queueing. Ormuz absorbs that pressure locally by pacing requests before they hit the gateway.

For a full internal walkthrough, see [docs/how-it-works.md](docs/how-it-works.md).

## Quickstart

### 1) Install dependencies

```bash
npm install
```

### 2) Configure environment

```bash
cp .env.example .env
```

Ormuz auto-loads default provider routing from `config/provider-targets.json`.

### 3) Start Ormuz

```bash
npm run dev
```

Ormuz starts on `http://localhost:8787` by default.

### CLI examples

```bash
npm run dev:cli -- --rpm 120 --provider-targets '{"openai":"https://api.openai.com","anthropic":"https://api.anthropic.com","gemini":"https://generativelanguage.googleapis.com"}'
```

```bash
npm run dev:cli -- --rpm 120 --provider-targets-file ./providers.json
```

## Run checks

```bash
npm run typecheck
npm run lint
npm test
```

## Configuration

| Variable | Description | Default |
| --- | --- | --- |
| `ORMUZ_PORT` | HTTP port for Ormuz | `8787` |
| `ORMUZ_UPSTREAM_BASE_URL` | Optional fallback base URL if no provider map | empty |
| `ORMUZ_PROVIDER_TARGETS` | JSON object map of provider -> upstream base URL | empty |
| `ORMUZ_PROVIDER_TARGETS_FILE` | Optional JSON/YAML file path for provider targets (overrides env map); default auto-load: `config/provider-targets.json` if present | empty |
| `ORMUZ_RPM` | Gateway requests per minute limit | `60` |
| `ORMUZ_SAFETY_FACTOR` | Headroom multiplier for RPM | `0.95` |
| `ORMUZ_BUCKET_KEY` | Bucket strategy: `auth`, `global`, `model` | `auth` |
| `ORMUZ_MAX_QUEUE_DEPTH` | Max queued requests per bucket | `200` |
| `ORMUZ_MAX_QUEUE_WAIT_MS` | Max projected wait before local reject | `60000` |
| `ORMUZ_LOG_LEVEL` | Fastify/Pino log level | `info` |

## Routing

- Proxy endpoint: `POST/GET/etc /v1/*`
- Health endpoint: `GET /health`
- Metrics endpoint: `GET /metrics`

## Provider URL format

Routing precedence:

1. Header exact-match rules (`routes.headers`)
2. Path-prefix rules (`routes.pathPrefixes`, longest prefix wins)
3. Legacy provider-prefix fallback (`/v1/openai/...`) and fallback upstream URL

Provider/prefix routing examples:

- `/v1/openai/chat/completions` -> provider `openai`, forwarded path `/v1/chat/completions`
- `/v1/anthropic/v1/messages` -> provider `anthropic`, forwarded path `/v1/messages`
- `/v1/gemini/v1beta/models/...` -> provider `gemini`, forwarded path `/v1beta/models/...`

If routing is configured and no route matches, Ormuz returns `400 unmatched_route`.

## Routing config file format

`config/provider-targets.json` supports:

```json
{
  "providers": {
    "openai": "https://api.openai.com"
  },
  "routes": {
    "pathPrefixes": {
      "/xxxx.com/xxxx": "https://api.openai.com"
    },
    "headers": [
      {
        "header": "x-ormuz-target",
        "value": "openai",
        "target": "https://api.openai.com"
      }
    ]
  }
}
```

## Curl example

```bash
curl -X POST "http://localhost:8787/v1/openai/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer REQUEST_PROVIDED_KEY" \
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{"role":"user","content":"hello"}]
  }'
```

## How queueing works

1. Request arrives and is mapped to a bucket key (`auth` by default).
2. If token available, request forwards immediately.
3. Otherwise request is queued in FIFO order.
4. If projected wait exceeds `ORMUZ_MAX_QUEUE_WAIT_MS`, Ormuz returns local `429`.
5. If upstream returns `429 Retry-After`, Ormuz pauses that bucket and retries once.

## Metrics

Exposed on `/metrics`:

- `ormuz_queue_depth{key}`
- `ormuz_queue_wait_seconds{key}`
- `ormuz_tokens_available{key}`
- `ormuz_requests_total{outcome="forwarded|queued|client_429|upstream_429"}`
- `ormuz_upstream_status_total{code}`

## Hooks

Ormuz includes lifecycle hooks in `src/hooks.ts` for extension points:

- `onRequestReceived`
- `onProviderResolved`
- `onQueued`
- `onForwardStart`
- `onForwardResult`
- `onUpstream429`
- `onRequestCompleted`

Hooks are non-blocking and failures are swallowed so request handling remains stable.

## Load Testing

Run a ramp-up load test with large repeated requests:

```bash
npm run load:test -- \
  --base-url=http://127.0.0.1:8787 \
  --route=/v1/openai/chat/completions \
  --header=x-ormuz-target=openai \
  --auth-token=$ORMUZ_UPSTREAM_KEY \
  --ramp=5x20,15x30,30x45 \
  --prompt-chars=12000 \
  --max-tokens=512 \
  --timeout-ms=60000 \
  --output=load-summary.json
```

The `--auth-token` value is forwarded verbatim to the upstream as `Authorization: Bearer …`, so it must be a credential the upstream in `config/provider-targets.json` accepts (not an OpenAI key when the upstream is your upstream gateway).

### Load test flags

- `--base-url` target Ormuz base URL
- `--route` path to hit repeatedly
- `--auth-token` optional bearer token
- `--header key=value` repeatable custom headers (useful for header-based routing)
- `--model` request model field (default `gpt-4o-mini`)
- `--prompt-chars` generated prompt size for large payloads
- `--max-tokens` completion cap
- `--ramp` CSV stages: `concurrency x durationSeconds` (e.g. `5x20,20x40`)
- `--timeout-ms` request timeout
- `--output` optional JSON summary path

The script prints live stats every second (RPS, latency p50/p95, status counts, 429 counts, in-flight) and then an end-of-run JSON summary.
