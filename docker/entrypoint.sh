#!/bin/sh
# Container entrypoint. See docs/DEPLOY.md.
#   run [--once]     default: migrate the DB, then the `run` loop
#   login            noVNC + headful Chrome on /profile so a human logs in by hand
#   <cli command>    any other classroom-advisor command (doctor, sync, report, ...)
#   sh|bash|claude|node ...   run as is (e.g. `claude` to log the CLI in)
set -eu
cd /app

# Google Chrome stable has no linux/arm64 build; use Playwright's bundled Chromium there.
if [ -z "${CA_CHROME_CHANNEL:-}" ]; then
  if [ -x /opt/google/chrome/chrome ]; then
    export CA_CHROME_CHANNEL=chrome
  else
    export CA_CHROME_CHANNEL=chromium
  fi
fi

if [ "${1:-run}" = "login" ]; then
  exec /usr/local/bin/login.sh
fi

case "${1:-}" in
  sh | bash | claude | node) exec "$@" ;;
  "") set -- run ;;
esac

./node_modules/.bin/prisma migrate deploy
exec ./node_modules/.bin/tsx src/cli/index.ts "$@"
