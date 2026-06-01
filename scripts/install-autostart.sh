#!/usr/bin/env bash
set -euo pipefail

# Install Ormuz as a launchd LaunchAgent on macOS so it starts at login,
# and add SDK base-URL env vars to ~/.zshrc.
#
# Idempotent: re-running replaces the plist and skips zshrc edits if the
# block already exists.

if [[ "$(uname)" != "Darwin" ]]; then
    echo "install-autostart: this script targets macOS (launchd). Aborting." >&2
    exit 1
fi

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLIST_LABEL="com.ormuz.proxy"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"
TEMPLATE="$REPO_DIR/scripts/com.ormuz.proxy.plist.template"
ZSHRC="$HOME/.zshrc"
ZSHRC_BEGIN="# >>> ormuz autostart >>>"
ZSHRC_END="# <<< ormuz autostart <<<"

NODE_BIN="${NODE_BIN:-$(command -v node)}"
if [[ -z "$NODE_BIN" ]]; then
    echo "install-autostart: 'node' not found on PATH. Set NODE_BIN=/path/to/node and retry." >&2
    exit 1
fi

echo "==> repo: $REPO_DIR"
echo "==> node: $NODE_BIN"

echo "==> building (npm run build)"
(cd "$REPO_DIR" && npm run build >/dev/null)

if [[ ! -f "$REPO_DIR/dist/cli.js" ]]; then
    echo "install-autostart: build did not produce dist/cli.js. Aborting." >&2
    exit 1
fi

echo "==> writing $PLIST_PATH"
mkdir -p "$HOME/Library/LaunchAgents"
mkdir -p "$HOME/Library/Logs"
sed \
    -e "s|{{NODE_BIN}}|$NODE_BIN|g" \
    -e "s|{{REPO}}|$REPO_DIR|g" \
    -e "s|{{HOME}}|$HOME|g" \
    "$TEMPLATE" >"$PLIST_PATH"

# Reload the agent: bootout (ignore errors if not loaded), then bootstrap.
UID_VAL="$(id -u)"
launchctl bootout "gui/$UID_VAL/$PLIST_LABEL" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$UID_VAL" "$PLIST_PATH"

# Wait briefly for the listener.
for _ in 1 2 3 4 5 6 7 8 9 10; do
    if curl -sS -o /dev/null -m 1 http://127.0.0.1:8787/health 2>/dev/null; then
        break
    fi
    sleep 1
done

if curl -sS -o /dev/null -w "%{http_code}" -m 2 http://127.0.0.1:8787/health 2>/dev/null | grep -q 200; then
    echo "==> Ormuz is listening on http://127.0.0.1:8787"
else
    echo "==> WARNING: Ormuz not responding yet. Check ~/Library/Logs/ormuz.err.log" >&2
fi

# Add env vars to ~/.zshrc (idempotent: check for the begin sentinel).
if [[ -f "$ZSHRC" ]] && grep -qF "$ZSHRC_BEGIN" "$ZSHRC"; then
    echo "==> ~/.zshrc already contains the ormuz block; leaving it alone"
else
    echo "==> appending env-var block to ~/.zshrc"
    {
        printf '\n%s\n' "$ZSHRC_BEGIN"
        printf '# Managed by scripts/install-autostart.sh. Remove with uninstall-autostart.sh.\n'
        printf 'export OPENAI_BASE_URL=http://127.0.0.1:8787/v1/openai\n'
        printf 'export ANTHROPIC_BASE_URL=http://127.0.0.1:8787/v1/anthropic\n'
        printf 'export GEMINI_BASE_URL=http://127.0.0.1:8787/v1/gemini\n'
        printf '%s\n' "$ZSHRC_END"
    } >>"$ZSHRC"
fi

cat <<EOF

Done. Open a new terminal (or 'source ~/.zshrc') for the env vars to apply.

Verify:
  curl -sS http://127.0.0.1:8787/health
  echo \$ANTHROPIC_BASE_URL

Logs:
  tail -f ~/Library/Logs/ormuz.out.log ~/Library/Logs/ormuz.err.log

To remove: scripts/uninstall-autostart.sh
EOF
