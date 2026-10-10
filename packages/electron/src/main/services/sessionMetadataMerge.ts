/** SQLite json_patch removes null keys; provenance needs an explicit JSON null. */
export function sessionMetadataMergeSql(base: string, parameter: number, patch: Record<string, unknown>): string {
  let expression = `${base} || $${parameter}::jsonb`;
  for (const key of ['preTreeParentSessionId', 'originalSpawnerSessionId', 'reassignedManagerSessionId']) {
    if (Object.prototype.hasOwnProperty.call(patch, key) && patch[key] === null) {
      expression = `jsonb_set(${expression}, '{${key}}', 'null')`;
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'hierarchySyncIntent') && patch.hierarchySyncIntent !== null) {
    expression = `jsonb_set(${expression}, '{hierarchySyncIntent}', $${parameter}::jsonb->'hierarchySyncIntent')`;
  }
  return expression;
}
