# SimpleFIN MCP

A read-only Model Context Protocol (MCP) server that exposes [SimpleFIN Bridge](https://bridge.simplefin.org) account balances and transactions to Grok Bot / Money Tracker / Jarvis — without scraping banks.

Protocol: [simplefin.org/protocol.html](https://www.simplefin.org/protocol.html) (prefer `version=2`).

## Rate limits

SimpleFIN Bridge expects on the order of **≤ ~24 requests/day** per Access URL. Tools call the API directly; callers should cache results and avoid polling.

## Tools

### `list_accounts`

`GET {ACCESS_URL}/accounts?version=2&balances-only=1`

Returns:

- `id`, `name`, `currency`, `balance`, `available-balance`, `balance-date` (ISO-8601)
- `org.name`, `org.domain`
- Top-level `errors` / `errlist` from SimpleFIN when present

No required arguments.

### `get_transactions`

`GET {ACCESS_URL}/accounts?version=2&start-date=…&end-date=…` (+ optional `account`, `pending=1`)

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `start` | string | Yes | YYYY-MM-DD; America/Chicago midnight → Unix `start-date` (inclusive) |
| `end` | string | Yes | YYYY-MM-DD; America/Chicago midnight → Unix `end-date` (exclusive). Max **90 days** after `start`. |
| `account` | string \| string[] | No | Filter by account id (repeatable) |
| `pending` | boolean | No | When true, sends `pending=1` |

Returns flattened transactions: `id`, `posted` (ISO or `null` if 0/pending), `amount`, `description`, `payee`, `memo`, `account_id`, `account_name`.

## Environment

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SIMPLEFIN_ACCESS_URL` | Yes | — | Full Access URL from Bridge claim (embeds Basic Auth). Never log or commit the real value. |
| `SIMPLEFIN_TIMEOUT_MS` | No | `15000` | HTTP timeout for SimpleFIN requests |
| `USER_TIMEZONE` | No | `America/Chicago` | Timezone for start/end day bounds |
| `PORT` | No | `8798` | HTTP listen port |
| `HOST` | No | `0.0.0.0` | HTTP bind address |

OpenTelemetry variables match other GrokMCP servers (`OTEL_EXPORTER_OTLP_ENDPOINT`, etc.).

## Development

```bash
cp .env.example .env
# Put a real Access URL in .env locally — never commit it
npm install
npm test
npm run dev:http
curl -sS http://127.0.0.1:8798/health
```

## Production

See [docs/deploy.md](../../docs/deploy.md) for Docker Compose deployment, nginx reverse proxy (`https://crearec.app/mcp/simplefin` → `127.0.0.1:8798/mcp`), and Grok Bot connection.

## License

MIT
