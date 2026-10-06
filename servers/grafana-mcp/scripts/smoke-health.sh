#!/usr/bin/env bash
# Smoke-check sibling GET /health JSON without Docker (fake upstream).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/proxy"

tmpdir="$(mktemp -d)"
trap 'kill ${proxy_pid:-} ${upstream_pid:-} 2>/dev/null || true; rm -rf "$tmpdir"' EXIT

# Tiny upstream that only proves /mcp is reachable through the proxy.
python3 - <<'PY' &
from http.server import BaseHTTPRequestHandler, HTTPServer

class H(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        _ = self.rfile.read(length)
        body = b'{"proxied":true}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        return

HTTPServer(("127.0.0.1", 18001), H).serve_forever()
PY
upstream_pid=$!

go build -o "$tmpdir/grafana-health-proxy" .
"$tmpdir/grafana-health-proxy" \
  -listen 127.0.0.1:18000 \
  -upstream http://127.0.0.1:18001 \
  -service grafana-mcp \
  -version 1.1.0 &
proxy_pid=$!

for _ in $(seq 1 50); do
  if curl -fsS http://127.0.0.1:18000/health >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done

body="$(curl -fsS http://127.0.0.1:18000/health)"
code="$(curl -fsS -o /dev/null -w '%{http_code}' http://127.0.0.1:18000/health)"
echo "GET /health -> HTTP ${code} body=${body}"

python3 -c '
import json, sys
body = json.loads(sys.argv[1])
assert body == {"status": "ok", "service": "grafana-mcp", "version": "1.1.0"}, body
assert sys.argv[2] == "200", sys.argv[2]
print("health JSON OK")
' "$body" "$code"

proxied="$(curl -fsS -X POST http://127.0.0.1:18000/mcp -d '{}')"
echo "POST /mcp -> ${proxied}"
python3 -c 'import json,sys; assert json.loads(sys.argv[1])=={"proxied": True}' "$proxied"
echo "smoke-health OK"
