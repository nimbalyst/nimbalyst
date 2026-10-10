// @vitest-environment node
/**
 * The marks query on both live backends. PGLite stores tracker bodies as JSONB
 * and archived as BOOLEAN; SQLite stores both as TEXT/INTEGER. The same SQL
 * must find the same marks in each, and must prefer a teammate's newer cached
 * room body over the stale local row.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGlite } from '@electric-sql/pglite';

import { translateAndBind } from '../../../database/sqlite/dialectTranslator';
import { queryPageMarks, type PageMarksDb } from '../pageMarksQuery';
import { localWikiPageMarks } from '../../localWiki/localWikiPageMarks';
import type { LocalWiki } from '@nimbalyst/local-wiki';

const WS = '/ws';
const DECIDED = '- [Use Flagship for flags.]{decided by="Greg" email=greg@example.com on=2026-09-30 over="our own engine"}';
const OPEN = 'Text [Is it fast?]{open by="Spike 6"} more';

interface Seed {
  sql: string;
  params: unknown[];
}

function seeds(json: (value: unknown) => unknown, bool: (value: boolean) => unknown): Seed[] {
  const item = (id: string, content: unknown, extra: { archived?: boolean; bodyVersion?: number; deleted?: boolean } = {}) => ({
    sql: `INSERT INTO tracker_items (id, type, issue_key, data, workspace, content, body_version, archived, sync_status, deleted_at)
          VALUES ($1, 'module', $2, $3, $4, $5, $6, $7, 'synced', $8)`,
    params: [id, `MOD-${id}`, json({ title: `Page ${id}` }), WS, json(content), extra.bodyVersion ?? 1, bool(extra.archived ?? false), extra.deleted ? '2026-09-30T00:00:00Z' : null],
  });
  return [
    item('a', { markdown: `# A\n\n${DECIDED}\n\n\`\`\`\n[fenced]{open}\n\`\`\`` }),
    // A teammate edited `b`; the room body at version 3 is cached, the row is stale.
    item('b', 'old body without marks', { bodyVersion: 3 }),
    { sql: `INSERT INTO tracker_body_cache (item_id, body_version, content) VALUES ($1, $2, $3)`, params: ['b', 3, json(OPEN)] },
    item('c', DECIDED, { archived: true }),
    item('d', DECIDED, { deleted: true }),
    {
      sql: `INSERT INTO personal_page_documents (workspace_path, document_id, title, body, trashed_at) VALUES ($1, $2, $3, $4, NULL)`,
      params: [WS, 'doc-1', 'Ideas', OPEN],
    },
    {
      sql: `INSERT INTO personal_page_documents (workspace_path, document_id, title, body, trashed_at) VALUES ($1, $2, $3, $4, NULL)`,
      params: [WS, 'type-page:module', 'Modules', DECIDED],
    },
    {
      sql: `INSERT INTO personal_page_documents (workspace_path, document_id, title, body, trashed_at) VALUES ($1, $2, $3, $4, $5)`,
      params: [WS, 'doc-2', 'Trashed', DECIDED, '2026-09-30T00:00:00Z'],
    },
  ];
}

const EXPECTED = [
  ['decided', 'Use Flagship for flags.', 'tracker://a', 'Greg', 'our own engine'],
  ['decided', 'Use Flagship for flags.', 'type://module', 'Greg', 'our own engine'],
  ['open', 'Is it fast?', 'tracker://b', 'Spike 6', null],
  ['open', 'Is it fast?', 'personal://doc-1', 'Spike 6', null],
];

async function summarize(db: PageMarksDb) {
  const marks = await queryPageMarks(db, WS);
  const byGreg = await queryPageMarks(db, WS, { email: 'Greg@Example.com' });
  expect(byGreg.map((m) => m.page.uri)).toEqual(['tracker://a', 'type://module']);
  return marks.map((m) => [m.kind, m.plainText, m.page.uri, m.by, m.over]);
}

describe('queryPageMarks', () => {
  let dir: string;
  let pglite: PGlite;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'page-marks-'));
    pglite = new PGlite({ dataDir: dir });
    await pglite.exec(`
      CREATE TABLE tracker_items (id TEXT PRIMARY KEY, type TEXT NOT NULL, issue_key TEXT, data JSONB NOT NULL,
        workspace TEXT NOT NULL, content JSONB, body_version BIGINT NOT NULL DEFAULT 0, archived BOOLEAN DEFAULT FALSE,
        sync_status TEXT DEFAULT 'local', deleted_at TIMESTAMPTZ);
      CREATE TABLE tracker_body_cache (item_id TEXT NOT NULL, body_version BIGINT NOT NULL, content TEXT NOT NULL,
        cached_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (item_id, body_version));
      CREATE TABLE personal_page_documents (workspace_path TEXT NOT NULL, document_id TEXT NOT NULL, title TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '', trashed_at TIMESTAMPTZ, PRIMARY KEY (workspace_path, document_id));
    `);
    for (const seed of seeds((v) => JSON.stringify(v), (v) => v)) await pglite.query(seed.sql, seed.params);
  }, 30_000);

  afterAll(async () => {
    await pglite?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('finds marks on PGLite', async () => {
    expect(await summarize(pglite as unknown as PageMarksDb)).toEqual(EXPECTED);
  });

  // Local pages are files now: their marks come from the wiki, and a page
  // exported from the database (same id, row kept) is listed once, from its file.
  it('adds the Local wiki files and lets an exported page\'s file replace its database row', async () => {
    const page = (id: string, title: string, type: string | null, extra: object = {}) => ({ id, title, type, hasContent: true, trashedAt: null, ...extra });
    const bodies: Record<string, string> = { 'doc-1': `Edited\n\n${DECIDED}\n`, w2: OPEN, w3: DECIDED, w4: 'no marks here' };
    const wiki = {
      snapshot: async () => ({ pages: [page('doc-1', 'Ideas', null), page('w2', 'Acme', 'competitor'), page('w3', 'Old', null, { trashedAt: 1 }), page('w4', 'Plain', null)] }),
      readBody: async (id: string) => ({ markdown: bodies[id], version: 'v' }),
    } as unknown as LocalWiki;
    const marks = await queryPageMarks(pglite as unknown as PageMarksDb, WS, {}, () => localWikiPageMarks(wiki));
    expect(marks.map((m) => [m.kind, m.page.kind, m.page.uri])).toEqual([
      ['decided', 'typed-page', 'tracker://a'],
      ['decided', 'type-page', 'type://module'],
      ['decided', 'personal-page', 'personal://doc-1'],
      ['open', 'typed-page', 'tracker://b'],
      ['open', 'typed-page', 'tracker://w2'],
    ]);
  });

  it('finds the same marks on SQLite after dialect translation', async () => {
    const BetterSqlite = (await import('better-sqlite3')).default;
    const sqlite = new BetterSqlite(':memory:');
    try {
      sqlite.exec(`
        CREATE TABLE tracker_items (id TEXT PRIMARY KEY, type TEXT NOT NULL, issue_key TEXT, data TEXT NOT NULL,
          workspace TEXT NOT NULL, content TEXT, body_version INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
          sync_status TEXT DEFAULT 'local', deleted_at TEXT);
        CREATE TABLE tracker_body_cache (item_id TEXT NOT NULL, body_version INTEGER NOT NULL, content TEXT NOT NULL,
          cached_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), PRIMARY KEY (item_id, body_version));
        CREATE TABLE personal_page_documents (workspace_path TEXT NOT NULL, document_id TEXT NOT NULL, title TEXT NOT NULL,
          body TEXT NOT NULL DEFAULT '', trashed_at TEXT, PRIMARY KEY (workspace_path, document_id));
      `);
      const db: PageMarksDb = {
        async query(sql, params = []) {
          const { sql: translated, binds } = translateAndBind(sql, params);
          const statement = sqlite.prepare(translated);
          if (statement.reader) return { rows: statement.all(binds) };
          statement.run(binds);
          return { rows: [] };
        },
      };
      for (const seed of seeds((v) => JSON.stringify(v), (v) => (v ? 1 : 0))) await db.query(seed.sql, seed.params);
      expect(await summarize(db)).toEqual(EXPECTED);
    } finally {
      sqlite.close();
    }
  });
});
