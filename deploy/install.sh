#!/usr/bin/env bash
# Builds the web app and installs PropDesk as a user service + desktop launcher.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
npm run build
mkdir -p ~/.config/systemd/user ~/.local/bin ~/.local/share/applications ~/.local/share/icons/hicolor/scalable/apps
sed "s#%h/Projects/propdesk#${ROOT}#" deploy/propdesk.service > ~/.config/systemd/user/propdesk.service
install -m 755 deploy/propdesk-launch.sh ~/.local/bin/propdesk
sed "s#%h#${HOME}#" deploy/propdesk.desktop > ~/.local/share/applications/propdesk.desktop
install -m 644 web/public/icon.svg ~/.local/share/icons/hicolor/scalable/apps/propdesk.svg
systemctl --user daemon-reload
systemctl --user enable propdesk.service
systemctl --user restart propdesk.service
update-desktop-database ~/.local/share/applications 2>/dev/null || true
echo "PropDesk installed: service running on http://127.0.0.1:4777, launcher 'PropDesk' in your app menu."
