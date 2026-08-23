# search-index

Prisma schema and migrations for the Synology private-index search database.

This package manages the PostgreSQL + pgvector schema for indexing Synology files and folders. It stores labels, descriptions (for embedding), and share URLs—**never** file bytes or share passwords.

## Schema

- **files**: Indexed files with embeddings for semantic search
- **folders**: Indexed folders with embeddings

Embedding dimension: 1024 (assumed model: `nomic-embed-text-v1.5` or similar local model)

## Data Policy

Descriptions may include names and addresses. They must **never** include:
- Passport numbers
- Social Security Numbers (SSN)
- Bank account numbers
- Driver's license numbers

## Usage

### Prerequisites

The `search-db` service must be running (see root `docker-compose.yml`).

Set `DATABASE_URL` in your environment or `.env`:

```sh
DATABASE_URL=postgresql://synology:YOUR_PASSWORD@127.0.0.1:5434/synology_index
```

### Run migrations

```sh
cd servers/search-index
npm install
npx prisma migrate deploy
```

### Development

```sh
# Create a new migration after schema changes
npx prisma migrate dev --name describe_change

# View database in Prisma Studio
npx prisma studio
```
