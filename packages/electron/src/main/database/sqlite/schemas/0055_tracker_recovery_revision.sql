-- Retain the revision an offline edit was decided against across organization recovery.
ALTER TABLE tracker_transactions ADD COLUMN base_sync_id INTEGER;
