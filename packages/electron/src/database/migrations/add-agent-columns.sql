-- Add agent tracking columns to ai_sessions table
ALTER TABLE ai_sessions
ADD COLUMN IF NOT EXISTS agent_id TEXT,
ADD COLUMN IF NOT EXISTS agent_metadata JSONB;