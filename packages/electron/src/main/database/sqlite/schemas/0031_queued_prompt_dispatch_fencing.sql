-- Persist queue ownership and dispatch provenance across process and owner races.
-- Nullable defaults preserve legacy rows; new claims populate the token atomically.

ALTER TABLE queued_prompts ADD COLUMN claim_token TEXT;
ALTER TABLE queued_prompts ADD COLUMN dispatch_started_at TEXT;
ALTER TABLE queued_prompts ADD COLUMN settlement_provenance TEXT;
