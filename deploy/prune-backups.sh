#!/usr/bin/env bash
# Retention is deliberately a separate, explicit administrator operation.
set -euo pipefail

if [[ "$#" != 3 || "$1" != "--confirm-prune" || ! "$2" =~ ^[0-9]+$ || "$2" -lt 1 || ! -d "$3" ]]; then
  echo "Usage: $0 --confirm-prune <keep-days>=1+ <backup-directory>" >&2
  exit 2
fi
find "$3" -type f -name 'nss-solar-v2-data-*.tar.gz' -mtime "+$2" -print -delete
