#!/bin/sh
# Deploy the verify-jummah Edge Function and prove its auth gates work.
#
#   sh scripts/deploy-jummah.sh                  deploy, then verify
#   sh scripts/deploy-jummah.sh --verify-only    checks only, no deploy
#   sh scripts/deploy-jummah.sh --deploy-only    deploy only
#   sh scripts/deploy-jummah.sh --verify-only --base-url http://127.0.0.1:8000
#
# Needs SUPABASE_ACCESS_TOKEN in the environment: a personal access token scoped
# to the project, with "Edge Functions" read-write. The project ref, the site URL
# and the publishable key are read from public/config.js, so the checks always
# run against the project the site itself uses.
#
# Optional, from the environment or the git-ignored .env:
#   TEST_USER_EMAIL  / TEST_USER_PASSWORD     real 403 check (ordinary account)
#   TEST_ADMIN_EMAIL / TEST_ADMIN_PASSWORD    real 200 check (admin account)
#   TAVILY_API_KEY                            not set here; see the README if the
#                                             web-search mode is wanted
#
# Exit codes: 0 every check that could run passed, 1 a check failed,
# 2 blocked (no token, or the token lacks the Edge Functions permission).
# No secret is printed or written: the token only ever travels in a header, and
# passwords only go to /auth/v1/token.

set -eu
cd "$(dirname "$0")/.."

MODE=all
BASE_OVERRIDE=''
while [ $# -gt 0 ]; do
  case "$1" in
    --deploy-only) MODE=deploy ;;
    --verify-only) MODE=verify ;;
    --base-url)
      shift
      BASE_OVERRIDE=${1:-}
      if [ -z "$BASE_OVERRIDE" ]; then echo "--base-url needs a URL" >&2; exit 64; fi
      ;;
    -h|--help) sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown argument: $1 (try --help)" >&2; exit 64 ;;
  esac
  shift
done

# ---------------------------------------------------------------- inputs
# Local test accounts may live in .env (git-ignored). Only these four names are
# read, so nothing else in the file can leak into the script's environment.
if [ -f .env ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    key=${line%%=*}
    val=${line#*=}
    case "$key" in
      TEST_USER_EMAIL|TEST_USER_PASSWORD|TEST_ADMIN_EMAIL|TEST_ADMIN_PASSWORD) ;;
      *) continue ;;
    esac
    case "$val" in
      \"*\") val=${val#\"}; val=${val%\"} ;;
      \'*\') val=${val#\'}; val=${val%\'} ;;
    esac
    eval "current=\${$key-}"
    [ -n "$current" ] || export "$key=$val"
  done < .env
fi

CFG=$(node -e '
const fs = require("fs");
const s = fs.readFileSync("public/config.js", "utf8");
const u = s.match(/supabaseUrl\s*:\s*[\x27"]([^\x27"]+)/);
const k = s.match(/supabaseAnonKey\s*:\s*[\x27"]([^\x27"]+)/);
process.stdout.write((u ? u[1] : "") + "\n" + (k ? k[1] : "") + "\n");
') || { echo "Could not read public/config.js" >&2; exit 1; }
SITE_URL=$(printf '%s\n' "$CFG" | sed -n 1p)
ANON_KEY=$(printf '%s\n' "$CFG" | sed -n 2p)
case "$SITE_URL" in
  https://*.supabase.co) ;;
  *) echo "public/config.js has no Supabase URL — nothing to deploy against." >&2; exit 1 ;;
esac
case "$ANON_KEY" in
  '') echo "public/config.js has no anon/publishable key — the checks need it." >&2; exit 1 ;;
esac
REF=$(printf '%s' "$SITE_URL" | sed -E 's#^https://([^.]+)\.supabase\.co.*#\1#')
BASE=${BASE_OVERRIDE:-$SITE_URL}

