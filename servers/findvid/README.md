# Findvid MCP

Automates **Findvid VIP** Telegram search UX (inline search → озвучка → quality) and **forwards** the final video/document message to **CreaVideoDownloaderBot**. This MCP does **not** download multi‑GB files — the existing downloader bot still performs GramJS downloads.

## Important caveats

- Findvid **VIP**, rate-limits, and **UI/button label changes** can break button automation.
- Prefer the same GramJS user session already used by CreaVideoDownloaderBot (no second login).
- Never commit `settings.json`, string sessions, or API secrets.

## Agent tool flow

Findvid’s movie card uses a **two-level menu**:
1. **Chrome** — top-level actions including `🎶 Озвучка` and `🔮 Качество` (menu openers, **not** voiceover/quality names).
2. **Nested lists** — only after clicking those openers do real озвучки (Back Board Cinema, Дублированный, …) or qualities (1080p/720p/…) appear.

Do **not** confuse the sticky bot-home **reply keyboard** (`Подборки`, `Фильтр`, `Настройки`, `VIP`, `Результат поиска`) with озвучки — those are ignored and recovered from when selecting a match.

**Critical:** `Озвучка` / `Качество` / studio / quality picks are **inline callback clicks** (`GetBotCallbackAnswer` / GramJS `Message.click`). The MCP must never send those labels as chat text messages. Callback payloads are kept as **opaque bytes** (no UTF-8 round-trip).

**Flood waits:** GetHistory polling backs off on `FLOOD_WAIT` (serves a short cache, extends the wait budget by flood-sleep time) instead of hammering every ~1.5s.

**Post-Озвучка:** Real озвучки may arrive on a **new message** (not only an in-place chrome edit). Keyboards that are only `Вернуться` / `Скрыть` are treated as a nav dead-end (fail fast), not waited out for the full timeout.

**Fresh card every request:** `list_voiceovers` always `SendInlineBotResult` for the selected `resultId` — it does **not** reuse preexisting movie cards from chat history (avoids wrong-film steal and collapsed-card confusion). After that fresh card is on screen for *this* request, only inline callback clicks (no `sendMessage` / re-send of labels).

Preferred agent flow:

1. `search` `{ query }` — inline search. Returns **best match** + short alternatives. Show this to the user.
2. `list_voiceovers` — **always** sends a fresh inline result for the match (ignores old history cards), opens `Озвучка` if still on chrome, returns **real** озвучки labels.
3. Show озвучки to the user → on pick, `list_qualities` `{ voiceover }` — clicks that озвучка and waits for a **new message** with 1080p/720p/… (post-voiceover preview media is **not** the film).
4. Agent auto-picks the **maximum** quality (no second user confirm) → `confirm_and_forward` `{ voiceover, quality }` immediately — quality click yields the real film message, which is forwarded to the downloader bot.

Do **not** ask the user to confirm quality or forward again after the voiceover pick. Do **not** treat media that appears right after the voiceover click as downloadable — qualities come first.

Shortcuts: after search you may still call `confirm_and_forward` with optional overrides (defaults prefer **«Дублированный»** then **1080p**). It still opens chrome submenus and requires the quality step before forwarding.

Do **not** treat `Озвучка` / `Качество` / `Уведомлять` / `Поиск` / guide labels as selectable озвучки or qualities.

## Tools

| Tool | Purpose |
|------|---------|
| `search` | `messages.getInlineBotResults` against Findvid; persist query/result ids |
| `list_voiceovers` | Always `SendInlineBotResult` (fresh card); open `Озвучка`; return озвучки |
| `list_qualities` | Select voiceover; wait for **new** quality message (not film preview); return Nx p |
| `confirm_and_forward` | Quality click → wait for film (not post-voiceover preview) → **forward** |

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
