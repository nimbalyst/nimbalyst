/** Keep historical lifecycle rows visible to audit, outside manual delivery. */
export function automaticChildUpdateFilter(automatic: boolean, alias?: 'q'): string {
  if (automatic) return '';
  const context = alias ? `${alias}.document_context` : 'document_context';
  return ` AND NOT (CASE WHEN ${context} IS JSON THEN
    COALESCE(${context}->'promptProvenance'->>'actor', '') = 'agent'
    AND COALESCE(${context}->'promptProvenance'->>'origin', '') = 'child-session-update'
    ELSE FALSE END)`;
}
