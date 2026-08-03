-- Persist queue ownership and dispatch provenance across process and owner races.
-- Nullable defaults preserve legacy rows; new claims populate the token atomically.

ALTER TABLE queued_prompts ADD COLUMN claim_token TEXT;
ALTER TABLE queued_prompts ADD COLUMN dispatch_started_at TEXT;
ALTER TABLE queued_prompts ADD COLUMN settlement_provenance TEXT;

-- Exactly one control row may own native-interrupt admission for a target
-- lifecycle generation. Losing rows replay that owner's durable receipt.
CREATE UNIQUE INDEX IF NOT EXISTS idx_queued_prompts_interrupt_generation_owner
  ON queued_prompts(session_id, interrupt_target_generation)
  WHERE delivery_class = 'control' AND interrupt_target_generation IS NOT NULL;
