-- Add content_hash column for skipping re-embedding unchanged files.
-- SHA-256 of file bytes, lowercase hex (64 chars). Nullable for rows not yet backfilled.
--
-- IDEMPOTENT: This migration uses IF NOT EXISTS so it can be safely applied to
-- databases where the column/index were added via raw SQL before this migration
-- was recorded in _prisma_migrations (e.g. production hotfix for issue #16).

-- AddColumn (idempotent)
ALTER TABLE "files" ADD COLUMN IF NOT EXISTS "content_hash" TEXT;

-- CreateIndex: btree on content_hash for efficient lookup (duplicates allowed)
CREATE INDEX IF NOT EXISTS "files_content_hash_idx" ON "files"("content_hash");
