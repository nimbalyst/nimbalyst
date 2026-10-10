// @vitest-environment node
/**
 * Personal page search on both live backends. PGLite stores tracker bodies as
 * JSONB, archived as BOOLEAN and timestamps as TIMESTAMPTZ; SQLite stores TEXT
 * and INTEGER. The same SQL must find the same pages in each.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGlite } from '@electric-sql/pglite';

import { translateAndBind } from '../../../database/sqlite/dialectTranslator';
import { searchPersonalPages, type PersonalSearchDb } from '../personalPagesSearch';

const WS = '/ws';
const T = '2026-10-01T00:00:00.000Z';

function seeds(json: (value: unknown) => unknown, bool: (value: boolean) => unknown): Array<{ sql: string; params: unknown[] }> {
  const page = (id: string, title: string, body: string, trashed = false) => ({
    sql: `INSERT INTO personal_page_documents (workspace_path, document_id, title, body, updated_at, trashed_at) VALUES ($1, $2, $3, $4, $5, $6)`,
    params: [WS, id, title, body, T, trashed ? T : null],
  });
  const item = (id: string, content: unknown, extra: { archived?: boolean; sync?: string; deleted?: boolean; bodyVersion?: number; type?: string } = {}) => ({
    sql: `INSERT INTO tracker_items (id, type, issue_key, data, workspace, content, body_version, archived, sync_status, deleted_at, updated)
          VALUES ($1, $11, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    params: [id, `MOD-${id}`, json({ title: `Module ${id}` }), WS, json(content), extra.bodyVersion ?? 1, bool(extra.archived ?? false),
      extra.sync ?? 'local', extra.deleted ? T : null, T, extra.type ?? 'module'],
  });
  return [
    page('doc-1', 'Ideas', '# Ideas\n\nWe chose **Yjs** over Automerge for the Café sync. Yjs again.'),
    page('doc-2', 'Old', 'Yjs in a trashed page.', true),
    page('type-page:module', 'Modules', 'A module wraps Yjs documents.'),
    page('doc-3', 'Elsewhere', 'Nothing relevant.'),
    item('a', { markdown: 'Module a body about yjs merges.' }),
    // A newer cached room body wins over the stale row.
    item('b', 'stale body', { bodyVersion: 3 }),
    { sql: `INSERT INTO tracker_body_cache (item_id, body_version, content) VALUES ($1, $2, $3)`, params: ['b', 3, json('Fresh yjs body.')] },
    item('c', 'Yjs in an archived item.', { archived: true }),
    item('d', 'Yjs in a deleted item.', { deleted: true }),
    item('e', 'Yjs in a team item.', { sync: 'synced' }),
    // An unplaced type whose page ranks highest (the word, many times over).
    item('f', 'Yjs yjs yjs yjs yjs.', { type: 'hidden' }),
  ];
}

async function summarize(db: PersonalSearchDb) {
  const yjs = await searchPersonalPages(db, WS, { query: 'yjs' });
  expect(yjs.status).toBe('ready');
  const doc = yjs.hits.find((hit) => hit.id === 'doc-1')!;
  expect(doc.highlights.map((h) => doc.snippet.slice(h.start, h.end))).toEqual(['Yjs', 'Yjs']);
  expect(doc.updatedAt).toBe(Date.parse(T));
  return {
    yjs: yjs.hits.map((hit) => [hit.kind, hit.id, hit.documentId, hit.title, hit.issueKey]).sort(),
    // Accents and case are ignored; the last term matches as a prefix; every term is required.
    cafe: (await searchPersonalPages(db, WS, { query: 'CAFE autom' })).hits.map((hit) => hit.id),
    none: (await searchPersonalPages(db, WS, { query: 'yjs postgres' })).hits,
    limited: (await searchPersonalPages(db, WS, { query: 'yjs', limit: 1 })).hits.length,
    // Typed pages of listed types only, before the limit; pages and type pages always pass.
    noTypes: (await searchPersonalPages(db, WS, { query: 'yjs', typeIds: [] })).hits.map((hit) => hit.id).sort(),
    // The higher-ranked unlisted page does not use up the limit.
    firstTyped: (await searchPersonalPages(db, WS, { query: 'yjs', limit: 1, typeIds: ['module'] })).hits.map((hit) => hit.id),
    unlisted: (await searchPersonalPages(db, WS, { query: 'yjs', typeIds: ['decision'] })).hits.filter((hit) => hit.kind === 'typed').length,
  };
}

const EXPECTED = {
  yjs: [
    ['page', 'doc-1', 'doc-1', 'Ideas', null],
    ['typePage', 'module', 'type-page:module', 'Modules', null],
    ['typed', 'a', 'tracker-content/a', 'Module a', 'MOD-a'],
    ['typed', 'b', 'tracker-content/b', 'Module b', 'MOD-b'],
    ['typed', 'f', 'tracker-content/f', 'Module f', 'MOD-f'],
  ],
  cafe: ['doc-1'],
  none: [],
  limited: 1,
  noTypes: ['doc-1', 'module'],
  firstTyped: ['b'],
  unlisted: 0,
};

describe('searchPersonalPages', () => {
  let dir: string;
  let pglite: PGlite;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'personal-search-'));
    pglite = new PGlite({ dataDir: dir });
    await pglite.exec(`
      CREATE TABLE tracker_items (id TEXT PRIMARY KEY, type TEXT NOT NULL, issue_key TEXT, data JSONB NOT NULL,
        workspace TEXT NOT NULL, content JSONB, body_version BIGINT NOT NULL DEFAULT 0, archived BOOLEAN DEFAULT FALSE,
        sync_status TEXT DEFAULT 'local', deleted_at TIMESTAMPTZ, updated TIMESTAMPTZ NOT NULL DEFAULT NOW());
      CREATE TABLE tracker_body_cache (item_id TEXT NOT NULL, body_version BIGINT NOT NULL, content TEXT NOT NULL,
        cached_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (item_id, body_version));
      CREATE TABLE personal_page_documents (workspace_path TEXT NOT NULL, document_id TEXT NOT NULL, title TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '', updated_at TIMESTAMPTZ NOT NULL, trashed_at TIMESTAMPTZ, PRIMARY KEY (workspace_path, document_id));
    `);
    for (const seed of seeds((v) => JSON.stringify(v), (v) => v)) await pglite.query(seed.sql, seed.params);
  }, 30_000);

  afterAll(async () => {
    await pglite?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('finds Personal pages, type pages and Personal typed pages by body text on PGLite', async () => {
    expect(await summarize(pglite as unknown as PersonalSearchDb)).toEqual(EXPECTED);
  });

  it('finds the same pages on SQLite after dialect translation', async () => {
    const BetterSqlite = (await import('better-sqlite3')).default;
    const sqlite = new BetterSqlite(':memory:');
    try {
      sqlite.exec(`
        CREATE TABLE tracker_items (id TEXT PRIMARY KEY, type TEXT NOT NULL, issue_key TEXT, data TEXT NOT NULL,
          workspace TEXT NOT NULL, content TEXT, body_version INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
          sync_status TEXT DEFAULT 'local', deleted_at TEXT, updated TEXT NOT NULL);
        CREATE TABLE tracker_body_cache (item_id TEXT NOT NULL, body_version INTEGER NOT NULL, content TEXT NOT NULL,
          cached_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), PRIMARY KEY (item_id, body_version));
        CREATE TABLE personal_page_documents (workspace_path TEXT NOT NULL, document_id TEXT NOT NULL, title TEXT NOT NULL,
          body TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL, trashed_at TEXT, PRIMARY KEY (workspace_path, document_id));
      `);
      const db: PersonalSearchDb = {
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
