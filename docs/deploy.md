# Docker + GHCR Deployment

Production runs as a Docker Compose stack. Images come from GitHub Container Registry (GHCR). Releases happen only through GitHub Actions when changes land on `main`. There is no local deploy script.

| Image | Service |
|-------|---------|
| `ghcr.io/crearec/grok-mcp-apple-calendar` | `apple-calendar` |
| `grafana/mcp-grafana` (Docker Hub) | `grafana-mcp` |
| `pgvector/pgvector:0.8.6-pg16` (Docker Hub) | `synology-db` |

Deploy directory: `/home/crearec/grok-mcp`

## How a release works

1. Merge or push to `main`.
2. Actions runs tests and builds changed images.
3. **Path filters** decide what publishes:
   - `servers/apple-calendar/**` → push `grok-mcp-apple-calendar` (`:main` + `:sha-<short>`)
   - `docker-compose.yml` alone → redeploy without rebuilding images
4. Actions copies `docker-compose.yml` to the server, exports **only** the image tag published in that run (`IMAGE_TAG`), then `docker compose pull && docker compose up -d`.
5. After a successful image publish, `ghcr_cleanup` keeps the **10** newest `sha-*` tags per package, always preserves `:main`, and deletes untagged/orphaned manifests.

App secrets stay on the server in `.env`. CI never mutates `.env` and never commits secrets.

## One-time server bootstrap

Use the same Linux user that already runs Docker (`crearec`).

### 1. GitHub / GHCR

After the first successful publish job:

1. Open the `grok-mcp-apple-calendar` package under your GitHub user/org.
2. Link it to the `GrokMCP` repository if needed.
3. Keep the package **Private**.
4. Under **Package settings → Manage Actions access**, grant the `GrokMCP` repository **Admin** (required for `ghcr_cleanup` to delete old versions with `GITHUB_TOKEN`).
5. Ensure the server can pull private GHCR images (same `docker login ghcr.io` used for other bots is fine).

### 2. Deploy directory

```sh
mkdir -p /home/crearec/grok-mcp
cd /home/crearec/grok-mcp
```

Create `.env` (never commit it). Copy from the repo `.env.example` and fill in real values:

```sh
IMAGE=ghcr.io/crearec/grok-mcp-apple-calendar
IMAGE_TAG=main

ICLOUD_CALDAV_USERNAME=your-icloud-email@icloud.com
ICLOUD_CALDAV_PASSWORD=xxxx-xxxx-xxxx-xxxx
ICLOUD_CALDAV_CALENDAR_URL=https://caldav.icloud.com/YOUR_USER_ID/calendars/YOUR_CALENDAR/
USER_TIMEZONE=America/Chicago
```

`PORT` and `HOST` have defaults in the container and are not required in `.env`.

#### Grafana MCP

