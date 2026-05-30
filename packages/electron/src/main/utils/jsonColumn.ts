/**
 * Helpers for reading JSON-typed columns out of the database.
 *
 * Under PGLite (JSONB) reads return parsed values directly. Under SQLite
 * (TEXT) reads return raw strings. Callers that treat the column as an
 * object without parsing the SQLite case end up with `string.foo === undefined`
 * for every field, or — worse — spread the string char-by-char into a fresh
 * object when stored back, growing the row ~9x per write cycle.
 *
 * See `PGLiteSessionStore.normalizeJsonObject` (which originated this helper)
 * and the metadata-corruption postmortem.
 */

/**
 * Parse a JSON-typed column into a plain object. Accepts the value PGLite
 * gives us (already-parsed object), the value SQLite gives us (string), or
 * nullish. Anything that doesn't end up as a plain object returns `{}` so
 * downstream `metadata.foo` access and `{ ...metadata }` spread are both safe.
 */
export function parseJsonObjectColumn(value: unknown): Record<string, any> {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, any>;
      }
      return {};
    } catch {
      return {};
    }
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, any>;
  }
  return {};
}
