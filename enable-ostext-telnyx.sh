#!/usr/bin/env bash
#
# Enable OS Text for a workspace using the HOUSE Telnyx account.
# Run ON THE SERVER (the box running the RecruitersOS docker compose stack):
#
#   ./enable-ostext-telnyx.sh              # targets the workspace matching "lume"
#   ./enable-ostext-telnyx.sh acme         # or match another workspace by name/domain
#   WS_ID=ws_xxxx ./enable-ostext-telnyx.sh   # or pin the exact workspace id
#
# To supply (or rotate) the Telnyx keys inline:
#   TELNYX_API_KEY=KEY01... TELNYX_FROM_NUMBER=+1310... ./enable-ostext-telnyx.sh
#
# What it does (idempotent, safe to re-run):
#   1. Resolves the Telnyx keys: shell env first (wins, allows rotation), then
#      .env.production (app), then money-maker-sms/.env.production (engine).
#      TELNYX_API_KEY is required; the rest are optional but recommended.
#   2. Upserts the keys into BOTH env files, so the portal's raw Telnyx 10DLC
#      send path AND the embedded OS Text engine can text with the house account.
#   3. Grants the target workspace house-key access to the `telnyx` and `taltxt`
#      integrations (the operator resale path, at cost), by updating the app's
#      /data snapshots with the same shapes POST /api/owner/grants writes.
#   4. Recreates the app + taltxt containers so env and grants take effect.
#
# After it runs: sign in on the workspace's portal (e.g. app.lumesp.com), open
# Connected, press Test on Telnyx (turns it green), and open the OS Text tab.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

SEARCH="${1:-lume}"
APP_ENV="$DIR/.env.production"
ENGINE_ENV="$DIR/money-maker-sms/.env.production"

say() { echo "==> $*"; }

[ -f "$APP_ENV" ] || { echo "ERROR: $APP_ENV not found. Run ./deploy.sh first." >&2; exit 1; }
[ -f "$ENGINE_ENV" ] || { echo "ERROR: $ENGINE_ENV not found. Run ./deploy.sh first (it scaffolds the OS Text env)." >&2; exit 1; }

# --- 1. Resolve the Telnyx keys (shell env > app env > engine env) -------------
KEYS=(TELNYX_API_KEY TELNYX_MESSAGING_PROFILE_ID TELNYX_FROM_NUMBER TELNYX_PUBLIC_KEY TELNYX_CONNECTION_ID TELNYX_MPS)

from_file() { # $1 file, $2 key -> value or empty
  grep -E "^$2=" "$1" 2>/dev/null | head -1 | cut -d= -f2- || true
}

declare -A VAL SRC
for k in "${KEYS[@]}"; do
  v="${!k:-}"; s="shell"
  [ -n "$v" ] || { v="$(from_file "$APP_ENV" "$k")"; s="app env"; }
  [ -n "$v" ] || { v="$(from_file "$ENGINE_ENV" "$k")"; s="engine env"; }
  VAL[$k]="$v"; SRC[$k]="$s"
done

if [ -z "${VAL[TELNYX_API_KEY]}" ]; then
  cat >&2 <<'EOF'
ERROR: no TELNYX_API_KEY found in the shell env, .env.production, or
money-maker-sms/.env.production. Supply it inline and re-run:

  TELNYX_API_KEY=KEY01... TELNYX_FROM_NUMBER=+1310... ./enable-ostext-telnyx.sh

(The key is in the Telnyx portal under Auth > API Keys.)
EOF
  exit 1
fi

say "Telnyx keys resolved:"
for k in "${KEYS[@]}"; do
  if [ -n "${VAL[$k]}" ]; then echo "    $k  (from ${SRC[$k]})"; else echo "    $k  (not set, skipping)"; fi
done

