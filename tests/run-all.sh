#!/bin/sh
# Run every test suite. Usage: sh tests/run-all.sh
set -e
cd "$(dirname "$0")/.."
"$ABACUSAI_BOT_NODE" tests/verification.test.cjs
"$ABACUSAI_BOT_NODE" tests/supabase.test.cjs
"$ABACUSAI_BOT_NODE" tests/core.test.cjs
"$ABACUSAI_BOT_NODE" tests/schema.test.cjs
# live three-identity RLS test — reads .env (git-ignored) or the environment,
# and skips cleanly when no credentials are configured
"$ABACUSAI_BOT_NODE" tests/rls-live.test.cjs
