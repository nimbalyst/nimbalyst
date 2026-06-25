/**
 * Coerce a tracker field value to a strict primitive boolean for binding to a
 * BOOLEAN database column.
 *
 * Synced item payloads carry boolean flags (e.g. `archived`) as the integer
 * 0/1. better-sqlite3 tolerates 0/1 for a boolean column, but PGLite's
 * pg-protocol parameter serializer throws `Invalid input for boolean type` for
 * a non-boolean — which silently failed every item in the sync bootstrap on
 * PGLite clients. Always run boolean column values through this before binding.
 * See NIM-864 and packages/electron/DATABASE.md.
 */
export function toDbBoolean(value: unknown): boolean {
  return value === true || value === 1;
}
