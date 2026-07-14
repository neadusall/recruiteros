#!/usr/bin/env bash
#
# Arm OS Text single sign-on: portal users land INSIDE the SMS engine with no
# second login. Run ON THE SERVER (the box running the RecruitersOS stack):
#
#   ./enable-ostext-sso.sh
#
# To rotate the shared token:
#   ACCESS_TOKEN=$(openssl rand -hex 32) ./enable-ostext-sso.sh
#
# Why: the portal's OS Text panel iframes /api/ostext/enter, which redirects to
# the engine's instant-access route with RECRUITEROS_OSTEXT_TOKEN. The engine
# accepts it only when its own ACCESS_TOKEN matches. Until BOTH env files carry
# the same secret, the embed falls back to the engine's email login form, which
# is exactly what white-label users (app.lumesp.com) must never see.
#
# What it does (idempotent, safe to re-run):
#   1. Resolves the shared token: shell ACCESS_TOKEN first (wins, allows
#      rotation), then the engine env, then the app env, else mints a fresh one.
#   2. Upserts ACCESS_TOKEN into money-maker-sms/.env.production and
#      RECRUITEROS_OSTEXT_TOKEN (+ RECRUITEROS_OSTEXT_URL if missing) into
#      .env.production, so both sides agree.
#   3. Ensures the engine knows which account the link signs users into
#      (ACCESS_EMAIL; kept if present, else first ALLOWED_EMAILS entry, else
#      ostext@recruitersos.co).
#   4. Recreates the app + taltxt containers and probes the engine's
#      instant-access route to prove the token is live.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

APP_ENV="$DIR/.env.production"
ENGINE_ENV="$DIR/money-maker-sms/.env.production"
ENGINE_URL_DEFAULT="https://taltxt.recruitersos.co"

say() { echo "==> $*"; }

[ -f "$APP_ENV" ] || { echo "ERROR: $APP_ENV not found. Run ./deploy.sh first." >&2; exit 1; }
[ -f "$ENGINE_ENV" ] || { echo "ERROR: $ENGINE_ENV not found. Run ./deploy.sh first (it scaffolds the OS Text env)." >&2; exit 1; }

from_file() { # $1 file, $2 key -> value or empty
  grep -E "^$2=" "$1" 2>/dev/null | head -1 | cut -d= -f2- || true
}

upsert() { # $1 file, $2 key, $3 value, $4 overwrite(yes/no)
  local f="$1" k="$2" v="$3" ow="$4"
  if grep -qE "^$k=" "$f"; then
    [ "$ow" = "yes" ] || return 0
    awk -v k="$k" -v v="$v" 'BEGIN{FS=OFS="="} $1==k{$0=k"="v} {print}' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
  else
    printf '%s=%s\n' "$k" "$v" >> "$f"
  fi
}

# --- 1. Resolve the shared token (shell > engine env > app env > mint) ---------
TOKEN="${ACCESS_TOKEN:-}"; SRC="shell"; OW="yes"
[ -n "$TOKEN" ] || { TOKEN="$(from_file "$ENGINE_ENV" ACCESS_TOKEN)"; SRC="engine env"; OW="no"; }
[ -n "$TOKEN" ] || { TOKEN="$(from_file "$APP_ENV" RECRUITEROS_OSTEXT_TOKEN)"; SRC="app env"; OW="no"; }
[ -n "$TOKEN" ] || { TOKEN="$(openssl rand -hex 32)"; SRC="minted"; OW="no"; }
say "SSO token resolved (${SRC})."

# --- 2. Upsert both sides of the handshake -------------------------------------
# A shell-provided token overwrites both files (rotation); otherwise the resolved
# token fills whichever side is missing so the two files converge on one secret.
upsert "$ENGINE_ENV" ACCESS_TOKEN "$TOKEN" "$OW"
upsert "$APP_ENV" RECRUITEROS_OSTEXT_TOKEN "$TOKEN" yes
upsert "$APP_ENV" RECRUITEROS_OSTEXT_URL "$ENGINE_URL_DEFAULT" no
say "Env files updated (app + OS Text engine share one token)."

# --- 3. Ensure the engine has a sign-in identity for the link ------------------
if [ -z "$(from_file "$ENGINE_ENV" ACCESS_EMAIL)" ]; then
  FIRST_ALLOWED="$(from_file "$ENGINE_ENV" ALLOWED_EMAILS | cut -d, -f1)"
  upsert "$ENGINE_ENV" ACCESS_EMAIL "${FIRST_ALLOWED:-ostext@recruitersos.co}" no
  say "ACCESS_EMAIL set to ${FIRST_ALLOWED:-ostext@recruitersos.co}."
else
  say "ACCESS_EMAIL already set, keeping it."
fi

# --- 4. Apply and probe ---------------------------------------------------------
say "Recreating app + taltxt containers"
docker compose up -d --force-recreate app taltxt

say "Waiting for the engine, then probing instant access"
ENGINE_URL="$(from_file "$APP_ENV" RECRUITEROS_OSTEXT_URL)"
for i in $(seq 1 30); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "$ENGINE_URL/api/enter?token=$TOKEN" || true)"
  case "$code" in
    30*) say "Instant access LIVE ($code redirect: the token signs users straight in)."; break ;;
    403) echo "ERROR: engine rejected the token (403). Env mismatch, re-run this script." >&2; exit 1 ;;
    500) echo "ERROR: engine says ACCESS_TOKEN/ACCESS_EMAIL not configured (500). Check $ENGINE_ENV." >&2; exit 1 ;;
    *) sleep 2 ;;
  esac
  [ "$i" = 30 ] && { echo "ERROR: engine did not answer at $ENGINE_URL (last code $code)." >&2; exit 1; }
done

say "Done. Portal users now land inside OS Text with no second login."
cat <<'EOF'
  Verify: sign in at app.lumesp.com, open the OS Text tab. The engine should
  load signed-in inside the panel. Safari users (third-party-cookie blocking)
  get the panel's "open in a new tab" link, which signs them in top-level.
EOF
