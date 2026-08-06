/**
 * Coerce a value read out of a boolean database column to a strict primitive
 * boolean.
 *
 * Nimbalyst runs over both PGLite and better-sqlite3. PGLite hands back real
 * booleans; SQLite stores the same flags as `INTEGER` and hands back 0/1. A
 * `row.flag ?? false` mapping only guards null/undefined, so the number leaks
 * into records typed `boolean` and every strict comparison (`=== false`,
 * `=== true`) silently goes the wrong way while truthiness checks keep working.
 *
 * That divergence is what made every Trackers sidebar type badge read 0 on
 * SQLite (NIM-2280 / #1071) while the list and kanban still showed the items.
 * Always run boolean column values through this on the read path, the way
 * `toDbBoolean` guards the write path (NIM-864).
 *
 * See packages/electron/DATABASE.md.
 */
export function fromDbBoolean(value: unknown): boolean {
  return value === true || value === 1;
}
