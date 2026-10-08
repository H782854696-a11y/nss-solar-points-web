#!/usr/bin/env bash
# Explicit administrator recovery only. It never resumes writes by default.
set -euo pipefail

if [[ "$#" -lt 2 || ( "$1" != inspect && "$1" != --confirm-resume-writes ) ]]; then
  echo "Usage: $0 inspect <app-root> | $0 --confirm-resume-writes <app-root>" >&2
  exit 2
fi

MODE="$1"
APP_ROOT="$2"
STATE_FILE="$APP_ROOT/release-history/active-deployment-state.json"
CURRENT_RELEASE="$(readlink -f "$APP_ROOT/current" 2>/dev/null || true)"
SAFETY="$CURRENT_RELEASE/deploy/release-safety.sh"

if [[ ! -f "$STATE_FILE" || -z "$CURRENT_RELEASE" || ! -x "$SAFETY" ]]; then
  echo "Recovery metadata is incomplete; keep writes disabled and investigate manually." >&2
  exit 3
fi

if [[ "$MODE" == inspect ]]; then
  cat "$STATE_FILE"
  echo "Writes remain disabled until an administrator explicitly runs --confirm-resume-writes after reviewing this record." >&2
  exit 0
fi

# This check is intentionally narrow. It only permits a human-confirmed resume
# after the recorded candidate completed a read-only health check and still
# matches the active release and JSON data compatibility floor.
bash "$SAFETY" can-resume-writes "$STATE_FILE" "$CURRENT_RELEASE" "$APP_ROOT/data"
pm2 delete solarpoints-v2
SP_DEPLOY_READ_ONLY=0 SP_DISABLE_BACKGROUND_JOBS=0 pm2 start "$APP_ROOT/ecosystem.v2.config.cjs" --update-env
if ! curl -fsS --max-time 4 http://127.0.0.1:3001/api/health | node -e 'let body=""; process.stdin.on("data", c => body += c); process.stdin.on("end", () => { try { process.exit(JSON.parse(body).ok === true ? 0 : 1); } catch { process.exit(1); } });'; then
  pm2 stop solarpoints-v2 || true
  echo "Normal-mode health check failed; writes remain disabled and manual investigation is required." >&2
  exit 4
fi
bash "$SAFETY" state "$STATE_FILE" normal_active "$CURRENT_RELEASE" "manual-resume" "$(bash "$SAFETY" contract "$CURRENT_RELEASE")" "" "administrator explicitly resumed writes"
pm2 save
echo "Writes resumed after explicit administrator confirmation."
