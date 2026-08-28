# Utilities MCP

A read-only Model Context Protocol (MCP) server that exposes monthly utility bills from the existing [CreaDashboard](https://github.com/CreaRec/CreaDashboard) REST API. Grok Bot can compare the latest billed month to the previous month for electricity, water, and gas without scraping utility portals or reimplementing dashboard sync.

## Tool

### `utility_bills`

Fetches `GET {DASHBOARD_API_URL}/api/utilities` and returns:

- `connected`, `label`, `currency`, `unit` per utility
- Latest vs previous **billed** month (cost + consumption when available)
- Absolute and percent cost delta
- `latest_unbilled: true` when the newest month has no bill yet but older bills exist
- Optional `history` array (2–6 billed months)

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `months` | integer | 2 | Billed months to include in `history` (2–6). Comparison always uses the two most recent billed months. |

## Environment

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DASHBOARD_API_URL` | Yes | — | CreaDashboard base URL (no trailing path), e.g. `http://192.168.1.135:3080` |
| `DASHBOARD_API_TIMEOUT_MS` | No | `10000` | HTTP timeout for dashboard requests |
| `USER_TIMEZONE` | No | `America/Chicago` | Timezone for month labels |
| `PORT` | No | `8795` | HTTP listen port |
| `HOST` | No | `0.0.0.0` | HTTP bind address |

OpenTelemetry variables match other GrokMCP servers (`OTEL_EXPORTER_OTLP_ENDPOINT`, etc.).

## Development

```bash
cp .env.example .env
npm install
npm test
npm run dev:http
curl -sS http://127.0.0.1:8795/health
```

## Production

See [docs/deploy.md](../../docs/deploy.md) for Docker Compose deployment, nginx reverse proxy (`https://crearec.app/mcp/utilities`), and Grok Bot connection.

## License

MIT
