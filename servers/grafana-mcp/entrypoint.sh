#!/bin/sh
# Start upstream mcp-grafana on loopback, then expose :8000 with sibling GET /health.
set -eu

UPSTREAM_ADDR="${MCP_UPSTREAM_ADDR:-127.0.0.1:8001}"
LISTEN_ADDR="${MCP_LISTEN_ADDR:-0.0.0.0:8000}"
HEALTH_VERSION="${HEALTH_PROXY_VERSION:-1.1.0}"

cleanup() {
  if [ -n "${UPSTREAM_PID:-}" ]; then
    kill "${UPSTREAM_PID}" 2>/dev/null || true
  fi
  if [ -n "${PROXY_PID:-}" ]; then
    kill "${PROXY_PID}" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

# Upstream stays on loopback; the health proxy owns LISTEN_ADDR (:8000).
# --allowed-hosts "*" matches the previous compose command (nginx Host headers).
/app/mcp-grafana \
  -t streamable-http \
  --address "${UPSTREAM_ADDR}" \
  --allowed-hosts "*" &
UPSTREAM_PID=$!

/usr/local/bin/grafana-health-proxy \
  -listen "${LISTEN_ADDR}" \
  -upstream "http://${UPSTREAM_ADDR}" \
  -service grafana-mcp \
  -version "${HEALTH_VERSION}" &
PROXY_PID=$!

# Restart/exit if either child dies.
while kill -0 "${UPSTREAM_PID}" 2>/dev/null && kill -0 "${PROXY_PID}" 2>/dev/null; do
  sleep 1
done

exit 1
