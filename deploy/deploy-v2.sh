#!/usr/bin/env bash
# Publish only the V2 Group Control Center. Never writes to /opt/solarpoints
# (the legacy member-points application). Existing V2 data is kept in a shared
# directory and a timestamped server-side backup is made before switching.
set -euo pipefail

SOURCE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ -n "$(git -C "$SOURCE_ROOT" status --porcelain --untracked-files=normal)" ]]; then
  echo "Source checkout has uncommitted or untracked files; commit the reviewed release first." >&2
  exit 2
fi
if [[ "$#" -ne 1 ]]; then
  echo "Usage: $0 ubuntu@<server-host>" >&2
  exit 2
fi
SSH_TARGET="$1"
if [[ ! "$SSH_TARGET" =~ ^[A-Za-z0-9_.@-]+$ ]]; then
  echo "Invalid SSH target" >&2
  exit 2
fi

RELEASE_ID="release-$(date -u +%Y%m%dT%H%M%SZ)"
UPLOAD_NAME="nss-solar-v2-${RELEASE_ID}.tar.gz"
TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT

SOURCE_SHA="$(git -C "$SOURCE_ROOT" rev-parse HEAD)"
SOURCE_COMPATIBILITY="$(bash "$SOURCE_ROOT/deploy/release-safety.sh" contract "$SOURCE_ROOT")"
if [[ "$SOURCE_COMPATIBILITY" == unknown ]]; then
  echo "Release compatibility declaration is missing or invalid; refusing to deploy." >&2
  exit 2
fi
git -C "$SOURCE_ROOT" archive --format=tar HEAD | gzip -9 > "$TEMP_DIR/$UPLOAD_NAME"
tar -tzf "$TEMP_DIR/$UPLOAD_NAME" package-lock.json server.js >/dev/null
echo "Prepared reviewed Git commit: $SOURCE_SHA"

scp -o BatchMode=yes -o StrictHostKeyChecking=yes "$TEMP_DIR/$UPLOAD_NAME" "$SSH_TARGET:/tmp/$UPLOAD_NAME"
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes "$SSH_TARGET" "bash -s -- '$RELEASE_ID' '/tmp/$UPLOAD_NAME' '$SOURCE_SHA' '$SOURCE_COMPATIBILITY'" <<'REMOTE'
set -euo pipefail
RELEASE_ID="$1"
UPLOAD_FILE="$2"
SOURCE_SHA="$3"
SOURCE_COMPATIBILITY="$4"
APP_ROOT="/opt/solarpoints-v2"
RELEASES="$APP_ROOT/releases"
DATA_DIR="$APP_ROOT/data"
BACKUPS="$APP_ROOT/backups"
HISTORY="$APP_ROOT/release-history"

if [[ ! -d "$APP_ROOT" || ! -d "$DATA_DIR" || ! -f "$APP_ROOT/server.js" ]]; then
  echo "Existing V2 installation or data directory not found; refusing first-time initialization." >&2
  exit 3
fi
command -v pm2 >/dev/null
command -v npm >/dev/null
command -v node >/dev/null
command -v curl >/dev/null
command -v cmp >/dev/null
command -v shasum >/dev/null
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || major === 22 && minor < 5) process.exit(1)' || { echo "Node.js 22.5+ is required" >&2; exit 3; }
available_kb="$(df -Pk "$APP_ROOT" | awk 'NR == 2 {print $4}')"
if [[ ! "$available_kb" =~ ^[0-9]+$ || "$available_kb" -lt 1048576 ]]; then
  echo "At least 1 GiB free disk space is required for the release and rollback copy." >&2
  exit 3
fi

OLD_RELEASE="$(readlink -f "$APP_ROOT/current" 2>/dev/null || true)"
if [[ -z "$OLD_RELEASE" || ! -f "$OLD_RELEASE/server.js" ]]; then
  OLD_RELEASE="$RELEASES/rollback-${RELEASE_ID}"
  mkdir -p "$OLD_RELEASE"
  tar -cf - \
    --exclude='./node_modules' --exclude='./data' --exclude='./backups' \
    --exclude='./releases' --exclude='./current' --exclude='./.env' \
    -C "$APP_ROOT" . | tar -xf - -C "$OLD_RELEASE"
  npm ci --omit=dev --prefix "$OLD_RELEASE"
fi

NEW_RELEASE="$RELEASES/$RELEASE_ID"
mkdir "$NEW_RELEASE"
tar -xzf "$UPLOAD_FILE" -C "$NEW_RELEASE"
rm -f "$UPLOAD_FILE"
test -f "$NEW_RELEASE/server.js"
test -x "$NEW_RELEASE/deploy/release-safety.sh"
NEW_COMPATIBILITY="$(bash "$NEW_RELEASE/deploy/release-safety.sh" contract "$NEW_RELEASE")"
if [[ "$NEW_COMPATIBILITY" != "$SOURCE_COMPATIBILITY" ]]; then
  echo "Archived release compatibility declaration differs from the reviewed source." >&2
  exit 3
fi
npm ci --omit=dev --prefix "$NEW_RELEASE"

# The candidate first boots with a disposable data directory.  No production
# file is read or written by this check, and background jobs are disabled.
ISOLATED_DATA="$(mktemp -d "$APP_ROOT/.deploy-health.XXXXXX")"
HEALTH_PORT="$((20000 + RANDOM % 20000))"
HEALTH_LOG="$ISOLATED_DATA/server.log"
cleanup_isolated() {
  if [[ -n "${HEALTH_PID:-}" ]]; then kill "$HEALTH_PID" >/dev/null 2>&1 || true; wait "$HEALTH_PID" 2>/dev/null || true; fi
  rm -rf "$ISOLATED_DATA"
}
trap cleanup_isolated EXIT
SP_DATA_DIR="$ISOLATED_DATA/data" SP_DEPLOY_READ_ONLY=1 SP_DISABLE_BACKGROUND_JOBS=1 PORT="$HEALTH_PORT" \
  node "$NEW_RELEASE/server.js" >"$HEALTH_LOG" 2>&1 &
