/**
 * Regression test for GitHub #926 / NIM-1829.
 *
 * The startup "corrupted-metadata wipe" self-heals the `{...stringValue}`
 * spread artifact by wiping `ai_sessions.metadata` rows shaped like
 * `{"0":"a","1":"b","2":...}`. `metadata` is JSONB on PGLite but TEXT on
 * SQLite; the original query compared the JSONB column with `LIKE` directly,
 * which raises `operator does not exist: jsonb ~~ unknown` on PGLite. The
 * error was swallowed by the surrounding try/catch, so the wipe was a silent
 * no-op on every PGLite startup and corrupted rows never got cleaned.
 *
 * This exercises a real PGLite instance so the JSONB code path is covered
 * (the app's own dev DB in these repos happens to be SQLite, where the bug
 * does not reproduce). Case 1 reproduces the pre-fix failure against the raw
 * `LIKE`; case 2 asserts the shipping `CORRUPTED_METADATA_WIPE_SQL` constant
 * wipes only the artifact rows.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CORRUPTED_METADATA_WIPE_SQL } from '../corruptedMetadataWipe';

describe('corrupted-metadata wipe (PGLite JSONB path)', () => {
  let tmp: string;
  let pglite: PGlite;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-wipe-'));
    pglite = new PGlite({ dataDir: path.join(tmp, 'pglite-db') });
    await (pglite as unknown as { waitReady: Promise<void> }).waitReady;

    await pglite.exec(`
      CREATE TABLE ai_sessions (
        id       TEXT PRIMARY KEY,
        metadata JSONB DEFAULT '{}'
      );
    `);

    // Spread artifact: string keys "0","1","2"... each holding a single char.
    await pglite.query(`INSERT INTO ai_sessions (id, metadata) VALUES ($1, $2::jsonb)`, [
      'artifact',
      JSON.stringify({ '0': 'a', '1': 's', '2': 'd', '3': 'f' }),
    ]);
    // Legitimate metadata that must survive the wipe.
    await pglite.query(`INSERT INTO ai_sessions (id, metadata) VALUES ($1, $2::jsonb)`, [
      'legit',
      JSON.stringify({ tokenUsage: 123, kanbanTags: ['review'] }),
    ]);
  });

  afterEach(async () => {
    await pglite.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('reproduces the pre-fix failure: raw LIKE on a JSONB column throws', async () => {
    await expect(
      pglite.query(
        `UPDATE ai_sessions SET metadata = '{}'
          WHERE metadata LIKE '{"0":%"1":%"2":%'
          RETURNING id`,
      ),
    ).rejects.toThrow(/operator does not exist: jsonb ~~/);
  });

  it('CORRUPTED_METADATA_WIPE_SQL wipes only the spread artifact on PGLite', async () => {
    const result = await pglite.query<{ id: string; len: number }>(
      CORRUPTED_METADATA_WIPE_SQL,
    );

    // Only the artifact row is matched and wiped.
    expect(result.rows.map((r) => r.id)).toEqual(['artifact']);
    expect(result.rows[0].len).toBeGreaterThan(0);

    const artifact = await pglite.query<{ metadata: unknown }>(
      `SELECT metadata FROM ai_sessions WHERE id = 'artifact'`,
    );
    expect(artifact.rows[0].metadata).toEqual({});

    const legit = await pglite.query<{ metadata: { tokenUsage: number } }>(
      `SELECT metadata FROM ai_sessions WHERE id = 'legit'`,
    );
    expect(legit.rows[0].metadata).toEqual({ tokenUsage: 123, kanbanTags: ['review'] });
  });
});
