-- Persist always-skip file routes so later indexer runs do not re-dirty them.
-- Idempotent: column is only added if it does not exist.

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'files' AND column_name = 'not_supported'
    ) THEN
        ALTER TABLE "files" ADD COLUMN "not_supported" BOOLEAN NOT NULL DEFAULT false;
    END IF;
END $$;