PASSED=0
FAILED=0
SKIPPED=0
ok()   { PASSED=$((PASSED + 1));  printf 'PASS  %s\n' "$*"; }
bad()  { FAILED=$((FAILED + 1));  printf 'FAIL  %s\n' "$*"; }
skip() { SKIPPED=$((SKIPPED + 1)); printf 'SKIP  %s\n' "$*"; }
summary() {
  printf '\n%d passed, %d failed, %d skipped\n' "$PASSED" "$FAILED" "$SKIPPED"
}

TMP=$(mktemp -d 2>/dev/null || mktemp -d -t jummah)
trap 'rm -rf "$TMP"' EXIT INT TERM
BODY="$TMP/body"

# ---------------------------------------------------------------- deploy
if [ "$MODE" = all ] || [ "$MODE" = deploy ]; then
  if [ -z "${SUPABASE_ACCESS_TOKEN:-}" ]; then
    printf 'BLOCKED  SUPABASE_ACCESS_TOKEN is not set.\n'
    printf '         Create a project-scoped token with "Edge Functions" read-write\n'
    printf '         (Supabase → Account → Access Tokens) and export it.\n'
    exit 2
  fi
  if command -v supabase >/dev/null 2>&1; then
    CLI=supabase
  else
    CLI="npx --yes supabase@latest"
  fi
  # Docker is only needed for local bundling; without it, bundle server-side.
  BUNDLE=''
  command -v docker >/dev/null 2>&1 || BUNDLE='--use-api'

  printf 'Deploying verify-jummah to %s (%s)…\n' "$REF" "$(printf '%s' "$SITE_URL" | sed -E 's#^https://##')"
  if out=$($CLI functions deploy verify-jummah --project-ref "$REF" $BUNDLE --yes 2>&1); then
    dep=0
  else
    dep=$?
  fi
  printf '%s\n' "$out" | sed -E 's/(sbp_|sb_secret_|eyJ)[A-Za-z0-9._-]{10,}/\1<redacted>/g'

  case "$out" in
    *edge_functions_write*|*edge_functions_read*)
      printf '\nBLOCKED  This token cannot deploy: it lacks the Edge Functions permission.\n'
      printf '         Scoped tokens cannot be widened — delete it and create one with\n'
      printf '         "Edge Functions" read-write, then set SUPABASE_ACCESS_TOKEN again.\n'
      exit 2
      ;;
  esac
  if [ "$dep" -ne 0 ]; then
    printf '\nFAIL  deploy exited %s\n' "$dep"
    exit 1
  fi
  ok "deployed verify-jummah to $REF"
fi

# ---------------------------------------------------------------- verify
if [ "$MODE" = verify ]; then
  printf 'Verifying %s\n' "$BASE"
fi

post_fn() { # $1 bearer ('' = signed out), $2 JSON body -> prints HTTP status
  if [ -n "${1:-}" ]; then
    code=$(curl -s -o "$BODY" -w '%{http_code}' --max-time 45 -X POST \
      -H "apikey: $ANON_KEY" -H "Authorization: Bearer $1" \
      -H 'Content-Type: application/json' --data "$2" \
      "$BASE/functions/v1/verify-jummah" 2>/dev/null) || code=000
  else
    code=$(curl -s -o "$BODY" -w '%{http_code}' --max-time 45 -X POST \
      -H "apikey: $ANON_KEY" -H 'Content-Type: application/json' --data "$2" \
      "$BASE/functions/v1/verify-jummah" 2>/dev/null) || code=000
  fi
  printf '%s' "$code"
}
snippet() { head -c 200 "$BODY" 2>/dev/null | tr -d '\n'; }
jfield() { # $1 dotted path -> value from $BODY
  node -e '
let s = "";
process.stdin.on("data", (d) => (s += d)).on("end", () => {
  try {
    const v = function (o, k) { return o == null ? undefined : o[k]; };
    const out = process.argv[1].split(".").reduce(v, JSON.parse(s));
    process.stdout.write(out == null ? "" : String(out));
  } catch (e) {}
});
' "$1" < "$BODY";
}
count_times() {
  node -e '
let s = "";
process.stdin.on("data", (d) => (s += d)).on("end", () => {
  try {
    const j = JSON.parse(s);
    const n = (j.sources || []).filter((x) => x.times && x.times.length).length;
    process.stdout.write(String(n));
  } catch (e) { process.stdout.write("0"); }
});
' < "$BODY";
}
signin() { # $1 email, $2 password -> access token ('' on failure)
  body=$(node -e 'process.stdout.write(JSON.stringify({ email: process.argv[1], password: process.argv[2] }))' "$1" "$2")
  curl -s --max-time 25 -X POST -H "apikey: $ANON_KEY" -H 'Content-Type: application/json' \
    --data "$body" "$SITE_URL/auth/v1/token?grant_type=password" 2>/dev/null |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).access_token||"")}catch(e){}})'
}

