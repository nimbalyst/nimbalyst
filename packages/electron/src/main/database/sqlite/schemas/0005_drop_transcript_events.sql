-- ----------------------------------------------------------------------------
-- 0005_drop_transcript_events
--
-- Phase 4 of the canonical-transcript-deprecation plan. Removes the
-- persisted ai_transcript_events table and its watermark columns on
-- ai_sessions. Canonical events now live in TranscriptRuntime's
-- in-memory per-session MRU cache; raw ai_agent_messages is the sole
-- source of truth.
--
-- Forward-only: there is no rollback. Sessions that were previously
-- transformed lose nothing because the same canonical events can be
-- rebuilt from raw on demand.
-- ----------------------------------------------------------------------------

-- Triggers feeding the FTS5 shadow. Drop before the table.
DROP TRIGGER IF EXISTS ai_transcript_events_ai;
DROP TRIGGER IF EXISTS ai_transcript_events_ad;
DROP TRIGGER IF EXISTS ai_transcript_events_au;

DROP TABLE IF EXISTS ai_transcript_events_fts;
DROP TABLE IF EXISTS ai_transcript_events;

-- Watermark columns on ai_sessions no longer used; safe to drop.
-- SQLite supports `ALTER TABLE ... DROP COLUMN` since 3.35.
ALTER TABLE ai_sessions DROP COLUMN canonical_transform_version;
ALTER TABLE ai_sessions DROP COLUMN canonical_last_raw_message_id;
ALTER TABLE ai_sessions DROP COLUMN canonical_last_transformed_at;
ALTER TABLE ai_sessions DROP COLUMN canonical_transform_status;
