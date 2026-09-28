#!/bin/sh
set -e

# Run the idempotent DB bootstrap before starting the server. It only creates
# missing tables/columns and seeds the owner license — it never drops or clears
# data, so it is safe to run on every (re)start and every code update.
if [ -f ./scripts/bootstrap-db.mjs ]; then
  echo "[entrypoint] Running database bootstrap..."
  node ./scripts/bootstrap-db.mjs
else
  echo "[entrypoint] WARNING: scripts/bootstrap-db.mjs not found, skipping bootstrap."
fi

# Start the uTLS fingerprint sidecar (tls-proxy/) on loopback before the app.
# Node routes all Instagram traffic through it via TLS_PROXY_URL so the JA4 /
# HTTP/2 fingerprint matches a real iPhone. If a captured fingerprint file is
# mounted at /data/fingerprints.json it is used for a byte-exact JA4; otherwise
# the sidecar falls back to its built-in placeholder profile.
if [ -x ./igtlsproxy ]; then
  TLS_PROXY_LISTEN="${TLS_PROXY_LISTEN:-127.0.0.1:8443}"
  export TLS_PROXY_LISTEN
  if [ -z "${TLS_PROXY_FINGERPRINTS:-}" ] && [ -f /data/fingerprints.json ]; then
    export TLS_PROXY_FINGERPRINTS=/data/fingerprints.json
  fi
  echo "[entrypoint] Starting uTLS sidecar on ${TLS_PROXY_LISTEN}..."
  ./igtlsproxy &
  # Point the Node app at the sidecar unless the operator overrode it.
  export TLS_PROXY_URL="${TLS_PROXY_URL:-http://${TLS_PROXY_LISTEN}}"
  # Give the listener a moment to bind before the app makes its first request.
  sleep 1
else
  echo "[entrypoint] WARNING: igtlsproxy binary not found; running WITHOUT TLS fingerprint sidecar (Node JA3/JA4 will be exposed)."
fi

# Start the FastAPI Instagram request service (backend/) on loopback. It is
# launched AFTER the sidecar so it inherits TLS_PROXY_URL and egresses all
# Instagram traffic through the same iPhone-shaped JA4. Next.js talks to it via
# IG_SERVICE_URL. If the venv/app is missing we skip it and the Node app falls
# back to its in-process TypeScript client (USE_PYTHON_IG=0 forces that too).
IG_PY_VENV="${IG_PY_VENV:-/opt/ig-backend-venv}"
if [ -x "${IG_PY_VENV}/bin/uvicorn" ] && [ -f ./backend/app/main.py ]; then
  IG_SERVICE_HOST="${IG_SERVICE_HOST:-127.0.0.1}"
  IG_SERVICE_PORT="${IG_SERVICE_PORT:-8000}"
  echo "[entrypoint] Starting FastAPI IG service on ${IG_SERVICE_HOST}:${IG_SERVICE_PORT}..."
  ( cd ./backend && exec "${IG_PY_VENV}/bin/uvicorn" app.main:app \
      --host "${IG_SERVICE_HOST}" --port "${IG_SERVICE_PORT}" --log-level info ) &
  # Expose the service URL to the Node app unless the operator overrode it.
  export IG_SERVICE_URL="${IG_SERVICE_URL:-http://${IG_SERVICE_HOST}:${IG_SERVICE_PORT}}"
  sleep 1
else
  echo "[entrypoint] FastAPI IG service not found; Node will use its in-process TypeScript client."
fi

echo "[entrypoint] Starting server: $*"
exec "$@"
