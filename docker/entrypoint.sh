#!/bin/sh
# Container entrypoint. See docs/DEPLOY.md.
#   run [--once]     default: migrate the DB, then the `run` loop
#   login [--done]   hand login over noVNC: asks the running loop to open it, or opens it here
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

# `login` touches no DB; skip the migration (the loop may be running next to it).
if [ "${1:-run}" = "login" ]; then
  exec ./node_modules/.bin/tsx src/cli/index.ts "$@"
fi

case "${1:-}" in
  sh | bash | claude | node) exec "$@" ;;
  "") set -- run ;;
esac

./node_modules/.bin/prisma migrate deploy
exec ./node_modules/.bin/tsx src/cli/index.ts "$@"