The `grafana-mcp` service uses the official [Grafana MCP image](https://grafana.com/docs/grafana/latest/developer-resources/mcp/) from Docker Hub. It connects to your existing CreaGrafana instance on the `lgtm` Docker network.

Add these variables to `.env`:

```sh
# Grafana URL as seen from this container (on the lgtm network)
GRAFANA_URL=http://grafana:3000

# Service account token (create in Grafana: Configuration → Service accounts)
# Viewer role is sufficient for read-only queries
GRAFANA_SERVICE_ACCOUNT_TOKEN=glsa_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

**Optional caller authentication:** `MCP_GRAFANA_SERVER_TOKEN` can require callers to pass a Bearer token. If you want this, add `MCP_GRAFANA_SERVER_TOKEN=your-caller-auth-token` to `.env`. Do **not** add it to `docker-compose.yml`—environment entries with empty values (e.g., `${MCP_GRAFANA_SERVER_TOKEN:-}`) cause mcp-grafana to reject all requests. Omit it from compose entirely and only set it in `.env` when needed.

To create the service account token:

1. In Grafana, go to **Administration → Users and access → Service accounts**
2. Click **Add service account**, name it (e.g., `mcp-reader`), set role to **Viewer**
3. Click **Add service account token**, copy the `glsa_...` token
4. Paste the token as `GRAFANA_SERVICE_ACCOUNT_TOKEN` in `/home/crearec/grok-mcp/.env`

#### Synology DB

The `synology-db` service is a PostgreSQL + pgvector database for the Synology MCP. It stores labels, share URLs, and embeddings for semantic search—**never** file bytes or share passwords.

Add these variables to `.env`:

```sh
# PostgreSQL credentials (required for synology-db to start)
SYNOLOGY_DB_USER=synology
SYNOLOGY_DB_PASSWORD=your_strong_random_password
SYNOLOGY_DB_NAME=synology

# Prisma DATABASE_URL (for running migrations)
DATABASE_URL=postgresql://synology:your_strong_random_password@127.0.0.1:5434/synology
```

**Important:** The `synology-db` container will fail to start if `SYNOLOGY_DB_PASSWORD` is empty or missing. Set these variables in `.env` before starting the stack.

The database binds only to `127.0.0.1:5434` (not exposed externally). The Synology MCP service will connect via the Docker network.

**Data policy:** Descriptions may include names/addresses; must **never** include passport numbers, SSN, bank account numbers, or driver's license numbers.

#### Initialize the Synology DB schema (after first start)

After `synology-db` is running, apply Prisma migrations to create the tables:

```sh
cd /home/crearec/grok-mcp
git clone https://github.com/CreaRec/GrokMCP.git --depth 1 /tmp/grok-mcp-schema
cd /tmp/grok-mcp-schema/servers/synology
npm install
DATABASE_URL="postgresql://synology:YOUR_PASSWORD@127.0.0.1:5434/synology" npx prisma migrate deploy
rm -rf /tmp/grok-mcp-schema
```

Or if you have the repo already checked out:

```sh
cd /path/to/GrokMCP/servers/synology
npm install
npx prisma migrate deploy  # uses DATABASE_URL from .env or environment
```

### 3. First start

Either merge to `main` and let Actions deploy, or:

```sh
cd /home/crearec/grok-mcp
docker compose pull
docker compose up -d
```

Then:

```sh
docker compose ps
docker compose logs -f apple-calendar
curl -sS http://127.0.0.1:8792/health
```

**Do not** place `docker-compose.override.yml` in the deploy directory. CI copies only `docker-compose.yml`.

### 4. Connect Grok Bot / Cursor

Add the MCP servers with URLs:

```json
{
  "mcpServers": {
    "apple-calendar": {
      "url": "http://<DEPLOY_HOST>:8792/mcp"
    },
    "grafana": {
      "url": "http://<DEPLOY_HOST>:8793/mcp"
    }
  }
}
```

Or behind an nginx reverse proxy:

```json
{
  "mcpServers": {
    "apple-calendar": {
      "url": "https://crearec.app/mcp/calendar"
    },
    "grafana": {
      "url": "https://crearec.app/mcp/grafana"
    }
  }
}
```

#### Reverse proxy note (Grafana MCP)

The `grafana-mcp` container listens on port 8793 (mapped from internal 8000) with endpoint path `/mcp`. Configure nginx to forward:

- `https://crearec.app/mcp/grafana` → `http://127.0.0.1:8793/mcp`

**Why `--allowed-hosts "*"`:** mcp-grafana 1.1.0 includes DNS-rebinding protection that defaults `--allowed-hosts` to the loopback of `--address` (e.g., `localhost:8000` / `127.0.0.1:8000`). This blocks requests arriving with `Host: crearec.app` (public hostname) or `Host: 127.0.0.1:8793` (mapped port). Since nginx on the same host is a trusted reverse proxy, we allow all hosts with `*`. The apple-calendar service uses the same pattern.

Create `/etc/nginx/snippets/grok-mcp-grafana.conf` and include it from `/etc/nginx/sites-available/default` (same pattern as the calendar snippet):

```nginx
# /etc/nginx/snippets/grok-mcp-grafana.conf
# Grafana MCP (streamable-http transport)

location = /mcp/grafana {
    proxy_pass http://127.0.0.1:8793/mcp;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

## Day-to-day operations

Deploy: merge to `main` (only changed images republish), or trigger manually via **Actions → CI/CD → Run workflow** on `main` to redeploy the existing image without code changes.

On the server (or via Portainer):

```sh
cd /home/crearec/grok-mcp
docker compose ps
docker compose logs -f apple-calendar
docker compose restart apple-calendar
```

### On-demand synology-indexer run

The indexer daemon sleeps until `INDEX_DAILY_AT` (default 21:00 America/Chicago). To kick one full index now without restarting the container or shifting the daily slot:

```sh
docker kill -s USR1 grok-mcp-synology-indexer
```

If a run is already in flight, the signal is ignored (logged) so GPU work never overlaps. After the manual run finishes, the daemon resumes waiting for the next `INDEX_DAILY_AT`.

## GitHub Actions secrets

| Secret | Purpose |
|--------|---------|
| `DEPLOY_SSH_KEY` | Private key for SSH deploy |
| `DEPLOY_HOST` | Tailscale IP or MagicDNS hostname of the server |
| `DEPLOY_USER` | SSH user |
| `TS_OAUTH_CLIENT_ID` | Tailscale OAuth client ID (Trust credentials) for ephemeral CI nodes |
| `TS_OAUTH_SECRET` | Tailscale OAuth client secret (Trust credentials) |

These are the **same secrets** used by CreaJarvis2. If already configured on your GitHub account, just add them to this repository.

Deploy joins the tailnet with `tag:ci` via [`tailscale/github-action`](https://github.com/tailscale/github-action), then SSHs to `DEPLOY_HOST`. Create the OAuth client under Tailscale **Settings → Trust credentials** (not legacy OAuth clients).

GHCR push and cleanup use the workflow `GITHUB_TOKEN` (`packages: write`). No extra registry secret is required for publish or for pruning old `sha-*` versions.

The deploy user needs Docker Compose without sudo.

## Adding more servers

This repo is a monorepo. To add a new MCP server:

1. Create `servers/your-server/` with Dockerfile, package.json, src/
2. Add path filters to `.github/workflows/ci-cd.yml`
3. Add service to `docker-compose.yml` with a different port
4. Update this doc and `.env.example`