# A masjid the function can actually read: prefer one whose site is known to
# carry Jumu'ah times, so a 200 carries meaningful content.
MASJID_JSON=$(node -e '
const fs = require("fs");
const arr = JSON.parse(fs.readFileSync("public/data/masjids.json", "utf8"));
const list = Array.isArray(arr) ? arr : (arr.masjids || []);
const pick = list.find((m) => /al hijaz/i.test(m.name || "") && m.website)
  || list.find((m) => m.website)
  || list[0];
process.stdout.write(JSON.stringify({
  name: pick.name,
  city: (pick.address && pick.address.city) || "",
  region: pick.region || "",
  website: pick.website || null,
}));
')

# 1. signed out
code=$(post_fn '' '{"name":"probe"}')
case "$code" in
  404) bad "function not deployed — HTTP 404 $(snippet)"; summary; exit 1 ;;
  401) ok "signed-out request rejected: 401 $(snippet)" ;;
  *)   bad "signed-out request returned $code, expected 401 ($(snippet))" ;;
esac

# 2. invalid token
code=$(post_fn 'not-a-real-jwt' '{"name":"probe"}')
if [ "$code" = 401 ]; then
  ok "invalid token rejected: 401 $(snippet)"
else
  bad "invalid token returned $code, expected 401 ($(snippet))"
fi

# 3. ordinary signed-in account -> the function's own 403
if [ -n "${TEST_USER_EMAIL:-}" ] && [ -n "${TEST_USER_PASSWORD:-}" ]; then
  tok=$(signin "$TEST_USER_EMAIL" "$TEST_USER_PASSWORD")
  if [ -z "$tok" ]; then
    skip "non-admin 403 check — sign-in failed for $TEST_USER_EMAIL"
  else
    code=$(post_fn "$tok" "$MASJID_JSON")
    case "$code" in
      403) ok "signed-in non-admin rejected by the function: 403 $(snippet)" ;;
      200) bad "signed-in non-admin got 200 — that account carries the admin role, so 403 is untested" ;;
      *)   bad "signed-in non-admin returned $code, expected 403 ($(snippet))" ;;
    esac
  fi
else
  skip 'non-admin 403 check — set TEST_USER_EMAIL / TEST_USER_PASSWORD (.env)'
fi

# 4. admin account -> 200 with extracted times
if [ -n "${TEST_ADMIN_EMAIL:-}" ] && [ -n "${TEST_ADMIN_PASSWORD:-}" ]; then
  tok=$(signin "$TEST_ADMIN_EMAIL" "$TEST_ADMIN_PASSWORD")
  if [ -z "$tok" ]; then
    skip "admin 200 check — sign-in failed for $TEST_ADMIN_EMAIL"
  else
    code=$(post_fn "$tok" "$MASJID_JSON")
    if [ "$code" = 200 ]; then
      ok "admin call accepted: 200 (ok=$(jfield ok), pages=$(jfield pages_read), sources with times=$(count_times))"
    else
      bad "admin call returned $code, expected 200 ($(snippet))"
    fi
  fi
else
  skip 'admin 200 check — set TEST_ADMIN_EMAIL / TEST_ADMIN_PASSWORD (.env)'
fi

summary
[ "$FAILED" -eq 0 ] || exit 1
