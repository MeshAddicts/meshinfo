#!/bin/sh
set -e

cat > /srv/env-config.js << EOF
// Generated at container startup by docker-entrypoint.sh
window.__env__ = {
  "VITE_API_BASE_URL": "${VITE_API_BASE_URL:-}",
  "VITE_MAP_PROVIDER": "${VITE_MAP_PROVIDER:-}",
  "VITE_MAPBOX_TOKEN": "${VITE_MAPBOX_TOKEN:-}",
  "VITE_MAPBOX_STYLE": "${VITE_MAPBOX_STYLE:-}",
  "VITE_GEOCODER_PROVIDER": "${VITE_GEOCODER_PROVIDER:-}",
  "VITE_MAPBOX_GEOCODER_COUNTRY": "${VITE_MAPBOX_GEOCODER_COUNTRY:-}",
  "VITE_MAPBOX_GEOCODER_LANGUAGE": "${VITE_MAPBOX_GEOCODER_LANGUAGE:-}",
  "VITE_NOMINATIM_EMAIL": "${VITE_NOMINATIM_EMAIL:-}"
};
EOF

exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
