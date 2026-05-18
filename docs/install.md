# Installing Ormuz

Ormuz has two layers of routing for getting traffic onto the proxy. You can pick one, or run both — both are reversible, both are macOS-only as shipped, and they catch different sets of clients. This document is the canonical install reference; `README.md` has a shorter quick start.

| Layer | Routes | Doesn't catch | Time | Risk |
| --- | --- | --- | --- | --- |
| Autostart (Option A) | CLIs/SDKs that honor `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL` / `GEMINI_BASE_URL` (Claude Code, `openai`, `@anthropic-ai/sdk`, ad-hoc scripts) | GUI/Electron apps that hard-code the upstream URL | ~30 s after `npm install` | Low: writes one plist + one `~/.zshrc` block, both labelled and reversible |
| System proxy (Option C) | System-proxy-aware clients (browsers, many Electron apps, `curl`/`wget` if PAC-aware) for hosts in `config/provider-targets.json` only | Cert-pinned apps, apps that ignore system proxy | ~5 s | Medium: flips macOS auto-proxy on every active network service; restoration is one command |

For background on what Ormuz actually does with the traffic once it arrives, see [docs/how-it-works.md](how-it-works.md). For component-level layout, see [docs/architecture.md](architecture.md).

## Prerequisites

- macOS (both install scripts call `launchctl` / `networksetup` and bail on non-Darwin).
- Node `>=20` on `PATH`. The autostart script captures the absolute path of `node` at install time and bakes it into the LaunchAgent plist; if your `node` lives behind Volta/`nvm`/`asdf` shims, see the failure modes below.
- A clone of the repo with `npm install` already run.

## Option A — Autostart (LaunchAgent + zshrc env vars)

### What it does

`scripts/install-autostart.sh` does three things:

1. Runs `npm run build` and verifies that `dist/src/cli.js` exists.
2. Renders `scripts/com.ormuz.proxy.plist.template` to `~/Library/LaunchAgents/com.ormuz.proxy.plist`, then `launchctl bootstrap`s it. The plist runs `node dist/src/cli.js --yes --rpm 30 --max-retry-after-ms 5000` with `KeepAlive=true` and `RunAtLoad=true`, so Ormuz comes back automatically on crash and at next login.
3. Appends a sentinel-bracketed block to `~/.zshrc` exporting three SDK base URLs to `http://127.0.0.1:8787/v1/{openai,anthropic,gemini}`. The block is idempotent — re-running the script does not duplicate it.

### Run it

```bash
npm install
npm run install:autostart
```

If `node` is not on `PATH` (or it points to a shim that won't resolve under launchd's environment), pass it explicitly:

```bash
NODE_BIN=/opt/homebrew/bin/node npm run install:autostart
```

### What gets created on disk

| Path | Owner | Purpose |
| --- | --- | --- |
| `~/Library/LaunchAgents/com.ormuz.proxy.plist` | install-autostart.sh | LaunchAgent definition (rendered from `scripts/com.ormuz.proxy.plist.template`) |
| `~/Library/Logs/ormuz.out.log` | launchd | stdout from the running proxy |
| `~/Library/Logs/ormuz.err.log` | launchd | stderr from the running proxy |
| Block in `~/.zshrc` between `# >>> ormuz autostart >>>` and `# <<< ormuz autostart <<<` | install-autostart.sh | Exports `OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`, `GEMINI_BASE_URL` |
| `dist/` inside the repo | `npm run build` | Compiled JS the LaunchAgent runs |

The plist itself bakes in the absolute paths to `node` and the repo (see `scripts/com.ormuz.proxy.plist.template:10-21`). If you move the repo, re-run `npm run install:autostart`.

### Verify

```bash
launchctl list | grep ormuz
lsof -i :8787
curl -sS http://127.0.0.1:8787/health
```

In a fresh terminal (the env vars are in `~/.zshrc`, so they only land in new shells):

```bash
echo $ANTHROPIC_BASE_URL   # http://127.0.0.1:8787/v1/anthropic
echo $OPENAI_BASE_URL      # http://127.0.0.1:8787/v1/openai
echo $GEMINI_BASE_URL      # http://127.0.0.1:8787/v1/gemini
```

### Logs

```bash
tail -f ~/Library/Logs/ormuz.out.log ~/Library/Logs/ormuz.err.log
```

If Ormuz fails to start, the failure almost always lands in `ormuz.err.log` (Node startup errors, missing module, port-in-use). The install script also waits up to 10 seconds for `/health` to come up and prints a warning if it doesn't.