HEALTH_PID=$!
isolated_healthy=0
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS --max-time 2 "http://127.0.0.1:$HEALTH_PORT/api/health" 2>/dev/null | node -e 'let body=""; process.stdin.on("data", chunk => body += chunk); process.stdin.on("end", () => { try { process.exit(JSON.parse(body).ok === true ? 0 : 1); } catch { process.exit(1); } });'; then isolated_healthy=1; break; fi
  sleep 1
done
if [[ "$isolated_healthy" != 1 ]]; then
  echo "Candidate failed isolated health validation; current release was not switched." >&2
  exit 4
fi
cleanup_isolated
trap - EXIT

# A verified, data-only backup is made before a production process is changed.
BACKUP_INFO="$(bash "$NEW_RELEASE/deploy/release-safety.sh" backup "$DATA_DIR" "$BACKUPS" "$RELEASE_ID")"
BACKUP_FILE="$(printf '%s\n' "$BACKUP_INFO" | sed -n '1p')"
BACKUP_SHA256="$(printf '%s\n' "$BACKUP_INFO" | sed -n '2p')"
mkdir -p "$HISTORY"
DEPLOYED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
bash "$NEW_RELEASE/deploy/release-safety.sh" manifest "$HISTORY/$RELEASE_ID.json" "$RELEASE_ID" "$SOURCE_SHA" "$DEPLOYED_AT" "$NEW_COMPATIBILITY" "$OLD_RELEASE" "$BACKUP_FILE" "$BACKUP_SHA256"

cat > "$APP_ROOT/ecosystem.v2.config.cjs" <<'PM2'
module.exports = {
  apps: [{
    name: 'solarpoints-v2',
    script: 'server.js',
    cwd: '/opt/solarpoints-v2/current',
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    watch: false,
    max_memory_restart: '512M',
    env: {
      NODE_ENV: 'production',
      PORT: '3001',
      SP_DATA_DIR: '/opt/solarpoints-v2/data',
      SP_DEPLOY_READ_ONLY: process.env.SP_DEPLOY_READ_ONLY || '0',
      SP_DISABLE_BACKGROUND_JOBS: process.env.SP_DISABLE_BACKGROUND_JOBS || '0',
    },
  }],
};
PM2

SWITCH_LINK="$APP_ROOT/current.next-$RELEASE_ID"
ln -s "$NEW_RELEASE" "$SWITCH_LINK"
mv -Tf "$SWITCH_LINK" "$APP_ROOT/current"
# PM2 keeps the original script path when startOrReload targets an existing app.
# Replace only the V2 process so that it actually uses the current release link.
start_current_release() {
  local read_only="$1"
  local disable_background_jobs=0
  if [[ "$read_only" == 1 ]]; then disable_background_jobs=1; fi
  if pm2 describe solarpoints-v2 >/dev/null 2>&1; then
    pm2 delete solarpoints-v2 || return 1
  fi
  SP_DEPLOY_READ_ONLY="$read_only" SP_DISABLE_BACKGROUND_JOBS="$disable_background_jobs" pm2 start "$APP_ROOT/ecosystem.v2.config.cjs" --update-env
}

# Start the live candidate read-only.  A health failure can only select the
# prior release through the compatibility gate below; unknown metadata refuses
# to guess and leaves recovery to an administrator.
if ! start_current_release 1; then
  echo "Candidate could not start. Automatic rollback is intentionally disabled after a release switch; inspect the release record and recover manually." >&2
  exit 5
fi

healthy=0
HEALTH_HTML="$(mktemp)"
trap 'rm -f "$HEALTH_HTML"' EXIT
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS --max-time 4 http://127.0.0.1:3001/api/health 2>/dev/null | node -e 'let body=""; process.stdin.on("data", chunk => body += chunk); process.stdin.on("end", () => { try { process.exit(JSON.parse(body).ok === true ? 0 : 1); } catch { process.exit(1); } });' \
    && curl -fsS --max-time 4 http://127.0.0.1:3001/ -o "$HEALTH_HTML" \
    && cmp -s "$HEALTH_HTML" "$NEW_RELEASE/public/index.html"; then
    healthy=1; break
  fi
  sleep 2
done
if [[ "$healthy" != 1 ]]; then
  pm2 stop solarpoints-v2 || true
  if bash "$NEW_RELEASE/deploy/release-safety.sh" safe-switch "$APP_ROOT/current" "$OLD_RELEASE" "$DATA_DIR"; then
    if start_current_release 0; then
      pm2 save
      echo "Read-only candidate failed health validation; restored a compatibility-approved fallback." >&2
      exit 6
    fi
  fi
  echo "Read-only candidate failed health validation. Automatic fallback was refused; service remains stopped for manual recovery. Backup: $BACKUP_FILE" >&2
  exit 6
fi

# The validation phase accepted no state-changing HTTP requests.  Once the
# candidate is healthy, restart it normally.  A later failure never triggers
# an automatic code rollback because real writes may already have occurred.
if ! start_current_release 0; then
  echo "Validated candidate could not restart normally. Automatic rollback is disabled; recover manually using the recorded compatible release." >&2
  exit 7
fi
pm2 save
echo "V2 deployed: $NEW_RELEASE"
echo "Backup created: $BACKUP_FILE"
echo "Release record: $HISTORY/$RELEASE_ID.json"
echo "Legacy member-points app at /opt/solarpoints was not changed."
REMOTE
