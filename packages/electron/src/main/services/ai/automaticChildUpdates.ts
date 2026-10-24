/** Retain retired lifecycle rows as history, outside every automatic delivery path. */
export const DELIVERABLE_PROMPT_SQL = `NOT (
  COALESCE(document_context->'promptProvenance'->>'actor', '') = 'agent'
  AND COALESCE(document_context->'promptProvenance'->>'origin', '') = 'child-session-update'
)`;
/** The same predicate for the store's existing, fixed q table alias. */
export const DELIVERABLE_PROMPT_SQL_Q = DELIVERABLE_PROMPT_SQL.replaceAll('document_context', 'q.document_context');
