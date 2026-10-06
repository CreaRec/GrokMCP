# Grafana MCP (health wrapper)

Wraps the official [`grafana/mcp-grafana:1.1.0`](https://hub.docker.com/r/grafana/mcp-grafana) image so this stack’s published port exposes the same `GET /health` contract as the other grok-mcp services.

Upstream only serves `/healthz` (plain `ok`). Sibling MCP servers return JSON on `/health`, so this image:

1. Runs `mcp-grafana` on `127.0.0.1:8001`
2. Listens on `0.0.0.0:8000` with a tiny reverse proxy
3. Answers `GET /health` with `{"status":"ok","service":"grafana-mcp","version":"1.1.0"}`
4. Proxies every other path (including `/mcp`) to upstream

## Local checks

```sh
cd servers/grafana-mcp/proxy
go test ./...
```

Smoke against a running container (host port **8793**):

```sh
curl -sS -o /tmp/grafana-health.json -w "%{http_code}\n" http://127.0.0.1:8793/health
# expect 200 and JSON status=ok
```
