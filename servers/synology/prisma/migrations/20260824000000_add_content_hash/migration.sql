-- Add content_hash column for skipping re-embedding unchanged files.
-- SHA-256 of file bytes, lowercase hex (64 chars). Nullable for rows not yet backfilled.

-- AddColumn
ALTER TABLE "files" ADD COLUMN "content_hash" TEXT;

-- CreateIndex: btree on content_hash for efficient lookup (duplicates allowed)
CREATE INDEX "files_content_hash_idx" ON "files"("content_hash");
