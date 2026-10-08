#!/usr/bin/env bash
# Back up V2's independent persistent data; never reads or writes the legacy
# member-points database in /opt/solarpoints.
set -euo pipefail
APP_ROOT="/opt/solarpoints-v2"
DATA_DIR="$APP_ROOT/data"
BACKUP_DIR="$APP_ROOT/backups"
DATE_STR="$(date -u +%Y%m%dT%H%M%SZ)"

if [[ ! -d "$DATA_DIR" ]]; then
  echo "V2 data directory does not exist; refusing to create an empty backup." >&2
  exit 2
fi
umask 077
mkdir -p "$BACKUP_DIR"
BACKUP_FILE="$BACKUP_DIR/nss-solar-v2-data-$DATE_STR.tar.gz"
if [[ -e "$BACKUP_FILE" ]]; then
  echo "Backup name already exists; refusing to overwrite it." >&2
  exit 2
fi
tar -czf "$BACKUP_FILE" -C "$APP_ROOT" data
if [[ ! -s "$BACKUP_FILE" ]] || ! tar -tzf "$BACKUP_FILE" >/dev/null; then
  echo "Backup verification failed." >&2
  exit 3
fi
SHA256="$(shasum -a 256 "$BACKUP_FILE" | awk '{print $1}')"
printf '%s  %s\n' "$SHA256" "$(basename "$BACKUP_FILE")" > "${BACKUP_FILE}.sha256"
echo "[$(date -Iseconds)] V2 data backup created and verified: $BACKUP_FILE"
echo "SHA-256: $SHA256"
