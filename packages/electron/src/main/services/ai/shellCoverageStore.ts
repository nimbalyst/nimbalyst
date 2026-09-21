import type { StoredShellCoverage } from './ShellTrackingCoverage';

export interface CoverageDatabase {
  query<T = any>(sql: string, params?: any[]): Promise<{ rows: T[] }>;
}
/** Local observer state, separate from replicated session metadata. */
export function createShellCoverageStore(db: CoverageDatabase) {
  let ready: Promise<unknown> | undefined;
  const ensure = () =>
    (ready ??= db
      .query(
        `CREATE TABLE IF NOT EXISTS shell_tracking_coverage (
    session_id TEXT PRIMARY KEY REFERENCES ai_sessions(id) ON DELETE CASCADE,
    data TEXT NOT NULL
  )`
      )
      .catch((error) => {
        ready = undefined;
        throw error;
      }));
  return {
    async load(sessionId: string): Promise<StoredShellCoverage | undefined> {
      await ensure();
      const { rows } = await db.query<{ data: string }>(
        'SELECT data FROM shell_tracking_coverage WHERE session_id = $1',
        [sessionId]
      );
      if (!rows[0]) return undefined;
      const value = JSON.parse(rows[0].data);
      if (
        value.version !== 1 ||
        value.sessionId !== sessionId ||
        !Array.isArray(value.turns) ||
        !Array.isArray(value.active) ||
        !value.reasons
      ) {
        throw new Error('Invalid shell tracking coverage');
      }
      return value;
    },
    async save(sessionId: string, value: StoredShellCoverage): Promise<void> {
      await ensure();
      await db.query(
        `INSERT INTO shell_tracking_coverage (session_id, data) VALUES ($1, $2)
        ON CONFLICT (session_id) DO UPDATE SET data = excluded.data`,
        [sessionId, JSON.stringify(value)]
      );
    },
  };
}
