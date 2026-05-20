#!/usr/bin/env bash

# Toggle MeshInfo maintenance mode.
#
# When enabled, Caddy serves public/maintenance/index.html (HTTP 503) for
# every request instead of proxying to the app — useful while taking the
# backend or database down for an upgrade.
#
# Caddy checks the flag file per-request, so on/off takes effect on the
# very next request. No `caddy reload` or container restart is needed.
#
# Usage:
#   scripts/maintenance.sh on        # show the maintenance page
#   scripts/maintenance.sh off       # back to normal
#   scripts/maintenance.sh status    # report current state (default)

set -euo pipefail

# Flag file lives in the dir bind-mounted into the caddy container.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FLAG="$REPO_ROOT/public/maintenance/ON"

case "${1:-status}" in
  on)
    touch "$FLAG"
    printf '\xF0\x9F\x9B\xA0  Maintenance mode ENABLED — visitors now see the maintenance page.\n'
    ;;
  off)
    rm -f "$FLAG"
    printf '\xE2\x9C\x85 Maintenance mode DISABLED — site is live.\n'
    ;;
  status)
    if [ -e "$FLAG" ]; then
      printf '\xF0\x9F\x9B\xA0  Maintenance mode is ON\n'
    else
      printf '\xE2\x9C\x85 Maintenance mode is OFF\n'
    fi
    ;;
  *)
    echo "Usage: $0 [on|off|status]" >&2
    exit 1
    ;;
esac
