-- Additive queue truth spine. Legacy rows are backfilled from their stable row
-- identity and session; new rows receive all fields at admission.
ALTER TABLE queued_prompts ADD COLUMN client_submission_id TEXT;
ALTER TABLE queued_prompts ADD COLUMN source_session_id TEXT;
ALTER TABLE queued_prompts ADD COLUMN source_room_id TEXT;
ALTER TABLE queued_prompts ADD COLUMN submission_sequence INTEGER;
ALTER TABLE queued_prompts ADD COLUMN payload_utf8_bytes INTEGER;
ALTER TABLE queued_prompts ADD COLUMN payload_unicode_scalars INTEGER;
ALTER TABLE queued_prompts ADD COLUMN payload_sha256 TEXT;
ALTER TABLE queued_prompts ADD COLUMN claim_trigger TEXT;
ALTER TABLE queued_prompts ADD COLUMN claim_triggered_at TEXT;
ALTER TABLE queued_prompts ADD COLUMN turn_id TEXT;
ALTER TABLE queued_prompts ADD COLUMN provider_input_message_id TEXT;
ALTER TABLE queued_prompts ADD COLUMN provider_output_message_id TEXT;
ALTER TABLE queued_prompts ADD COLUMN stream_event_sequence INTEGER NOT NULL DEFAULT 0;
ALTER TABLE queued_prompts ADD COLUMN terminal_status TEXT;
ALTER TABLE queued_prompts ADD COLUMN terminal_at TEXT;

UPDATE queued_prompts
SET client_submission_id = COALESCE(client_submission_id, id),
    source_session_id = COALESCE(source_session_id, session_id),
    source_room_id = COALESCE(source_room_id, session_id),
    submission_sequence = COALESCE(submission_sequence, rowid),
    payload_utf8_bytes = COALESCE(payload_utf8_bytes, length(CAST(prompt AS BLOB))),
    payload_unicode_scalars = COALESCE(payload_unicode_scalars, length(prompt)),
    payload_sha256 = COALESCE(payload_sha256, 'legacy-unverified');

CREATE UNIQUE INDEX IF NOT EXISTS idx_queued_prompts_client_submission
  ON queued_prompts(client_submission_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_queued_prompts_source_sequence
  ON queued_prompts(source_session_id, submission_sequence);

CREATE TABLE IF NOT EXISTS queued_prompt_source_sequences (
  source_session_id TEXT PRIMARY KEY,
  next_sequence INTEGER NOT NULL
);
