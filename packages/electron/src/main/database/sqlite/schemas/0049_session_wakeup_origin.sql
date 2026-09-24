-- ----------------------------------------------------------------------------
-- 0049_session_wakeup_origin
--
-- Who scheduled a wakeup: the agent's self-pacing tool, or a person using
-- "Run later" (#1497).
--
-- The agent's tool replaces its previous wakeup on every turn. Without this
-- column that replacement cancelled every active wakeup in the session, so an
-- agent re-pacing itself silently threw away prompts the user had scheduled.
-- It also decides how a fired prompt is delivered: a user's prompt renders as
-- their message, an agent's as a resume marker.
--
-- Every wakeup written before this column existed came from the agent's tool,
-- so 'agent' is the correct value for existing rows, not merely a default.
-- ----------------------------------------------------------------------------

ALTER TABLE ai_session_wakeups ADD COLUMN origin TEXT NOT NULL DEFAULT 'agent';
