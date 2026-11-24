# Telegram search MCP

Search-only Model Context Protocol server over the owner's local tg-search API (CRE-31). There is no `ask` / LLM: the tool returns matching chat fragments with Telegram links. The archive never leaves the home server; this service only calls `http://100.118.169.52:8787` on the Tailscale IP.

## Tools

### `telegram_search`

Calls `POST {TG_SEARCH_API_URL}/search` with bearer auth and returns hits:

- `chat_title`, `chat_type`, `ts_start` / `ts_end`
- `senders`, `snippet`
- per-message `date`, `sender`, `message_link`, `chat_link`, and `link_kind` (`message` / `chat` / `none`)

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | string | required | Search query |
| `chat_ids` | string[] or number[] | — | Optional chat id filter |
| `from` | string | — | Inclusive start date (`YYYY-MM-DD` or ISO) |
| `to` | string | — | Inclusive end date (`YYYY-MM-DD` or ISO) |
| `limit` | integer | 10 | Max hits (1–50) |

## Environment

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TG_SEARCH_API_URL` | no | `http://100.118.169.52:8787` | tg-search API base URL (no trailing path) |
| `TG_SEARCH_API_TOKEN` | yes | — | Bearer token; keep on the server, never commit |
| `TG_SEARCH_API_TIMEOUT_MS` | no | `30000` | HTTP timeout |
| `PORT` | no | `8798` | HTTP listen port |
| `HOST` | no | `0.0.0.0` | HTTP bind address |

OpenTelemetry variables match other GrokMCP servers (`OTEL_EXPORTER_OTLP_ENDPOINT`, etc.). Logs never include the token, query text, or snippets.

## Development

```bash
cp .env.example .env
npm install
npm test
npm run dev:http
curl -sS http://127.0.0.1:8798/health
```

## Production

See [docs/deploy.md](../../docs/deploy.md). Public endpoint (once nginx is routed): `https://crearec.app/mcp/telegram`. Host port **8798**.
