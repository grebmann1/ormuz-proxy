# Ormuz

[![CI](https://github.com/grebmann1/ormuz-proxy/actions/workflows/ci.yml/badge.svg)](https://github.com/grebmann1/ormuz-proxy/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Website:** https://ormuz-llm-gateway-bf4561e613c6.herokuapp.com/ — landing + rendered docs.

Ormuz is a **client-side LLM forward proxy**. It sits between your application code and the upstream LLM gateway, smoothing outbound traffic with:

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

```bash
npm install
npm run setup     # creates .env from .env.example if missing
npm run dev       # starts Ormuz on http://localhost:8787
```

Provider routing is auto-loaded from `config/provider-targets.json`. Override
defaults via `.env` (see `.env.example`) or CLI flags.

### CLI examples

```bash
npm run dev:cli -- --rpm 120 --provider-targets '{"openai":"https://api.openai.com","anthropic":"https://api.anthropic.com","gemini":"https://generativelanguage.googleapis.com"}'
```

```bash
npm run dev:cli -- --rpm 120 --provider-targets-file ./providers.json
```

## Install as a system-wide proxy (macOS)

Make Ormuz start at login and route LLM SDK traffic through it automatically:

```bash
npm install
npm run install:autostart
```

This:
1. Builds `dist/`.
2. Installs `~/Library/LaunchAgents/com.ormuz.proxy.plist` so launchd starts Ormuz at login (with `--rpm 30 --max-retry-after-ms 5000` by default; edit the plist to change).
3. Appends an env-var block to `~/.zshrc`:
   ```
   export OPENAI_BASE_URL=http://127.0.0.1:8787/v1/openai
   export ANTHROPIC_BASE_URL=http://127.0.0.1:8787/v1/anthropic
   export GEMINI_BASE_URL=http://127.0.0.1:8787/v1/gemini
   ```

Open a new shell (or `source ~/.zshrc`) and any tool that honors these env vars (Claude Code CLI, `openai`/`@anthropic-ai/sdk` SDKs, ad-hoc Python/Node scripts) will route through Ormuz.

Logs land at `~/Library/Logs/ormuz.{out,err}.log`.

To remove everything:

```bash
npm run uninstall:autostart
```

**Coverage caveat:** GUI apps (ChatGPT desktop, Claude desktop, Cursor, etc.) typically ignore env vars and hard-code the upstream URL — they won't be routed through Ormuz with this setup. To catch them too, also install the system proxy below.

## Catch GUI apps too: system proxy + PAC (macOS)

Adds host-level rate limiting for any client that respects the macOS system proxy (most browsers, Electron apps, many CLIs). Ormuz handles HTTPS via `CONNECT` tunneling — no TLS interception, no custom CA, no MITM.

```bash
npm run install:systemproxy
```

This:
1. Reads the hostnames from `config/provider-targets.json` (or `ORMUZ_PROVIDER_TARGETS_FILE`).
2. Generates `~/.config/ormuz/proxy.pac` that routes only those hosts through `127.0.0.1:8787` and sends everything else `DIRECT`.
3. Registers the PAC URL with every active macOS network service via `networksetup -setautoproxyurl`.

After this, any matching `https://<configured-host>/...` request from a system-proxy-aware client is tunneled through Ormuz and rate-limited per host. The bucket key is `host:<hostname>`, so HTTP and CONNECT traffic to the same upstream share a budget if you set `ORMUZ_BUCKET_KEY=host`.

To remove:

```bash
npm run uninstall:systemproxy
```

**Coverage caveats:**
- The PAC only routes hosts in your config — it doesn't break unrelated traffic.
- Cert-pinned apps and apps that ignore the system proxy still bypass Ormuz.
- Because Ormuz only sees `CONNECT host:port` (not the URL or body), tunnel-mode rate limiting is per-host only — model/path-level routing requires direct `/v1/<provider>/...` access.

## Inspect config without starting the server

```bash
npx ormuz --print-config    # JSON dump of the resolved config (.env + flags)
npx ormuz --print-hosts     # one allowed CONNECT host per line
```

Use these to confirm `.env`, `config/provider-targets.json`, and CLI flags merged the way you expected.

## Run checks

```bash
npm run verify     # lint + typecheck + tests (what CI runs)
```

Granular targets are also available: `npm run lint`, `npm run typecheck`, `npm test`, `npm run lint:fix`.

## Configuration

| Variable | Description | Default |
| --- | --- | --- |
| `ORMUZ_PORT` | HTTP port for Ormuz | `8787` |
| `ORMUZ_HOST` | Bind address. Defaults to loopback so the proxy is not exposed on the network — set `0.0.0.0` only when you intentionally want to share the proxy with other machines | `127.0.0.1` |
| `ORMUZ_UPSTREAM_BASE_URL` | Optional fallback base URL if no provider map | empty |
| `ORMUZ_PROVIDER_TARGETS` | JSON object map of provider -> upstream base URL | empty |
| `ORMUZ_PROVIDER_TARGETS_FILE` | Optional JSON/YAML file path for provider targets (overrides env map); default auto-load: `config/provider-targets.json` if present | empty |
| `ORMUZ_RPM` | Gateway requests per minute limit | `60` |
| `ORMUZ_SAFETY_FACTOR` | Headroom multiplier for RPM | `0.95` |
| `ORMUZ_BUCKET_KEY` | Bucket strategy: `auth`, `global`, `model`, `host`. In `auth` mode the bucket key is a hashed prefix of the `Authorization` header so raw tokens never appear in `/metrics`, logs, or hooks. | `auth` |
| `ORMUZ_MAX_QUEUE_DEPTH` | Max queued requests per bucket | `200` |
| `ORMUZ_MAX_QUEUE_WAIT_MS` | Max projected wait before local reject | `60000` |
| `ORMUZ_MAX_RETRY_AFTER_MS` | Cap how long the bucket pauses on upstream `429 Retry-After` (unset = honor upstream value verbatim) | empty |
| `ORMUZ_LOG_LEVEL` | Fastify/Pino log level | `info` |

## Routing

- Proxy endpoint: `POST/GET/etc /v1/*`
- Health endpoint: `GET /health` — returns `{ ok, version, uptimeSec }`
- Effective config (debug): `GET /config`
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

The `--auth-token` value is forwarded verbatim to the upstream as `Authorization: Bearer …`, so it must be a credential the upstream in `config/provider-targets.json` accepts (not an OpenAI key when the upstream is your own gateway).

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
