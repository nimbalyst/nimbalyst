-- ----------------------------------------------------------------------------
-- 0054_project_file_sync_disk_stamp
--
-- Disk-state cache for project file sync: the hash of the bytes on disk and
-- the size + mtime they were read at. A connect reuses the hash for a file
-- whose size and mtime have not moved instead of reading and hashing it again.
-- Distinct from content_hash, which is the last-synced baseline both sides
-- agreed on. NULL means no stamp; the file is hashed.
--
-- Columns only: no row is rewritten or removed.
--
-- PGLite mirror: worker.js, "Mirror of SQLite migration 0054". It runs on every
-- launch, which is safe because the statements are ADD COLUMN IF NOT EXISTS.
-- ----------------------------------------------------------------------------

ALTER TABLE project_file_sync_baseline ADD COLUMN disk_hash TEXT;
ALTER TABLE project_file_sync_baseline ADD COLUMN disk_size INTEGER;
ALTER TABLE project_file_sync_baseline ADD COLUMN disk_mtime INTEGER;
