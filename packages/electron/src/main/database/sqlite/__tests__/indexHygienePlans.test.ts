// @vitest-environment node
/**
 * Pins the plans that schema 0053 changes, against the real migration chain.
 *
 * 0053 adds one partial index for the tray snippet query and drops indexes
 * that are a leading prefix of another index on the same table (or have no
 * reader at all). A dropped index never fails a query; it only changes the
 * plan, so the plan is what these tests assert: every reader of a dropped
 * index still SEARCHes through a surviving one.
 */

import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('electron', async () => ({
  app: {
    getPath: (await import('../../../../../test-stubs/privateUserData')).testApp.getPath,
    getName: vi.fn(() => 'test-app'),
    getVersion: vi.fn(() => '1.0.0'),
    on: vi.fn(),
  },
}));

import { SQLiteDatabase } from '../SQLiteDatabase';
import { latestAssistantTextSql } from '../../../tray/sessionSnippets';
import { createPGLiteSessionFileStore } from '../../../services/PGLiteSessionFileStore';

const SCHEMA_DIR = path.resolve(__dirname, '..', 'schemas');

const DROPPED = [
  'idx_session_files_session',
  'idx_session_files_workspace',
  'idx_session_files_type',
  'idx_queued_prompts_session',
  'idx_tracker_workspace',
  'idx_ai_sessions_created_by',
  'idx_history_file_content_hash',
];

let tmp: string;
let sqlite: SQLiteDatabase;

async function planFor(sql: string, params: unknown[] = []): Promise<string> {
  const result = await sqlite.query<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, params);
  return result.rows.map((row) => row.detail).join(' | ');
}

/** The plan seeks `table` through `index` and never names a dropped index. */
function expectSearch(plan: string, table: string, index: string): void {
  expect(plan).toMatch(new RegExp(`SEARCH ${table}( AS \\w+)? USING (COVERING )?INDEX ${index}\\b`));
  expect(plan).not.toMatch(new RegExp(`SCAN ${table}\\b(?! USING)`));
  for (const dropped of DROPPED) expect(plan).not.toMatch(new RegExp(`\\b${dropped}\\b`));
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-index-hygiene-'));
  sqlite = new SQLiteDatabase({
    dbDir: path.join(tmp, 'sqlite-db'),
    schemaDir: SCHEMA_DIR,
    slowQueryThresholdMs: 1000,
    sampleRate: 0,
  });
  await sqlite.initialize();
});

