-- Add indexer fields to files and folders tables
-- This migration is idempotent: columns are only added if they don't exist

-- Add last_seen_at to files
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'files' AND column_name = 'last_seen_at'
    ) THEN
        ALTER TABLE "files" ADD COLUMN "last_seen_at" TIMESTAMPTZ;
    END IF;
END $$;

-- Add dirty to files
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'files' AND column_name = 'dirty'
    ) THEN
        ALTER TABLE "files" ADD COLUMN "dirty" BOOLEAN NOT NULL DEFAULT false;
    END IF;
END $$;

-- Add last_seen_at to folders
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'folders' AND column_name = 'last_seen_at'
    ) THEN
        ALTER TABLE "folders" ADD COLUMN "last_seen_at" TIMESTAMPTZ;
    END IF;
END $$;

-- Add dirty to folders
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'folders' AND column_name = 'dirty'
    ) THEN
        ALTER TABLE "folders" ADD COLUMN "dirty" BOOLEAN NOT NULL DEFAULT false;
    END IF;
END $$;
