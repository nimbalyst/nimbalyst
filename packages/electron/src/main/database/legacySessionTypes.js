/** Legacy interaction-mode conversion, shared with the worker and SQL regression. */
const LEGACY_SESSION_TYPES_SQL = `
  UPDATE ai_sessions SET session_type = 'workstream'
    WHERE session_type NOT IN ('session', 'workstream', 'blitz', 'voice')
      AND id IN (SELECT DISTINCT parent_session_id FROM ai_sessions WHERE parent_session_id IS NOT NULL);
  UPDATE ai_sessions SET session_type = 'session'
    WHERE session_type NOT IN ('blitz', 'workstream', 'voice');
`;
module.exports = { LEGACY_SESSION_TYPES_SQL };
