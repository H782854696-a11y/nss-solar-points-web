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
git -C "$SOURCE_ROOT" archive --format=tar HEAD | gzip -9 > "$TEMP_DIR/$UPLOAD_NAME"
tar -tzf "$TEMP_DIR/$UPLOAD_NAME" package-lock.json server.js >/dev/null
echo "Prepared reviewed Git commit: $SOURCE_SHA"

scp -o BatchMode=yes -o StrictHostKeyChecking=yes "$TEMP_DIR/$UPLOAD_NAME" "$SSH_TARGET:/tmp/$UPLOAD_NAME"
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes "$SSH_TARGET" "bash -s -- '$RELEASE_ID' '/tmp/$UPLOAD_NAME'" <<'REMOTE'
set -euo pipefail
RELEASE_ID="$1"
UPLOAD_FILE="$2"
APP_ROOT="/opt/solarpoints-v2"
RELEASES="$APP_ROOT/releases"
DATA_DIR="$APP_ROOT/data"
BACKUPS="$APP_ROOT/backups"

if [[ ! -d "$APP_ROOT" || ! -d "$DATA_DIR" || ! -f "$APP_ROOT/server.js" ]]; then
  echo "Existing V2 installation or data directory not found; refusing first-time initialization." >&2
  exit 3
fi
command -v pm2 >/dev/null
command -v npm >/dev/null
command -v node >/dev/null
command -v curl >/dev/null
command -v cmp >/dev/null
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || major === 22 && minor < 5) process.exit(1)' || { echo "Node.js 22.5+ is required" >&2; exit 3; }
available_kb="$(df -Pk "$APP_ROOT" | awk 'NR == 2 {print $4}')"
if [[ ! "$available_kb" =~ ^[0-9]+$ || "$available_kb" -lt 1048576 ]]; then
  echo "At least 1 GiB free disk space is required for the release and rollback copy." >&2
  exit 3
fi

umask 077
mkdir -p "$RELEASES" "$BACKUPS"
chmod 700 "$BACKUPS"
BACKUP_FILE="$BACKUPS/nss-solar-v2-${RELEASE_ID}.tar.gz"
tar -czf "$BACKUP_FILE" \
  --exclude='solarpoints-v2/node_modules' \
  --exclude='solarpoints-v2/backups' \
  --exclude='solarpoints-v2/releases' \
  --exclude='solarpoints-v2/current' \
  -C /opt solarpoints-v2
if [[ ! -s "$BACKUP_FILE" ]] || ! tar -tzf "$BACKUP_FILE" >/dev/null; then
  echo "V2 backup could not be verified; refusing to deploy." >&2
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
npm ci --omit=dev --prefix "$NEW_RELEASE"

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
    },
  }],
};
PM2

SWITCH_LINK="$APP_ROOT/current.next-$RELEASE_ID"
ln -s "$NEW_RELEASE" "$SWITCH_LINK"
mv -Tf "$SWITCH_LINK" "$APP_ROOT/current"
if ! pm2 startOrReload "$APP_ROOT/ecosystem.v2.config.cjs" --update-env; then
  ln -sfn "$OLD_RELEASE" "$SWITCH_LINK"
  mv -Tf "$SWITCH_LINK" "$APP_ROOT/current"
  pm2 startOrReload "$APP_ROOT/ecosystem.v2.config.cjs" --update-env || true
  pm2 save || true
  exit 4
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
  ln -sfn "$OLD_RELEASE" "$SWITCH_LINK"
  mv -Tf "$SWITCH_LINK" "$APP_ROOT/current"
  pm2 startOrReload "$APP_ROOT/ecosystem.v2.config.cjs" --update-env || true
  pm2 save || true
  echo "V2 health check failed; restored the prior code release. Backup: $BACKUP_FILE" >&2
  exit 5
fi
pm2 save
echo "V2 deployed: $NEW_RELEASE"
echo "Backup created: $BACKUP_FILE"
echo "Legacy member-points app at /opt/solarpoints was not changed."
REMOTE
