#!/bin/sh
# Run every test suite. Usage: sh tests/run-all.sh
# Set NODE=/path/to/node if node is not on your PATH.
set -e
cd "$(dirname "$0")/.."

NODE=${NODE:-node}
if ! command -v "$NODE" >/dev/null 2>&1; then
  echo "node not found — install Node.js or run with NODE=/path/to/node" >&2
  exit 1
fi

"$NODE" tests/verification.test.cjs
"$NODE" tests/supabase.test.cjs
"$NODE" tests/core.test.cjs
"$NODE" tests/schema.test.cjs
"$NODE" tests/sync.test.cjs
"$NODE" tests/jummah.test.cjs
"$NODE" tests/app-ui.test.cjs
"$NODE" tests/mirror.test.cjs
# live three-identity RLS test — reads .env (git-ignored) or the environment,
# and skips cleanly when no credentials are configured
"$NODE" tests/rls-live.test.cjs
