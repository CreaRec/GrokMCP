# Utilities MCP

A read-only Model Context Protocol (MCP) server that exposes utility data from the existing [CreaDashboard](https://github.com/CreaRec/CreaDashboard) REST API. Grok Bot can compare billed months and inspect daily water usage without scraping utility portals or reimplementing dashboard sync.

## Tools

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

### `water_daily`

Fetches `GET {DASHBOARD_API_URL}/api/water/daily?date=YYYY-MM-DD` (month anchor; omit `date` on the dashboard for the current month). This server always passes a month-start anchor per intersecting month.

Returns daily gallons plus sync meta:

- `readings`: `{ date, gallons }[]` within the requested range
- `unit`, `connected`, `syncStatus`, `syncError`
- `range`: `{ start, end }` as YYYY-MM-DD
- `total_gallons`: sum of included readings

Date arguments are mutually exclusive styles:

| Parameters | Description |
|------------|-------------|
| *(none)* | Current calendar month in `USER_TIMEZONE` (default `America/Chicago`) |
| `month` | Single month `YYYY-MM` |
| `start` + `end` | Inclusive range `YYYY-MM-DD`…`YYYY-MM-DD` (may span months) |

Multi-month ranges call `/api/water/daily` once per intersecting month, concatenate readings, drop dates outside `start`…`end`, and dedupe by date.

## Environment

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DASHBOARD_API_URL` | Yes | — | CreaDashboard base URL (no trailing path), e.g. `http://192.168.1.135:3080` |
| `DASHBOARD_API_TIMEOUT_MS` | No | `10000` | HTTP timeout for dashboard requests |
| `USER_TIMEZONE` | No | `America/Chicago` | Timezone for month labels and the default `water_daily` month |
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
