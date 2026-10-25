#!/usr/bin/env bash
# PropDesk launcher: make sure the server is up, then focus or open the app window.
set -uo pipefail
PORT="${PROPDESK_PORT:-4777}"
URL="http://127.0.0.1:${PORT}"

# Already open? Focus it instead of opening a second window.
if command -v hyprctl >/dev/null 2>&1 && hyprctl clients -j 2>/dev/null | grep -q '"class": "PropDesk"'; then
  exec hyprctl dispatch focuswindow class:PropDesk >/dev/null
fi

if ! curl -fs "${URL}/api/health" >/dev/null 2>&1; then
  systemctl --user start propdesk.service 2>/dev/null || true
  for _ in $(seq 1 75); do
    curl -fs "${URL}/api/health" >/dev/null 2>&1 && break
    sleep 0.2
  done
fi

PROFILE="${XDG_DATA_HOME:-$HOME/.local/share}/propdesk/chrome-profile"
mkdir -p "$PROFILE"
exec google-chrome-stable --ozone-platform=x11 --user-data-dir="$PROFILE" --class=PropDesk \
  --no-first-run --no-default-browser-check --disable-features=Translate \
  --app="${URL}" "$@"
