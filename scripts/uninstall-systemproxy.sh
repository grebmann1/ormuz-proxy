#!/usr/bin/env bash
set -euo pipefail

# Reverse install-systemproxy.sh: turn off auto-proxy on every network
# service, remove the PAC file.

if [[ "$(uname)" != "Darwin" ]]; then
    echo "uninstall-systemproxy: this script targets macOS. Aborting." >&2
    exit 1
fi

PAC_DIR="$HOME/.config/ormuz"
PAC_PATH="$PAC_DIR/proxy.pac"

networksetup -listallnetworkservices \
    | tail -n +2 \
    | grep -v '^\*' \
    | while IFS= read -r svc; do
        [[ -z "$svc" ]] && continue
        echo "==> disabling auto-proxy on '$svc'"
        networksetup -setautoproxystate "$svc" off || true
    done

if [[ -f "$PAC_PATH" ]]; then
    echo "==> removing $PAC_PATH"
    rm -f "$PAC_PATH"
fi

cat <<EOF

Done. Verify in System Settings > Network > <service> > Details... > Proxies.
Some apps still cache the previous PAC; restart them if needed.
EOF
