// @vitest-environment node
/**
 * `sessions:get-by-file` against a real better-sqlite3 backend.
 *
 * The behaviour under test is cross-worktree discovery; the defect was that it
 * was spelled with a leading-wildcard LIKE, which cannot use an index and so
 * scanned every `session_files` row on each call. Both halves matter, so both
 * are asserted: the rows it finds, and the plan it finds them with.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('electron', async () => ({
  app: {
    getPath: (await import('../../../../test-stubs/privateUserData')).testApp.getPath,
    getName: vi.fn(() => 'test-app'),
    getVersion: vi.fn(() => '1.0.0'),
    on: vi.fn(),
  },
}));

import { SQLiteDatabase } from '../../database/sqlite/SQLiteDatabase';
import { findSessionAttributionForFile, findSessionIdsForFile, worktreeRootRange } from '../sessionFilesByPath';
import { getSessionsForFile } from '../fileSessionLookup';
import { createPGLiteSessionStore } from '../PGLiteSessionStore';
import { createSyncedSessionStore } from '@nimbalyst/runtime/sync/SyncedSessionStore';
import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import type { SyncProvider } from '@nimbalyst/runtime/sync/types';

const PROJECT = '/Users/dev/sources/app';
const WORKTREE = '/Users/dev/sources/app_worktrees/feature-a';
const OTHER_WORKTREE = '/Users/dev/sources/app_worktrees/feature-b';

let tmpDir: string;
let sqlite: SQLiteDatabase;

async function link(sessionId: string, workspaceId: string, filePath: string): Promise<void> {
  await sqlite.query(
    `INSERT INTO session_files (id, session_id, workspace_id, file_path, link_type, timestamp, metadata)
     VALUES ($1, $2, $3, $4, 'edited', $5, '{}')`,
    [`${sessionId}:${filePath}`, sessionId, workspaceId, filePath, new Date(0)],
  );
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-sfbp-'));
  sqlite = new SQLiteDatabase({
    dbDir: tmpDir,
    schemaDir: path.resolve(__dirname, '..', '..', 'database', 'sqlite', 'schemas'),
    slowQueryThresholdMs: 1000,
    sampleRate: 0,
  });
  await sqlite.initialize();
});

afterEach(async () => {
  AISessionsRepository.clearStore();
  await sqlite.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

it('hydrates 916 linked sessions through the synced repository in three database queries', async () => {
  const ids = Array.from({ length: 916 }, (_, i) => `session-${i}`);
  await sqlite.query(
    `INSERT INTO ai_sessions (id, provider, workspace_id) VALUES ${ids.map((_, i) => `($${i + 1}, 'openai-codex', '${PROJECT}')`).join(',')}`,
    ids,
  );
  const filePath = `${PROJECT}/CHANGELOG.md`;
  await sqlite.query(
    `INSERT INTO session_files (id, session_id, workspace_id, file_path, link_type, timestamp, metadata)
     SELECT id, id, workspace_id, $1, 'edited', $2, '{}' FROM ai_sessions`,
    [filePath, new Date(1000)],
  );
  const query = vi.fn(sqlite.query.bind(sqlite));
  const db = { query: query as typeof sqlite.query };
  AISessionsRepository.setStore(createSyncedSessionStore(
    createPGLiteSessionStore(db), {} as SyncProvider,
  ));
  const result = await getSessionsForFile(db, AISessionsRepository, PROJECT, filePath);
  expect(result).toHaveLength(916);
  expect(query).toHaveBeenCalledTimes(3);
  expect(result.every(session => session.lastFileEditAt === 1000 && session.isCurrentWorkspace && session.messageCount === 0)).toBe(true);
});

it('shares concurrent root discovery but discovers newly linked worktrees on the next lookup', async () => {
  await link('main', PROJECT, `${PROJECT}/a.md`);
  const query = vi.fn(sqlite.query.bind(sqlite));
  const db = { query: query as typeof sqlite.query };
  const lookup = { workspaceId: PROJECT, projectPath: PROJECT, relativePath: '/a.md', filePath: `${PROJECT}/a.md` };
  await Promise.all([findSessionIdsForFile(db, lookup), findSessionIdsForFile(db, lookup)]);
  expect(query).toHaveBeenCalledTimes(3);
  await link('new-worktree', WORKTREE, `${WORKTREE}/a.md`);
  expect(await findSessionIdsForFile(db, lookup)).toEqual(expect.arrayContaining(['main', 'new-worktree']));
  expect(query).toHaveBeenCalledTimes(5);
});

describe('findSessionIdsForFile', () => {
  it('finds the same file in the project and in every worktree', async () => {
    await link('s-project', PROJECT, `${PROJECT}/src/index.ts`);
    await link('s-worktree', WORKTREE, `${WORKTREE}/src/index.ts`);
    await link('s-other-worktree', OTHER_WORKTREE, `${OTHER_WORKTREE}/src/index.ts`);
    // Same basename, different file — must not match.
    await link('s-elsewhere', PROJECT, `${PROJECT}/vendor/src/index.ts`);
    // Unrelated project that happens to sit next to ours.
    await link('s-unrelated', '/Users/dev/sources/other', '/Users/dev/sources/other/src/index.ts');

    const ids = await findSessionIdsForFile(sqlite as never, {
      workspaceId: WORKTREE,
      projectPath: PROJECT,
      relativePath: '/src/index.ts',
      filePath: `${WORKTREE}/src/index.ts`,
    });

    expect([...ids].sort()).toEqual(['s-other-worktree', 's-project', 's-worktree']);
  });

  it('falls back to an exact match when the file is outside the workspace', async () => {
    await link('s-project', PROJECT, '/etc/hosts');
    const ids = await findSessionIdsForFile(sqlite as never, {
      workspaceId: PROJECT,
      projectPath: PROJECT,
      relativePath: null,
      filePath: '/etc/hosts',
    });
    expect(ids).toEqual(['s-project']);
  });

  // The whole point of the change. A leading-wildcard LIKE reads `SCAN session_files`.
  it('runs both halves off indexes, never a full scan', async () => {
    const range = worktreeRootRange(PROJECT);
    const planFor = async (sql: string, params: unknown[]) => {
      const { rows } = await sqlite.query<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, params);
      return rows.map((row) => row.detail).join(' | ');
    };

    const rootsPlan = await planFor(
      `SELECT DISTINCT workspace_id FROM session_files
       WHERE workspace_id = $1 OR workspace_id = $2 OR (workspace_id >= $3 AND workspace_id < $4)`,
      [WORKTREE, PROJECT, range.from, range.to],
    );
    expect(rootsPlan).toContain('idx_session_files_workspace');
    expect(rootsPlan).not.toContain('SCAN session_files');

    const matchPlan = await planFor(
      `SELECT DISTINCT session_id FROM session_files WHERE file_path = ANY($1)`,
      [[`${WORKTREE}/src/index.ts`, `${PROJECT}/src/index.ts`]],
    );
    expect(matchPlan).toContain('idx_session_files_file');
    expect(matchPlan).not.toContain('SCAN session_files');
  });
});

it('returns latest per-file edit provenance for multiple sessions without inferring whole-file ownership',async()=>{
  const filePath=`${PROJECT}/shared.ts`;
  await link('A',PROJECT,filePath);await link('B',PROJECT,filePath);
  await sqlite.query('UPDATE session_files SET timestamp=$1, metadata=$2 WHERE session_id=$3',[new Date(1000),JSON.stringify({source:'shell-hook-inferred'}),'B']);
  const rows=await findSessionAttributionForFile(sqlite,{workspaceId:PROJECT,projectPath:PROJECT,relativePath:'/shared.ts',filePath});
  expect(rows).toEqual(expect.arrayContaining([{id:'A',lastFileEditAt:0,fileAttribution:'recorded'},{id:'B',lastFileEditAt:1000,fileAttribution:'inferred'}]));
});
