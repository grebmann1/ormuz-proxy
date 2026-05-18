#!/usr/bin/env bash
set -euo pipefail

# Install a PAC file that routes known LLM gateway hostnames through
# Ormuz on 127.0.0.1:8787, and register it with all active macOS network
# services. Idempotent.

if [[ "$(uname)" != "Darwin" ]]; then
    echo "install-systemproxy: this script targets macOS. Aborting." >&2
    exit 1
fi

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PAC_TEMPLATE="$REPO_DIR/scripts/ormuz.pac.template"
PAC_DIR="$HOME/.config/ormuz"
PAC_PATH="$PAC_DIR/proxy.pac"
PORT="${ORMUZ_PORT:-8787}"
TARGETS_FILE="${ORMUZ_PROVIDER_TARGETS_FILE:-$REPO_DIR/config/provider-targets.json}"

if [[ ! -f "$TARGETS_FILE" ]]; then
    echo "install-systemproxy: provider targets file not found: $TARGETS_FILE" >&2
    echo "Set ORMUZ_PROVIDER_TARGETS_FILE or create config/provider-targets.json first." >&2
    exit 1
fi

# Extract every hostname from the JSON config (providers, path-prefixes, header rules).
HOSTS=$(node -e "
const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync(process.argv[1], 'utf-8'));
const urls = [];
for (const v of Object.values(cfg.providers || {})) urls.push(v);
for (const v of Object.values((cfg.routes || {}).pathPrefixes || {})) urls.push(v);
for (const r of (cfg.routes || {}).headers || []) urls.push(r.target);
const hosts = new Set();
for (const u of urls) {
  try { hosts.add(new URL(u).hostname.toLowerCase()); } catch {}
}
console.log([...hosts].sort().join('\n'));
" "$TARGETS_FILE")

if [[ -z "$HOSTS" ]]; then
    echo "install-systemproxy: no hostnames extracted from $TARGETS_FILE. Aborting." >&2
    exit 1
fi

echo "==> hosts to route through Ormuz:"
printf '    %s\n' $HOSTS

# Render the PAC body (one rule per host).
RULES_FILE="$(mktemp)"
trap 'rm -f "$RULES_FILE"' EXIT
for h in $HOSTS; do
    printf '  if (host == "%s" || dnsDomainIs(host, ".%s")) return "PROXY 127.0.0.1:%s";\n' "$h" "$h" "$PORT" >> "$RULES_FILE"
done

mkdir -p "$PAC_DIR"
sed -e "s|{{PORT}}|$PORT|g" "$PAC_TEMPLATE" \
    | awk -v rules_file="$RULES_FILE" '
        /{{HOST_RULES}}/ {
            while ((getline line < rules_file) > 0) print line
            close(rules_file)
            next
        }
        { print }
      ' \
    > "$PAC_PATH"

echo "==> wrote $PAC_PATH"

PAC_URL="file://$PAC_PATH"

# Register PAC with each active network service (Wi-Fi, Ethernet, etc.).
networksetup -listallnetworkservices \
    | tail -n +2 \
    | grep -v '^\*' \
    | while IFS= read -r svc; do
        [[ -z "$svc" ]] && continue
        echo "==> setting auto-proxy on '$svc' -> $PAC_URL"
        networksetup -setautoproxyurl "$svc" "$PAC_URL"
        networksetup -setautoproxystate "$svc" on
    done

cat <<EOF

Done. Open the system proxy panel to verify:
  System Settings > Network > <service> > Details... > Proxies > Automatic Proxy Configuration

Notes:
  - Ormuz must be running on 127.0.0.1:$PORT for proxied hosts to work.
    Run scripts/install-autostart.sh to keep it running at login.
  - Some apps cache PAC results until restart.
  - Cert-pinned apps may bypass system proxy entirely; that's expected.

To remove: scripts/uninstall-systemproxy.sh
EOF
