#!/usr/bin/env bash
set -euo pipefail

# Reverse what install-autostart.sh did: stop and remove the LaunchAgent,
# strip the env-var block from ~/.zshrc.

if [[ "$(uname)" != "Darwin" ]]; then
    echo "uninstall-autostart: this script targets macOS. Aborting." >&2
    exit 1
fi

PLIST_LABEL="com.ormuz.proxy"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"
ZSHRC="$HOME/.zshrc"
ZSHRC_BEGIN="# >>> ormuz autostart >>>"
ZSHRC_END="# <<< ormuz autostart <<<"
PORT="${ORMUZ_PORT:-8787}"

UID_VAL="$(id -u)"

echo "==> stopping LaunchAgent"
launchctl bootout "gui/$UID_VAL/$PLIST_LABEL" >/dev/null 2>&1 || true

if [[ -f "$PLIST_PATH" ]]; then
    echo "==> removing $PLIST_PATH"
    rm -f "$PLIST_PATH"
fi

if [[ -f "$ZSHRC" ]] && grep -qF "$ZSHRC_BEGIN" "$ZSHRC"; then
    echo "==> stripping env-var block from ~/.zshrc"
    awk -v b="$ZSHRC_BEGIN" -v e="$ZSHRC_END" '
        $0 == b { skip = 1; next }
        $0 == e { skip = 0; next }
        !skip { print }
    ' "$ZSHRC" >"$ZSHRC.ormuz.tmp"
    mv "$ZSHRC.ormuz.tmp" "$ZSHRC"
fi

cat <<EOF

Done. Open a new terminal for env-var changes to take effect.

If a script has cached env vars, unset them manually:
  unset OPENAI_BASE_URL ANTHROPIC_BASE_URL GEMINI_BASE_URL

Verify the agent is gone:
  launchctl list | grep ormuz   # should print nothing
  lsof -i :$PORT                 # should print nothing
EOF
