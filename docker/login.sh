#!/bin/sh
# One-time hand login (see docs/DEPLOY.md). Starts a virtual display, exposes it through noVNC
# on port 6080 and opens the collector's browser on the profile. A human logs in to every kid
# account by hand; nothing here types or stores a password. Quit Chrome to finish.
set -eu
cd /app

PROFILE="${CA_PROFILE_DIR:-/profile}"
DISPLAY_NUM=:99
SCREEN="${CA_LOGIN_SCREEN:-1280x900x24}"

if [ "${CA_CHROME_CHANNEL:-chrome}" = "chrome" ]; then
  BROWSER=/opt/google/chrome/chrome
else
  BROWSER="$(node --input-type=module -e "import { chromium } from 'playwright'; console.log(chromium.executablePath())")"
fi
if [ ! -x "$BROWSER" ]; then
  echo "login: browser not found at $BROWSER" >&2
  exit 1
fi

Xvfb "$DISPLAY_NUM" -screen 0 "$SCREEN" -nolisten tcp >/dev/null 2>&1 &
export DISPLAY="$DISPLAY_NUM"
sleep 1
# VNC listens on the container's loopback only; noVNC is the way in (publish 6080 on the host's
# 127.0.0.1 and use an SSH tunnel on a remote machine).
x11vnc -display "$DISPLAY_NUM" -localhost -forever -shared -nopw -quiet >/dev/null 2>&1 &
websockify --web /usr/share/novnc 6080 localhost:5900 >/dev/null 2>&1 &

echo "login: open http://localhost:6080/vnc.html and click Connect."
echo "login: log in to each kid account by hand (account switcher), open classroom.google.com"
echo "login: for each, then quit Chrome (menu > Exit) to save the profile and stop."

# Same browser and password store as the collector (no desktop keyring in the container, so
# Chrome uses its basic store either way; the flag makes it explicit).
"$BROWSER" \
  --user-data-dir="$PROFILE" \
  --no-sandbox \
  --password-store=basic \
  --no-first-run \
  --no-default-browser-check \
  --start-maximized \
  --window-position=0,0 \
  "--window-size=$(echo "$SCREEN" | cut -dx -f1),$(echo "$SCREEN" | cut -dx -f2)" \
  https://classroom.google.com/ || true

echo "login: Chrome exited; profile saved in $PROFILE."
