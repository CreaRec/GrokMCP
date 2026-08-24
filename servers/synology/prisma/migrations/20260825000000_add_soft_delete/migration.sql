-- Add soft-delete support to files and folders tables
-- This migration is idempotent: columns and indexes are only added if they don't exist

-- Add deleted_at to files
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'files' AND column_name = 'deleted_at'
    ) THEN
        ALTER TABLE "files" ADD COLUMN "deleted_at" TIMESTAMPTZ;
    END IF;
END $$;

-- Add index on files.deleted_at
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE tablename = 'files' AND indexname = 'files_deleted_at_idx'
    ) THEN
        CREATE INDEX "files_deleted_at_idx" ON "files" ("deleted_at");
    END IF;
END $$;

-- Add deleted_at to folders
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'folders' AND column_name = 'deleted_at'
    ) THEN
        ALTER TABLE "folders" ADD COLUMN "deleted_at" TIMESTAMPTZ;
    END IF;
END $$;

-- Add index on folders.deleted_at
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE tablename = 'folders' AND indexname = 'folders_deleted_at_idx'
    ) THEN
        CREATE INDEX "folders_deleted_at_idx" ON "folders" ("deleted_at");
    END IF;
END $$;
