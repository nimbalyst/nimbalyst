-- ----------------------------------------------------------------------------
-- 0003_searchable_text_message_kind
--
-- Phase 1A of the canonical-transcript-deprecation plan. See
-- nimbalyst-local/plans/canonical-transcript-deprecation.md.
--
-- Adds two columns to ai_agent_messages so the raw table can carry
-- enough structure to (a) serve FTS directly and (b) answer cross-session
-- queries like "list all user prompts" without going through the
-- ai_transcript_events derived table.
--
--   searchable_text  TEXT     user-visible plaintext extracted from the
--                              provider payload at insert time; NULL when
--                              the row carries no user-visible content
--                              (metadata, tool noise, transient chunks).
--   message_kind     TEXT     stable provider-agnostic categorization:
--                              'user' | 'assistant' | 'tool' | 'system' | 'meta'.
--                              NULL until backfilled.
--
-- Both columns are NULL on every existing row at migration time. A separate
-- backfill pass populates them. New writes after Phase 1B will set them at
-- insert time.
--
-- No index on either column in this migration. FTS index swap happens in
-- Phase 2 once we've verified the extractor's output quality.
-- ----------------------------------------------------------------------------

ALTER TABLE ai_agent_messages ADD COLUMN searchable_text TEXT;
ALTER TABLE ai_agent_messages ADD COLUMN message_kind TEXT;
