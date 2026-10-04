#!/usr/bin/env bash
# Backwards-compatible entry point. This project publishes V2 only and keeps
# the legacy member-points installation at /opt/solarpoints untouched.
set -euo pipefail
exec "$(cd "$(dirname "$0")" && pwd)/deploy-v2.sh" "$@"
