-- Durable priority/control delivery metadata for agent-to-agent prompts.
-- Ordinary rows retain priority_rank=0 and preserve FIFO ordering.

ALTER TABLE queued_prompts ADD COLUMN delivery_class TEXT NOT NULL DEFAULT 'ordinary'
  CHECK (delivery_class IN ('ordinary', 'control'));
ALTER TABLE queued_prompts ADD COLUMN priority_rank INTEGER NOT NULL DEFAULT 0;
ALTER TABLE queued_prompts ADD COLUMN delivery_ready INTEGER NOT NULL DEFAULT 1
  CHECK (delivery_ready IN (0, 1));
ALTER TABLE queued_prompts ADD COLUMN producer TEXT;
ALTER TABLE queued_prompts ADD COLUMN idempotency_key TEXT;
ALTER TABLE queued_prompts ADD COLUMN request_digest TEXT;
ALTER TABLE queued_prompts ADD COLUMN control_operation TEXT;
ALTER TABLE queued_prompts ADD COLUMN interrupt_target_generation TEXT;
ALTER TABLE queued_prompts ADD COLUMN interrupt_reservation_owner TEXT;
ALTER TABLE queued_prompts ADD COLUMN interrupt_receipt TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_queued_prompts_control_idempotency
  ON queued_prompts(session_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_queued_prompts_priority_pending
  ON queued_prompts(session_id, status, delivery_ready, priority_rank DESC, created_at ASC);
