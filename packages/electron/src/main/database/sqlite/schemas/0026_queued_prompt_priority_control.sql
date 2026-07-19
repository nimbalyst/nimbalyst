-- Durable host-owned priority/control metadata for queued prompts.
-- MigrationRunner skips each ADD COLUMN when the consolidated initial schema
-- already supplied it, while still applying every missing column on v25 DBs.

ALTER TABLE queued_prompts ADD COLUMN delivery_class TEXT NOT NULL DEFAULT 'ordinary'
  CHECK (delivery_class IN ('ordinary', 'control'));
ALTER TABLE queued_prompts ADD COLUMN priority_rank INTEGER NOT NULL DEFAULT 0;
ALTER TABLE queued_prompts ADD COLUMN producer TEXT;
ALTER TABLE queued_prompts ADD COLUMN idempotency_key TEXT;
ALTER TABLE queued_prompts ADD COLUMN request_digest TEXT;
ALTER TABLE queued_prompts ADD COLUMN control_operation TEXT;
ALTER TABLE queued_prompts ADD COLUMN interrupt_target_generation TEXT;
ALTER TABLE queued_prompts ADD COLUMN interrupt_receipt TEXT;

CREATE INDEX IF NOT EXISTS idx_queued_prompts_pending_priority
  ON queued_prompts(session_id, priority_rank DESC, created_at, id)
  WHERE status = 'pending';

CREATE UNIQUE INDEX IF NOT EXISTS idx_queued_prompts_idempotency_key
  ON queued_prompts(idempotency_key)
  WHERE idempotency_key IS NOT NULL;
