# synology

Synology MCP server with semantic search over indexed files and folders.

This package provides:
- **MCP Server**: Streamable HTTP MCP with `synology_search` tool
- **Prisma Schema**: PostgreSQL + pgvector schema for indexing

## MCP Tools

### `synology_search`

Search Synology NAS files and folders by semantic similarity.

**Parameters:**
- `query` (string, required): Natural language search query
- `limit` (number, optional): Maximum results to return (default: 8, max: 50)

**Response:**
```json
{
  "ok": true,
  "data": {
    "results": [
      {
        "label": "Family Photos 2024",
        "shareUrl": "https://nas.example.com/sharing/abc123",
        "kind": "folder",
        "score": 0.92
      }
    ],
    "count": 1
  }
}
```

## Privacy Policy (Hard Contract)

The MCP server **NEVER** returns:
- `description` — Full text used for embedding
- `syno_path` / `synoPath` — Synology file system path
- `syno_id` / `synoId` — Synology internal ID
- `embedding` — Vector data
- `content_hash` / `contentHash` — Internal SHA-256 checksum for deduplication
- Share passwords (not stored in DB)
- Raw file bytes

**Only returned:**
- `label` — Short, safe-to-display name
- `shareUrl` — Public share link
- `kind` — "file" or "folder"
- `score` — Relevance score (0-1, higher is better)

Rows with `null` shareUrl or `null` embedding are skipped.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `PORT` | No | Server port (default: 8794) |
| `HOST` | No | Server host (default: 0.0.0.0) |
| `TRANSFORMERS_CACHE` | No | Model cache directory (default: /tmp/transformers-cache) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | No | OpenTelemetry endpoint |
| `OTEL_SERVICE_NAME` | No | Service name (default: synology) |
| `OTEL_SERVICE_NAMESPACE` | No | Namespace (default: mcp) |
| `DEPLOY_ENV` | No | Deployment environment |

## Embedding Model

Query embeddings use **mxbai-embed-large** (mixedbread-ai/mxbai-embed-large-v1):
- **Dimension**: 1024
- **Runtime**: CPU via Transformers.js (ONNX/WASM)
- **First start**: Downloads ~500MB quantized model

⚠️ The query embedding model **must** match the indexed data. Do not change the model without re-indexing all data.

## Database Schema

- **files**: Indexed files with embeddings for semantic search
- **folders**: Indexed folders with embeddings

Embedding dimension: 1024 (mxbai-embed-large / mixedbread-ai/mxbai-embed-large-v1)

### Data Policy

Descriptions may include names and addresses. They must **never** include:
- Passport numbers
- Social Security Numbers (SSN)
- Bank account numbers
- Driver's license numbers

## Development

### Prerequisites

The `synology-db` service must be running (see root `docker-compose.yml`).

```sh
# Start the database
docker compose up -d synology-db
```

### Install and run

```sh
cd servers/synology
npm install
npx prisma generate
npm run dev
```

### Run migrations

```sh
npx prisma migrate deploy
```

### Run tests

```sh
npm test
```

### Development commands

```sh
# Create a new migration after schema changes
npx prisma migrate dev --name describe_change

# View database in Prisma Studio
npx prisma studio
```

## Docker

Build and run:

```sh
docker build -t synology-mcp .
docker run -p 8794:8794 \
  -e DATABASE_URL=postgresql://synology:password@host.docker.internal:5434/synology \
  synology-mcp
```

## Endpoints

- `POST /mcp` — MCP protocol endpoint
- `GET /health` — Health check (returns model info)