### Common failure modes

- **launchd can't find Node (Volta/nvm/asdf).** The `command -v node` lookup at install time may resolve to a shim that doesn't work under launchd's stripped PATH. Symptom: agent loads but `lsof -i :8787` is empty and `ormuz.err.log` shows `node: command not found` or a missing-binary error. Fix: re-run with `NODE_BIN=$(volta which node)` or the absolute path your version manager uses.
- **Port 8787 already taken.** Symptom: `ormuz.err.log` shows `EADDRINUSE`. Find the offender with `lsof -i :8787`. Either stop it, or change the port (you'll need to edit the plist `--port` flag and re-bootstrap, plus update the `*_BASE_URL` env vars in `~/.zshrc` and the PAC if you also installed Option C).
- **Build fails.** Install aborts before touching launchd or `~/.zshrc`. Run `npm run build` directly to see the TypeScript output.
- **`dist/src/cli.js` missing after build.** The script aborts with that exact message (`scripts/install-autostart.sh:35-38`). Almost always means `tsconfig.json` was changed and emit moved; fix the build before retrying.
- **New shell still doesn't see env vars.** The block lives in `~/.zshrc`, so non-zsh shells, terminal multiplexers that don't re-read rc, and IDE-spawned shells may miss it. Either `source ~/.zshrc` in the running shell or add the three exports to whatever your shell actually reads.

### Uninstall

```bash
npm run uninstall:autostart
```

This stops the LaunchAgent (`launchctl bootout`), removes the plist, and strips the sentinel block from `~/.zshrc`. It does **not** remove `~/Library/Logs/ormuz.{out,err}.log` or the compiled `dist/` directory in the repo. If a process has already cached the env vars in memory, run `unset OPENAI_BASE_URL ANTHROPIC_BASE_URL GEMINI_BASE_URL` to clear them in the current shell.

## Option C — System proxy (PAC + networksetup)

### What it does

`scripts/install-systemproxy.sh`:

1. Reads `config/provider-targets.json` (or `ORMUZ_PROVIDER_TARGETS_FILE` if set) and extracts every hostname referenced in `providers`, `routes.pathPrefixes`, and `routes.headers[].target` (`scripts/install-systemproxy.sh:27-39`).
2. Renders `scripts/ormuz.pac.template` into `~/.config/ormuz/proxy.pac`, emitting one `host == "X" || dnsDomainIs(host, ".X")` rule per extracted hostname. Everything else returns `DIRECT`.
3. Calls `networksetup -setautoproxyurl <service> file://~/.config/ormuz/proxy.pac` and `-setautoproxystate <service> on` for every active network service (Wi-Fi, Ethernet, etc., excluding disabled ones marked with `*`).

Because matched HTTPS traffic arrives on Ormuz as `CONNECT host:443`, Ormuz tunnels it byte-for-byte without TLS interception. There is no custom CA, no MITM, and no model/path-level routing for tunneled traffic — only per-host rate limiting (and only if you enable host-keyed buckets; see Section 3).

### Run it

```bash
npm run install:systemproxy
```

To use a non-default targets file:

```bash
ORMUZ_PROVIDER_TARGETS_FILE=/path/to/my-targets.json npm run install:systemproxy
```

To use a non-default port (must match Ormuz's actual listen port):

```bash
ORMUZ_PORT=9000 npm run install:systemproxy
```

### What gets created on disk

| Path | Purpose |
| --- | --- |
| `~/.config/ormuz/proxy.pac` | Generated PAC, one rule per host extracted from the targets file |
| macOS network service auto-proxy state | Each active service (output of `networksetup -listallnetworkservices` minus disabled `*`-prefixed entries) gets its auto-proxy URL set and enabled |

### How rules are derived

The script feeds the targets file through Node and pulls hostnames out of every URL it finds:

- All values in `cfg.providers`
- All values in `cfg.routes.pathPrefixes`
- Every `target` in `cfg.routes.headers[]`

Hostnames are lowercased, deduplicated, and sorted. Each becomes two PAC clauses — exact match and `dnsDomainIs` for subdomains — both routed to `PROXY 127.0.0.1:<PORT>`. If no hostnames are extracted, the script aborts (`scripts/install-systemproxy.sh:41-44`).

### Verify

GUI:

```
System Settings -> Network -> <your service> -> Details... -> Proxies -> Automatic Proxy Configuration
```

CLI (substitute the service name shown by `networksetup -listallnetworkservices`):

```bash
networksetup -getautoproxyurl Wi-Fi
```

Test that a configured host actually proxies:

```bash
curl -sv https://<one-of-your-configured-hosts>/  2>&1 | grep -i 'connect\|proxy\|ormuz'
```

You should see Ormuz in the connect path. Hosts not in the PAC return `DIRECT` and bypass Ormuz entirely.

### What gets covered

- Browsers (Safari, Chrome, Firefox if "use system proxy" is on).
- Most Electron apps that defer to the OS for network config.
- CLIs that read `https_proxy` from system proxy auto-detection (a moving target — test, don't assume).

### What does NOT

- Apps with hard-coded upstream URLs that ignore the system proxy.
- Cert-pinned apps — they'll still TLS-handshake directly with the upstream and bypass.
- Anything resolved before PAC is consulted (rare, but VPN split-tunnels can do this).

### Common failure modes

- **No hostnames extracted.** The script aborts. Check that `config/provider-targets.json` parses as JSON and has at least one URL in `providers`, `routes.pathPrefixes`, or `routes.headers[].target`.
- **PAC didn't update in an app.** macOS and many apps cache PAC results until restart. Quit and relaunch the app.
- **Multiple network services and only some work.** The script touches every active service, but if you connect to a new VPN or interface afterwards, you need to re-run it (or set the PAC manually for the new service).
- **Captive portal / hotel Wi-Fi.** PAC routing only kicks in for matched hosts, so captive portals usually still work — but if Ormuz isn't running, every matched request will fail. Disable Option C while traveling, or run `npm run uninstall:systemproxy` and re-install on return.
- **Ormuz isn't running.** The PAC routes to `127.0.0.1:8787`; if nothing is listening, every matched request errors out with a connection-refused at the client. Either install Option A too, or start Ormuz manually with `npm run dev`.

### Uninstall

```bash
npm run uninstall:systemproxy
```

This sets `-setautoproxystate <service> off` for every active service and deletes `~/.config/ormuz/proxy.pac`. It does **not** clear cached PAC results from already-running apps; restart them. It also does not remove `~/.config/ormuz/` if you've put other files there.

## Combining A and C

The two layers compose well. Option A catches anything that respects `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL` / `GEMINI_BASE_URL` (those requests arrive at Ormuz as plain HTTP `/v1/<provider>/...`). Option C catches anything that respects the system proxy (those arrive as HTTPS `CONNECT host:port` tunnels). Different request shapes; same proxy.

The catch: by default Ormuz uses `ORMUZ_BUCKET_KEY=auth`, which keys buckets by the caller's `Authorization` header. That works for HTTP, but `CONNECT` tunnels don't expose `Authorization` to the proxy, so tunneled traffic falls into a different bucket from HTTP traffic to the same upstream. To share a budget per upstream host across both paths, use the `host` bucket mode:

```bash
# Edit ~/Library/LaunchAgents/com.ormuz.proxy.plist and add to ProgramArguments:
#   <string>--bucket-key</string>
#   <string>host</string>
# Then reload:
launchctl bootout "gui/$(id -u)/com.ormuz.proxy"
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.ormuz.proxy.plist
```

The four valid values are `auth`, `global`, `model`, `host` (see `src/config.ts:5`). The README's config table doesn't list `host` — `host` is the right choice when running A and C together.

GUI apps that pin certificates still bypass everything, regardless of A, C, or both. There is no fix without TLS interception, and Ormuz deliberately avoids that.

## Configuration knobs (install-time tuning)

These are the env vars worth thinking about when installing system-wide. The full list lives in `README.md`'s configuration table; this section is a focused subset for install-context tuning.

| Variable | Why it matters at install time |
| --- | --- |
| `ORMUZ_PORT` | Default `8787`. Must match the port baked into the LaunchAgent and the PAC. Change in three places (plist arg, `~/.zshrc` exports, regenerate PAC) or pick a free port up front. |
| `ORMUZ_RPM` | Default `60`; the LaunchAgent overrides to `30` (`scripts/com.ormuz.proxy.plist.template:13-14`). Set this to your gateway's actual sustained limit, then back off another 5-10% for safety. |
| `ORMUZ_SAFETY_FACTOR` | Default `0.95`. Drop to ~`0.8` if you observe frequent upstream `429`s; raise toward `1.0` if you have headroom. |
| `ORMUZ_BUCKET_KEY` | Default `auth`. Use `host` when running A + C together so HTTP and CONNECT to the same upstream share a budget. |
| `ORMUZ_MAX_QUEUE_DEPTH` | Default `200`. Raise for bursty workloads where you'd rather wait than get a local `429`; lower if memory is tight. |
| `ORMUZ_MAX_QUEUE_WAIT_MS` | Default `60000`. The cap on how long Ormuz will hold a request before short-circuiting with local `429`. Tune to your client's own timeouts so you fail fast rather than stranding a connection. |
| `ORMUZ_MAX_RETRY_AFTER_MS` | Unset by default; the LaunchAgent caps at `5000` ms. Lower if upstream returns large `Retry-After` values that lock the bucket too long. |
| `ORMUZ_LOG_LEVEL` | Default `info`. Set to `debug` only briefly when diagnosing — verbose logs grow fast under load. |

Set these via the `EnvironmentVariables` dict in the LaunchAgent plist (`scripts/com.ormuz.proxy.plist.template:22-26`), or as CLI flags in `ProgramArguments`. The plist accepts both.

## Uninstalling

Run whichever layer(s) you installed:

```bash
npm run uninstall:autostart
npm run uninstall:systemproxy
```

What gets removed:

- Autostart: LaunchAgent, plist file, sentinel block in `~/.zshrc`.
- System proxy: PAC file at `~/.config/ormuz/proxy.pac`, auto-proxy turned off on every active network service.

What does **not** get removed automatically:

- `~/Library/Logs/ormuz.{out,err}.log` — keep them, or `rm` manually.
- Compiled `dist/` in the repo — `git clean -fd` if you want it gone.
- Cached PAC results inside already-running apps — restart the app.
- Cached env vars inside already-running shells — `unset OPENAI_BASE_URL ANTHROPIC_BASE_URL GEMINI_BASE_URL`.
- Any `~/.config/ormuz/` directory if it's empty after PAC removal — harmless; remove if you want.

## Troubleshooting checklist

Scan top to bottom; first match usually wins.

- **New shell doesn't see `$ANTHROPIC_BASE_URL`.** Confirm the block is present (`grep ormuz ~/.zshrc`). If it is, you're in a non-zsh or non-interactive shell — `source ~/.zshrc` or move the exports into the shell rc file you actually use.
- **`launchctl list | grep ormuz` is empty after install.** Either bootstrap failed (re-run `npm run install:autostart` and watch for errors), or the agent crashed at startup. Check `~/Library/Logs/ormuz.err.log`.
- **Agent listed but `lsof -i :8787` empty.** Almost always Node not found under launchd's PATH. Re-run with `NODE_BIN=$(which node)` set explicitly.
- **`/health` returns connection-refused.** Same as above, or `EADDRINUSE` (something else has port 8787). Check `ormuz.err.log` and `lsof -i :8787`.
- **CONNECT returns 403.** The host isn't in `config/provider-targets.json` and Ormuz refuses to tunnel to arbitrary hosts. Add it to `providers`, `routes.pathPrefixes`, or `routes.headers[].target`, then re-run `npm run install:systemproxy` to regenerate the PAC.
- **CONNECT returns 5xx or hangs.** Upstream may be unreachable from your network. Test directly with `curl -v https://<host>/` while system proxy is off (`networksetup -setautoproxystate <service> off`).
- **HTTP requests through `*_BASE_URL` get `400 unmatched_route`.** A path-prefix or header rule is missing in `config/provider-targets.json`. The README's "Provider URL format" section has the routing precedence rules.
- **429 spikes right after install.** Lower `ORMUZ_RPM` or `ORMUZ_SAFETY_FACTOR`. If upstream is the source (visible as `ormuz_upstream_status_total{code="429"}` in `/metrics`), drop `ORMUZ_MAX_RETRY_AFTER_MS` so a slow `Retry-After` doesn't strand the bucket.
- **GUI app still bypasses Ormuz with both A and C installed.** Almost certainly cert pinning; there's no remediation. Confirm by capturing traffic with Little Snitch or `tcpdump` and checking whether the app TLS-handshakes directly with the upstream.
- **PAC change didn't take effect.** Apps cache PAC results. Restart the app, or for browsers, toggle off/on in System Settings.
- **Re-running `install:systemproxy` doesn't pick up new hosts.** Check that you actually edited `config/provider-targets.json` (not a copy elsewhere) and that the script extracted them — it prints the host list to stdout under `==> hosts to route through Ormuz:`.
- **Multiple network services, some still bypass.** Re-run `npm run install:systemproxy` after connecting to the new service. The script only touches services that were active at install time.