# --- 2. Upsert the keys into both env files ------------------------------------
# Shell-provided values overwrite (rotation); file-sourced values only fill gaps.
upsert() { # $1 file, $2 key, $3 value, $4 overwrite(yes/no)
  local f="$1" k="$2" v="$3" ow="$4"
  if grep -qE "^$k=" "$f"; then
    [ "$ow" = "yes" ] || return 0
    # Replace in place without regex surprises in the value.
    awk -v k="$k" -v v="$v" 'BEGIN{FS=OFS="="} $1==k{$0=k"="v} {print}' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
  else
    printf '%s=%s\n' "$k" "$v" >> "$f"
  fi
}

for k in "${KEYS[@]}"; do
  [ -n "${VAL[$k]}" ] || continue
  ow="no"; [ "${SRC[$k]}" = "shell" ] && ow="yes"
  upsert "$APP_ENV" "$k" "${VAL[$k]}" "$ow"
  upsert "$ENGINE_ENV" "$k" "${VAL[$k]}" "$ow"
done
say "Env files updated (app + OS Text engine)."

# --- 3. Grant house Telnyx + OS Text to the target workspace -------------------
# Runs node inside the app image with the /data volume mounted, edits the same
# snapshots lib/connected/access.ts persists (atomic tmp+rename write).
say "Granting house Telnyx access to the workspace matching '${WS_ID:-$SEARCH}'"
docker compose run --rm --no-deps --entrypoint "" \
  -e WS_ID="${WS_ID:-}" -e SEARCH="$SEARCH" \
  app node -e '
const fs = require("fs");
const AUTH = "/data/snap_auth.json";
const GRANTS = "/data/snap_integration_grants.json";

const auth = JSON.parse(fs.readFileSync(AUTH, "utf8"));
const workspaces = new Map(auth.workspaces || []);
const wanted = (process.env.WS_ID || "").trim();
const search = (process.env.SEARCH || "lume").toLowerCase();

let matches = [];
if (wanted) {
  if (workspaces.has(wanted)) matches = [[wanted, workspaces.get(wanted)]];
} else {
  matches = [...workspaces.entries()].filter(([id, ws]) =>
    [ws.name, ws.domain, id].some(v => String(v || "").toLowerCase().includes(search)));
}
if (matches.length !== 1) {
  console.error(matches.length === 0
    ? "No workspace matched. All workspaces:"
    : "Ambiguous match (" + matches.length + "). Re-run with WS_ID=<id>. Matches:");
  const list = matches.length ? matches : [...workspaces.entries()];
  for (const [id, ws] of list) console.error("  " + id + "  name=" + (ws.name || "?") + "  domain=" + (ws.domain || "-"));
  process.exit(2);
}
const [wsId, ws] = matches[0];

let snap = { grants: [] };
try { snap = JSON.parse(fs.readFileSync(GRANTS, "utf8")); } catch {}
const grants = new Map((snap.grants || []).map(([w, entries]) => [w, new Map(entries)]));
const mine = grants.get(wsId) || new Map();
const now = new Date().toISOString();
for (const id of ["telnyx", "taltxt"]) {
  const prev = mine.get(id) || {};
  mine.set(id, { ...prev, grantedAt: prev.grantedAt || now }); // at cost: no markup terms
}
grants.set(wsId, mine);
const out = { grants: [...grants.entries()].map(([w, m]) => [w, [...m.entries()]]) };
fs.writeFileSync(GRANTS + ".tmp", JSON.stringify(out));
fs.renameSync(GRANTS + ".tmp", GRANTS);
console.log("Granted telnyx + taltxt (OS Text) to " + wsId + " (" + (ws.name || "unnamed") + ", domain " + (ws.domain || "-") + ")");
'

# --- 4. Apply: recreate app (env + grants rehydrate) and the OS Text engine ----
say "Recreating app + taltxt containers"
docker compose up -d app taltxt

say "Done. Next steps:"
cat <<'EOF'
  1. Sign in on the workspace portal (app.lumesp.com), open Connected.
  2. Telnyx shows access "granted": press Test so it turns green.
  3. Open the OS Text tab: the engine now texts with the house Telnyx account.
EOF
