#!/usr/bin/env bash
# Back up V2's independent persistent data; never reads or writes the legacy
# member-points database in /opt/solarpoints.
set -euo pipefail
APP_ROOT="/opt/solarpoints-v2"
DATA_DIR="$APP_ROOT/data"
BACKUP_DIR="$APP_ROOT/backups"
KEEP_DAYS="${KEEP_DAYS:-30}"
DATE_STR="$(date -u +%Y%m%dT%H%M%SZ)"

if [[ ! -d "$DATA_DIR" ]]; then
  echo "V2 data directory does not exist; refusing to create an empty backup." >&2
  exit 2
fi
umask 077
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
BACKUP_FILE="$BACKUP_DIR/nss-solar-v2-data-$DATE_STR.tar.gz"
tar -czf "$BACKUP_FILE" -C "$APP_ROOT" data
find "$BACKUP_DIR" -type f -name 'nss-solar-v2-data-*.tar.gz' -mtime "+$KEEP_DAYS" -delete
echo "[$(date -Iseconds)] V2 data backup created: $BACKUP_FILE"
