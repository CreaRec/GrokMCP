# Findvid MCP

Automates **Findvid VIP** Telegram search UX (inline search → озвучка → quality) and **forwards** the final video/document message to **CreaVideoDownloaderBot**. This MCP does **not** download multi‑GB files — the existing downloader bot still performs GramJS downloads.

## Important caveats

- Findvid **VIP**, rate-limits, and **UI/button label changes** can break button automation.
- Prefer the same GramJS user session already used by CreaVideoDownloaderBot (no second login).
- Never commit `settings.json`, string sessions, or API secrets.

## Agent tool flow

1. `search` `{ query }` — inline search via `@fvidBot` (configurable). Returns **best match** + short alternatives. Show this to Nikita.
2. On OK → `confirm_and_forward` (optional `voiceover` / `quality` / `resultId`). Defaults prefer **«Дублированный»** then **1080p**.
3. Optional browse tools: `list_voiceovers`, `list_qualities` if you want Nikita to pick before confirm.

## Tools

| Tool | Purpose |
|------|---------|
| `search` | `messages.getInlineBotResults` against Findvid; persist query/result ids |
| `list_voiceovers` | Send/select match; return озвучки buttons |
| `list_qualities` | Select voiceover; return quality buttons |
| `confirm_and_forward` | Drive defaults/overrides → wait for final video → **forward** to downloader bot |

Return shape is always JSON text: `{ ok: true, data }` / `{ ok: false, error }`.

## Environment

| Variable | Description |
|----------|-------------|
| `TELEGRAM_SETTINGS_PATH` | Path to downloader `config/settings.json` (optional) |
| `TELEGRAM_USER_ID` | Key in `telegram.userSessions` when using settings file |
| `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` | GramJS API credentials (or from settings) |
| `TELEGRAM_SESSION` | GramJS string session (or from settings) |
| `FINDVID_BOT_USERNAME` | Chat peer bot (default `fvidBot`) |
| `FINDVID_INLINE_BOT_USERNAME` | Inline search bot (default = findvid bot; e.g. `fvid_try_bot`) |
| `DOWNLOADER_BOT_USERNAME` | CreaVideoDownloaderBot username without `@` |
| `FINDVID_PREFERRED_VOICEOVER` | Default `Дублированный` |
| `FINDVID_PREFERRED_QUALITIES` | Comma list, default `1080p,720p,480p` |
| `PORT` | HTTP port (default **8800**) |

### Debian deploy (reuse downloader settings)

On the host, either:

```sh
# Mount/copy the existing downloader settings (read-only is fine)
TELEGRAM_SETTINGS_PATH=/home/crearec/crea-video-downloader-bot/config/settings.json
TELEGRAM_USER_ID=YOUR_TELEGRAM_USER_ID
FINDVID_BOT_USERNAME=fvidBot
# DOWNLOADER_BOT_USERNAME is read from settings.telegram.botUsername when unset
```

or export the same fields into `/home/crearec/grok-mcp/.env`:

```sh
TELEGRAM_API_ID=...
TELEGRAM_API_HASH=...
TELEGRAM_SESSION=...
DOWNLOADER_BOT_USERNAME=your_downloader_bot
```

Compose can bind-mount the downloader **config directory** via `FINDVID_SETTINGS_HOST_DIR` (default `/home/crearec/crea-video-downloader-bot/config`; see root `docs/deploy.md`).

## Development

```bash
cp .env.example .env
# set NODE_AUTH_TOKEN for @crearec/otel (GitHub Packages)
npm ci
npm test
npm run dev:http
curl -sS http://127.0.0.1:8800/health
```

### Example MCP tool call (HTTP)

After initialize, call tools via your MCP client. Conceptual args:

```json
{ "name": "search", "arguments": { "query": "Девушка с татуировкой дракона" } }
```

```json
{ "name": "confirm_and_forward", "arguments": { "voiceover": "Дублированный", "quality": "1080p" } }
```

## Production

See **[docs/deploy.md](../../docs/deploy.md)** — image `ghcr.io/crearec/grok-mcp-findvid`, port **8800**, path `/mcp/findvid`.

## License

MIT
