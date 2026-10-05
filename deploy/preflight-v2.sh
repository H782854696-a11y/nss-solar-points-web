#!/usr/bin/env bash
# Read-only inventory before a V2 release. Prints no environment values or data contents.
set -euo pipefail

if [[ "$#" -ne 1 || ! "$1" =~ ^[A-Za-z0-9_.@-]+$ ]]; then
  echo "Usage: $0 ubuntu@<server-host>" >&2
  exit 2
fi

ssh -o BatchMode=yes -o StrictHostKeyChecking=yes "$1" 'bash -s' <<'REMOTE'
set -euo pipefail
APP_ROOT=/opt/solarpoints-v2
printf 'Server time: '; date -u +%Y-%m-%dT%H:%M:%SZ
printf 'Node.js: '; node --version 2>/dev/null || echo missing
printf 'npm: '; npm --version 2>/dev/null || echo missing
printf 'PM2: '; pm2 --version 2>/dev/null || echo missing
printf 'V2 root exists: '; [[ -d "$APP_ROOT" ]] && echo yes || echo no
printf 'V2 root writable: '; [[ -w "$APP_ROOT" ]] && echo yes || echo no
printf 'V2 data exists: '; [[ -d "$APP_ROOT/data" ]] && echo yes || echo no
printf 'V2 root server.js exists: '; [[ -f "$APP_ROOT/server.js" ]] && echo yes || echo no
printf 'V2 current release: '; readlink -f "$APP_ROOT/current" 2>/dev/null || echo absent
printf 'Legacy app exists: '; [[ -d /opt/solarpoints ]] && echo yes || echo no
printf 'V2 data permissions: '; stat -c '%a %U:%G' "$APP_ROOT/data" 2>/dev/null || echo unavailable
printf 'Free space (KiB): '; df -Pk /opt | awk 'NR == 2 {print $4}'
printf 'PM2 V2 PID: '; pm2 pid solarpoints-v2 2>/dev/null || echo unavailable
printf 'PM2 legacy PID: '; pm2 pid solarpoints 2>/dev/null || echo unavailable
printf 'Local V2 HTTP status: '; curl -sS -o /dev/null -w '%{http_code}\n' --max-time 5 http://127.0.0.1:3001/ || echo unreachable
printf 'Local legacy HTTP status: '; curl -sS -o /dev/null -w '%{http_code}\n' --max-time 5 http://127.0.0.1:3000/ || echo unreachable
printf 'Local V2 frontend version: '; curl -fsS --max-time 5 http://127.0.0.1:3001/ | sed -n 's/.*app\.js?v=\([0-9][0-9]*\).*/\1/p' | head -1 || echo unavailable
REMOTE
