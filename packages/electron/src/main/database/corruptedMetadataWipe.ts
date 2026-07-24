/**
 * Self-heal query for the `{...stringValue}` spread artifact — see the long
 * comment at the call site in `initialize.ts`. `ai_sessions.metadata` is
 * JSONB on PGLite but TEXT on SQLite; comparing a JSONB column with `LIKE`
 * raises `operator does not exist: jsonb ~~ unknown` on PGLite, so we cast to
 * text first. The SQLite dialect translator drops the `::text` cast, leaving
 * the native TEXT comparison. Kept in its own module (no heavy imports) so the
 * regression test can exercise the exact SQL that ships (GitHub #926 /
 * NIM-1829).
 */
export const CORRUPTED_METADATA_WIPE_SQL = `UPDATE ai_sessions
   SET metadata = '{}'
 WHERE metadata::text LIKE '{"0":%"1":%"2":%'
 RETURNING id, LENGTH(metadata::text) AS len`;
