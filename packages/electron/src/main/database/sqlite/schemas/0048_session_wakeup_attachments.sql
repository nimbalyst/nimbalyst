-- ----------------------------------------------------------------------------
-- 0048_session_wakeup_attachments
--
-- Attachments for a scheduled ("Run later") prompt.
--
-- A wakeup stored only its prompt text, so scheduling a prompt that had an
-- image attached dropped the image silently: the composer cleared the draft
-- attachments and the prompt fired later without them. Queued prompts already
-- carry attachments (`queued_prompts.attachments`); this brings scheduled
-- prompts to parity.
--
-- Stored as a JSON array of ChatAttachment, matching how `queued_prompts`
-- persists the same shape. Nullable, because every wakeup written before this
-- column existed genuinely had no attachments -- there is nothing to backfill.
-- ----------------------------------------------------------------------------

ALTER TABLE ai_session_wakeups ADD COLUMN attachments TEXT;