afterAll(async () => {
  await sqlite.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('schema 0053 indexes', () => {
  it('drops the redundant indexes and keeps the ones that replace them', async () => {
    const { rows } = await sqlite.query<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'index'`,
    );
    const names = new Set(rows.map((row) => row.name));
    for (const dropped of DROPPED) expect(names.has(dropped)).toBe(false);
    for (const kept of [
      'idx_session_files_unique',
      'idx_session_files_workspace_file',
      'idx_session_files_uncommitted_lookup',
      'idx_queued_prompts_session_status',
      'idx_tracker_workspace_sync_id',
      'idx_ai_sessions_created_by_workspace',
      'idx_history_pending_session_file',
      'idx_ai_agent_messages_latest_assistant_text',
    ]) {
      expect(names.has(kept)).toBe(true);
    }
  });
});

describe('tray snippet query', () => {
  // Before 0053 this planned as `SEARCH ai_agent_messages USING INDEX
  // idx_ai_agent_messages_user_prompts (message_kind=?) | USE TEMP B-TREE FOR
  // GROUP BY`: every assistant row in the database, through the table.
  it('probes the partial index once per session, in index order', async () => {
    const plan = await planFor(latestAssistantTextSql(['s1', 's2', 's3'])!);
    const searches = plan.split(' | ').filter((step) => step.startsWith('SEARCH ai_agent_messages'));
    expect(searches).toEqual(Array(3).fill(
      'SEARCH ai_agent_messages USING INDEX idx_ai_agent_messages_latest_assistant_text (session_id=?)',
    ));
    expect(plan).not.toContain('TEMP B-TREE');
  });

  it('returns the newest non-empty assistant text for each session', async () => {
    for (const id of ['snip-a', 'snip-b', 'snip-c']) {
      await sqlite.query(`INSERT INTO ai_sessions(id, provider) VALUES ($1, 'claude-code')`, [id]);
    }
    const rows: Array<[string, string | null, string | null]> = [
      ['snip-a', 'assistant', 'first answer'],
      ['snip-a', 'assistant', 'latest answer'],
      ['snip-a', 'tool', 'tool output after it'],
      ['snip-a', 'assistant', ''],
      ['snip-a', 'assistant', null],
      ['snip-b', 'user', 'a prompt'],
      ['snip-b', 'assistant', 'only answer'],
      ['snip-c', 'tool', 'no assistant text at all'],
    ];
    for (const [sessionId, kind, text] of rows) {
      await sqlite.query(
        `INSERT INTO ai_agent_messages(session_id, source, direction, content, message_kind, searchable_text)
         VALUES ($1, 'claude-code', 'output', '{}', $2, $3)`,
        [sessionId, kind, text],
      );
    }

    const { rows: latest } = await sqlite.query<{ session_id: string; searchable_text: string }>(
      latestAssistantTextSql(['snip-a', 'snip-b', 'snip-c'])!,
    );
    expect(Object.fromEntries(latest.map((row) => [row.session_id, row.searchable_text]))).toEqual({
      'snip-a': 'latest answer',
      'snip-b': 'only answer',
    });
  });
});

describe('session_files readers', () => {
  // #1955: commit-proposal ownership flags look up every expanded file in one query.
  it('getSessionsByFiles runs on better-sqlite3 and seeks a (workspace_id, file_path) index', async () => {
    const store = createPGLiteSessionFileStore(sqlite);
    const link = (sessionId: string, workspaceId: string, filePath: string, linkType: 'edited' | 'read' = 'edited') =>
      store.addFileLink({ sessionId, workspaceId, filePath, linkType, timestamp: Date.now(), metadata: {} });
    await link('own-1', '/proj', '/proj/a.txt');
    await link('own-2', '/proj/wt', '/proj/wt/b.txt');
    await link('own-3', '/proj', '/proj/a.txt', 'read');
    await link('own-4', '/elsewhere', '/proj/a.txt');
    await link('own-5', '/proj', '/proj/c.txt');

    const rows = await store.getSessionsByFiles!(['/proj', '/proj/wt'], ['/proj/a.txt', '/proj/wt/b.txt', '/proj/missing.txt'], 'edited');
    expect(rows.map(row => `${row.sessionId}:${row.filePath}`).sort()).toEqual(['own-1:/proj/a.txt', 'own-2:/proj/wt/b.txt']);

    // A second edit of the same file reports the newest time as epoch ms, so stale edits can be told apart.
    await store.addFileLink({ sessionId: 'own-1', workspaceId: '/proj', filePath: '/proj/a.txt', linkType: 'edited', timestamp: 1_700_000_000_000, metadata: {} });
    await store.addFileLink({ sessionId: 'own-1', workspaceId: '/proj', filePath: '/proj/a.txt', linkType: 'edited', timestamp: 1_900_000_000_000, metadata: {} });
    const [latest] = await store.getSessionsByFiles!(['/proj'], ['/proj/a.txt'], 'edited');
    expect(latest.lastLinkedAt).toBe(1_900_000_000_000);

    const plan = await planFor(
      `SELECT session_id, file_path, MAX(timestamp) AS last_linked_at FROM session_files
        WHERE workspace_id = ANY($1::text[]) AND file_path = ANY($2::text[]) AND link_type = $3
        GROUP BY session_id, file_path`,
      [['/proj', '/proj/wt'], ['/proj/a.txt', '/proj/wt/b.txt'], 'edited'],
    );
    // Seeks on all three equality columns; the IN lists become index probes, not a table scan.
    expectSearch(plan, 'session_files', 'idx_session_files_uncommitted_lookup');
    expect(plan).toContain('(workspace_id=? AND link_type=? AND file_path=?)');
  });

  it('per-session edited rows (ToolCallMatcher) use idx_session_files_unique', async () => {
    const plan = await planFor(
      `SELECT id, file_path, EXTRACT(EPOCH FROM timestamp) * 1000 AS timestamp_ms, metadata
         FROM session_files
        WHERE session_id = $1 AND link_type = 'edited'`,
      ['s1'],
    );
    expectSearch(plan, 'session_files', 'idx_session_files_unique');
  });

  it('getFilesBySession and deleteSessionLinks use idx_session_files_unique', async () => {
    expectSearch(
      await planFor(`SELECT * FROM session_files WHERE session_id = $1 ORDER BY timestamp ASC`, ['s1']),
      'session_files',
      'idx_session_files_unique',
    );
    expectSearch(
      await planFor(`DELETE FROM session_files WHERE session_id = $1`, ['s1']),
      'session_files',
      'idx_session_files_unique',
    );
  });

  it('latest session per file (SessionHandlers) uses the uncommitted lookup index', async () => {
    const plan = await planFor(
      `SELECT session_id, file_path FROM (
         SELECT session_id, file_path,
                ROW_NUMBER() OVER (PARTITION BY file_path ORDER BY timestamp DESC) AS rn
         FROM session_files
         WHERE workspace_id = $1
           AND link_type = 'edited'
           AND file_path = ANY($2::text[])
       ) ranked WHERE rn = 1`,
      ['/ws', ['/ws/a.md', '/ws/b.md']],
    );
    expectSearch(plan, 'session_files', 'idx_session_files_uncommitted_lookup');
  });

  it('sessions with edits (SessionHandlers) uses the uncommitted lookup index', async () => {
    const plan = await planFor(
      `SELECT DISTINCT session_id FROM session_files WHERE workspace_id = $1 AND link_type = 'edited'`,
      ['/ws'],
    );
    expectSearch(plan, 'session_files', 'idx_session_files_uncommitted_lookup');
  });

  it('worktree root discovery (sessionFilesByPath) uses idx_session_files_workspace_file', async () => {
    const plan = await planFor(
      `SELECT DISTINCT workspace_id FROM session_files
        WHERE workspace_id = $1
           OR workspace_id = $2
           OR (workspace_id >= $3 AND workspace_id < $4)`,
      ['/ws', '/ws', '/ws_worktrees/', '/ws_worktrees0'],
    );
    expectSearch(plan, 'session_files', 'idx_session_files_workspace_file');
  });

  it('file lookups (sessionFilesByPath) use the workspace_file and file indexes', async () => {
    expectSearch(
      await planFor(
        `SELECT DISTINCT session_id, file_path FROM session_files WHERE workspace_id = $1 AND file_path = $2`,
        ['/ws', '/ws/a.md'],
      ),
      'session_files',
      'idx_session_files_workspace_file',
    );
    expectSearch(
      await planFor(`SELECT DISTINCT session_id, file_path FROM session_files WHERE file_path = ANY($1)`, [
        ['/ws/a.md', '/wt/a.md'],
      ]),
      'session_files',
      'idx_session_files_file',
    );
  });
});

describe('other readers of dropped prefix indexes', () => {
  it('queued prompts by session use idx_queued_prompts_session_status', async () => {
    expectSearch(
      await planFor(
        `SELECT * FROM queued_prompts WHERE session_id = $1 AND status NOT IN ('completed', 'failed')
          ORDER BY created_at ASC, id ASC`,
        ['s1'],
      ),
      'queued_prompts',
      'idx_queued_prompts_session_status',
    );
    expectSearch(
      await planFor(`SELECT * FROM queued_prompts WHERE session_id = $1 ORDER BY created_at ASC, id ASC`, ['s1']),
      'queued_prompts',
      'idx_queued_prompts_session_status',
    );
  });

  it('tracker items by workspace use a workspace-leading composite', async () => {
    const plan = await planFor(`SELECT * FROM tracker_items WHERE workspace = $1 AND deleted_at IS NULL`, ['/ws']);
    expect(plan).toMatch(/SEARCH tracker_items USING INDEX idx_tracker_(workspace_sync_id|kanban_sort) \(workspace=\?/);
    expect(plan).not.toMatch(/\bidx_tracker_workspace\b/);
  });

  it('spawned-session lookups use the partial idx_ai_sessions_created_by_workspace', async () => {
    expectSearch(
      await planFor(
        `SELECT id FROM ai_sessions WHERE workspace_id = $1 AND created_by_session_id = $2
           AND (is_archived = FALSE OR is_archived IS NULL) ORDER BY created_at DESC`,
        ['/ws', 'm1'],
      ),
      'ai_sessions',
      'idx_ai_sessions_created_by_workspace',
    );
    // sessionHierarchy: an OR across the parent and manager columns.
    const orPlan = await planFor(
      `SELECT id FROM ai_sessions WHERE parent_session_id = $1 OR created_by_session_id = $1`,
      ['m1'],
    );
    expect(orPlan).toContain('MULTI-INDEX OR');
    expect(orPlan).toContain('idx_ai_sessions_created_by_workspace (created_by_session_id=?)');
  });

  it('the latest snapshot lookup does not use the content-hash index', async () => {
    const plan = await planFor(
      `SELECT metadata, timestamp FROM document_history WHERE file_path = $1 ORDER BY timestamp DESC LIMIT 1`,
      ['/ws/a.md'],
    );
    expect(plan).toContain('SEARCH document_history USING INDEX idx_history_file_timestamp');
  });
});

describe('PGLite mirror of 0053', () => {
  // Runs the worker.js mirror block itself, so the two backends cannot drift.
  const mirrorDdl = () => {
    const source = fs.readFileSync(path.resolve(__dirname, '..', '..', 'worker.js'), 'utf8');
    const start = source.indexOf('Mirror of SQLite migration 0053');
    const ddl = source.slice(start).match(/exec\(`([\s\S]*?)`\)/);
    if (start < 0 || !ddl) throw new Error('0053 mirror block not found in worker.js');
    return ddl[1];
  };

  it('replaces the dropped indexes on every launch and serves the same lookups', async () => {
    const { PGlite } = await import('@electric-sql/pglite');
    const pglite = new PGlite();
    try {
      // Only the columns the mirror and the probed queries touch, plus the
      // indexes the mirror drops, as a pre-0053 database has them.
      await pglite.exec(`
        CREATE TABLE ai_sessions (id TEXT PRIMARY KEY, workspace_id TEXT, parent_session_id TEXT, created_by_session_id TEXT);
        CREATE INDEX idx_ai_sessions_parent ON ai_sessions(parent_session_id);
        CREATE INDEX idx_ai_sessions_created_by ON ai_sessions(created_by_session_id);
        CREATE INDEX idx_ai_sessions_created_by_workspace ON ai_sessions(created_by_session_id, workspace_id) WHERE created_by_session_id IS NOT NULL;
        CREATE TABLE ai_agent_messages (id BIGSERIAL PRIMARY KEY, session_id TEXT NOT NULL, message_kind TEXT, searchable_text TEXT);
        CREATE INDEX idx_ai_agent_messages_session ON ai_agent_messages(session_id, id);
        CREATE TABLE tracker_items (id TEXT PRIMARY KEY, workspace TEXT NOT NULL, status TEXT, kanban_sort_order TEXT, sync_id BIGINT);
        CREATE INDEX idx_tracker_workspace ON tracker_items(workspace);
        CREATE TABLE session_files (id TEXT PRIMARY KEY, session_id TEXT, workspace_id TEXT, file_path TEXT, link_type TEXT);
        CREATE INDEX idx_session_files_session ON session_files(session_id);
        CREATE INDEX idx_session_files_type ON session_files(link_type);
        CREATE INDEX idx_session_files_workspace ON session_files(workspace_id);
        CREATE TABLE queued_prompts (id TEXT PRIMARY KEY, session_id TEXT, status TEXT);
        CREATE INDEX idx_queued_prompts_session ON queued_prompts(session_id);
        CREATE TABLE document_history (id BIGSERIAL PRIMARY KEY, file_path TEXT, metadata JSONB);
        CREATE INDEX idx_history_file_content_hash ON document_history(file_path, (metadata->>'baseMarkdownHash'))
          WHERE metadata->>'baseMarkdownHash' IS NOT NULL;
      `);
      await pglite.exec(mirrorDdl());
      await pglite.exec(mirrorDdl());

      const { rows } = await pglite.query<{ indexname: string }>(`SELECT indexname FROM pg_indexes`);
      const names = new Set(rows.map((row) => row.indexname));
      for (const dropped of DROPPED) expect(names.has(dropped)).toBe(false);
      for (const kept of [
        'idx_ai_agent_messages_latest_assistant_text',
        'idx_tracker_workspace_sync_id',
        'idx_tracker_kanban_sort',
        'idx_ai_sessions_created_by_workspace',
      ]) {
        expect(names.has(kept)).toBe(true);
      }

      // Empty tables: turn off the seq scan so the plan shows which index is
      // eligible at all, which is the property a dropped index could break.
      await pglite.exec('SET enable_seqscan = off');
      const planFor = async (sql: string) => {
        const result = await pglite.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${sql}`);
        return result.rows.map((row) => row['QUERY PLAN']).join('\n');
      };
      const snippetPlan = await planFor(latestAssistantTextSql(['s1', 's2'])!);
      expect(snippetPlan.match(/idx_ai_agent_messages_latest_assistant_text/g)).toHaveLength(2);
      expect(snippetPlan).not.toContain('Sort');
      expect(await planFor(`SELECT id FROM ai_sessions WHERE workspace_id = '/ws' AND created_by_session_id = 'm1'`))
        .toContain('idx_ai_sessions_created_by_workspace');
      expect(await planFor(`SELECT id FROM ai_sessions WHERE parent_session_id = 'm1' OR created_by_session_id = 'm1'`))
        .toContain('idx_ai_sessions_created_by_workspace');
      expect(await planFor(`SELECT * FROM tracker_items WHERE workspace = '/ws'`))
        .toMatch(/idx_tracker_(workspace_sync_id|kanban_sort)/);
    } finally {
      await pglite.close();
    }
  });
});
