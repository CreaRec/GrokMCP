# Print MCP

Home Model Context Protocol (MCP) server that submits print jobs to the household **HP LaserJet Tank 2504dw** through host CUPS (`lp` / `lpstat`). Intended for **Nikita’s agents** (Jarvis / Grok Bot) on the same Tailscale network as `debian-server`.

**Sergey / Pizduk must not get this MCP** — do not auto-wire it into their agent configs. Connect it only for Nikita’s home agents (same policy as other home-only MCPs such as utilities).

**No autopilot print.** The server never prints on its own; a job is submitted only when an agent explicitly calls `print_file`.

## Tools

### `print_file`

Submit one file to CUPS via `lp` (no shell; argv only). Returns JSON `{ ok, jobId?, printer?, error? }`.

Provide **exactly one** source:

| Source | Use when |
|--------|----------|
| `path` | Absolute path **under** `PRINT_SPOOL_DIR` on the debian host (path-jailed; preferred) |
| `url` | `http`/`https` URL — downloaded into the spool, then printed |
| `contentBase64` | Base64 bytes — written into the spool, then printed |

Supported types: **PDF, PNG, JPG/JPEG**.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `path` | string | — | Absolute path inside the spool jail |
| `url` | string | — | Remote file to download |
| `contentBase64` | string | — | Base64 file content |
| `filename` | string | inferred | Filename (with extension) for `url` / `contentBase64` |
| `copies` | integer | `1` | Copies (`1`–`100`) |
| `sides` / `duplex` | enum | unset | `one-sided` \| `two-sided-long-edge` \| `two-sided-short-edge` |
| `printer` | string | `CUPS_PRINTER` / `DEFAULT_PRINTER` | CUPS queue name |

### `list_printers`

Runs `lpstat -p -d` and returns `{ ok, defaultPrinter?, printers?, error? }`. Does not print.

## Environment

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `CUPS_SERVER` | Recommended | `127.0.0.1:631` (compose) | Host cupsd address. Production compose uses `network_mode: host` because cupsd is localhost-only. |
| `CUPS_PRINTER` / `DEFAULT_PRINTER` | Recommended | — | Default queue (e.g. `HP_LaserJet_Tank_2504dw`) |
| `PRINT_SPOOL_DIR` | No | `/var/tmp/print-mcp` | Path jail + temp download/upload root |
| `PRINT_DOWNLOAD_TIMEOUT_MS` | No | `30000` | URL download timeout |
| `PRINT_MAX_DOWNLOAD_BYTES` | No | `52428800` | Max URL / download size |
| `PORT` | No | `8797` | HTTP listen port |
| `HOST` | No | `0.0.0.0` | HTTP bind address |

OpenTelemetry variables match other GrokMCP servers (`OTEL_EXPORTER_OTLP_ENDPOINT`, etc.).

## Debian host setup (CUPS + HP LaserJet Tank 2504dw)

On `debian-server` (where the compose stack runs):

```sh
sudo apt-get update
sudo apt-get install -y cups cups-client printer-driver-hpcups  # or IPP Everywhere / foomatic as needed
sudo systemctl enable --now cups

# cupsd on debian-server typically listens only on 127.0.0.1:631.
# Do not open cupsd to the Docker bridge for this stack — compose uses
# network_mode: host so lp talks to localhost CUPS instead.
```

Add the printer queue (IPP Everywhere is often enough for this model):

```sh
# Discover or add by URI — adjust IP/hostname to the printer on LAN/Tailscale
lpinfo -v
sudo lpadmin -p HP_LaserJet_Tank_2504dw -E -v ipp://<printer-ip>/ipp/print -m everywhere
sudo lpoptions -d HP_LaserJet_Tank_2504dw
```

Smoke test on the host:

```sh
lpstat -p -d
lp -d HP_LaserJet_Tank_2504dw /usr/share/cups/data/testprint
# or: lp -d HP_LaserJet_Tank_2504dw /path/to/sample.pdf
```

Create the spool directory (compose bind-mounts this into the container):

```sh
sudo mkdir -p /home/crearec/print-spool
sudo chown crearec:crearec /home/crearec/print-spool
# Agents / users drop files here, then call print_file with path=/var/tmp/print-mcp/<name>
```

Point the container at **host** cupsd (do not run cupsd inside the print MCP image). Production compose sets `network_mode: host` and defaults `CUPS_SERVER` to localhost:

```sh
# In /home/crearec/grok-mcp/.env
CUPS_SERVER=127.0.0.1:631
CUPS_PRINTER=HP_LaserJet_Tank_2504dw
PRINT_SPOOL_DIR=/var/tmp/print-mcp
```

**Why host networking:** bridge networks cannot reach a localhost-only cupsd (`lpstat: Scheduler is not running`). With `network_mode: host`, `lp` / `lpstat` use `127.0.0.1:631`. The MCP still binds **8797** on the host; Tailscale reaches `host:8797`. Spool volume mount is unchanged. After deploy:

```sh
docker exec grok-mcp-print lpstat -p -d
```

## Development

```bash
cp .env.example .env
npm install
npm test
npm run build
npm run dev:http
curl -sS http://127.0.0.1:8797/health
```

Stdio mode for local MCP clients: `npm run dev`.

## Production / Grok Bot connect

Compose service `print` uses `network_mode: host` and binds **8797** on the host (avoids colliding with CreaParks; no `ports:` mapping). HTTP path matches siblings: `/mcp` (streamable HTTP) and `/health`.

From Tailscale (Nikita’s agents only):

```json
{
  "mcpServers": {
    "print": {
      "url": "http://<debian-server-tailscale-ip>:8797/mcp"
    }
  }
}
```

Or via mcp-remote / Cursor pointing at the same URL. Optional nginx: `https://crearec.app/mcp/print` → `http://127.0.0.1:8797/mcp` (see [docs/deploy.md](../../docs/deploy.md)).

Image: `ghcr.io/crearec/grok-mcp-print:main`

## License

MIT
