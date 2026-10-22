#!/bin/sh
# Training Room laptop bridge (macOS/Linux). Needs Node.js 20+.
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20 or newer is required: https://nodejs.org" >&2
  exit 1
fi
exec node server.mjs "$@"
