-- Synology MCP database
--
-- POLICY: descriptions may include names/addresses; must NEVER include
-- passport numbers, SSN, bank account numbers, or driver-license numbers.
-- Share password is intentionally not stored.
--
-- Embedding dimension: 1024 (assumed model: nomic-embed-text-v1.5 or similar local model)

-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateTable
CREATE TABLE "folders" (
    "id" UUID NOT NULL,
    "syno_path" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "embedding" vector(1024),
    "embed_model" TEXT,
    "share_url" TEXT,
    "updated_at" TIMESTAMPTZ,

    CONSTRAINT "folders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "files" (
    "id" UUID NOT NULL,
    "syno_path" TEXT NOT NULL,
    "syno_id" TEXT,
    "folder_id" UUID,
    "kind" TEXT NOT NULL,
    "bytes" BIGINT,
    "mtime" TIMESTAMPTZ,
    "share_url" TEXT,
    "share_expires_at" TIMESTAMPTZ,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "embedding" vector(1024),
    "embed_model" TEXT,
    "indexed_at" TIMESTAMPTZ,
    "redacted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "files_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: unique path for folders
CREATE UNIQUE INDEX "folders_syno_path_key" ON "folders"("syno_path");

-- AddForeignKey
ALTER TABLE "files" ADD CONSTRAINT "files_folder_id_fkey" FOREIGN KEY ("folder_id") REFERENCES "folders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex: HNSW index on files.embedding for cosine similarity search
-- HNSW provides faster queries than IVFFlat at the cost of slower index builds and more memory
CREATE INDEX "files_embedding_hnsw_idx" ON "files" USING hnsw ("embedding" vector_cosine_ops);

-- CreateIndex: HNSW index on folders.embedding for cosine similarity search
CREATE INDEX "folders_embedding_hnsw_idx" ON "folders" USING hnsw ("embedding" vector_cosine_ops);
