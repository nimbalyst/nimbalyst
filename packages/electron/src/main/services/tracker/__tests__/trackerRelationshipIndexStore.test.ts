/**
 * Epic C Phase 2: the local-only derived relationship index. Covers rebuild
 * (delete-then-insert), backlinks/outgoing queries, and removal, against a real
 * SQLiteDatabase + migration 0014.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
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

import { SQLiteDatabase } from '../../../database/sqlite/SQLiteDatabase';
import {
  rebuildItemRelationships,
  removeItemRelationships,
  getBacklinks,
  getOutgoingRelationships,
  reindexItemRelationships,
  reindexItemRelationshipsAfterWrite,
  rebuildWorkspaceRelationshipIndex,
} from '../trackerRelationshipIndexStore';
import { ensureWorkspaceRelationshipIndex } from '../trackerRelationshipIndexStore';
import { getTrackerItemLinks } from '../trackerPageLinks';
import { refreshRemoteBodyLinks } from '../trackerRemoteBodyLinks';
import type { RelationshipEdge, FieldDefinition } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';

const SCHEMA_DIR = path.resolve(__dirname, '..', '..', '..', 'database', 'sqlite', 'schemas');
const WS = '/ws/alpha';

function edge(p: Partial<RelationshipEdge> & { sourceItemId: string; sourceFieldId: string; targetItemId: string }): RelationshipEdge {
  return p;
}

describe('trackerRelationshipIndexStore (SQLite, migration 0014)', () => {
  let tmp: string;
  let db: SQLiteDatabase;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-relindex-'));
    db = new SQLiteDatabase({
      dbDir: path.join(tmp, 'sqlite-db'),
      schemaDir: SCHEMA_DIR,
      slowQueryThresholdMs: 1000,
      sampleRate: 0,
    });
    await db.initialize();
  });

  afterEach(async () => {
    await db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('rebuilds outgoing edges and reads them back', async () => {
    await rebuildItemRelationships(WS, 'plan-1', [
      edge({ sourceItemId: 'plan-1', sourceFieldId: 'dependsOn', targetItemId: 'bug-1', relationshipTypeKey: 'depends-on', targetTrackerType: 'bug', metadata: { note: 'x' } }),
      edge({ sourceItemId: 'plan-1', sourceFieldId: 'dependsOn', targetItemId: 'bug-2', relationshipTypeKey: 'depends-on' }),
    ], '2026-06-16T00:00:00Z', db);

    const out = await getOutgoingRelationships(WS, 'plan-1', db);
    expect(out.map((r) => r.targetItemId).sort()).toEqual(['bug-1', 'bug-2']);
    expect(out.find((r) => r.targetItemId === 'bug-1')?.metadata).toEqual({ note: 'x' });
    expect(out[0].relationshipTypeKey).toBe('depends-on');
  });

  it('replaces prior edges on rebuild (delete-then-insert)', async () => {
    await rebuildItemRelationships(WS, 'plan-1', [
      edge({ sourceItemId: 'plan-1', sourceFieldId: 'dependsOn', targetItemId: 'bug-1' }),
      edge({ sourceItemId: 'plan-1', sourceFieldId: 'dependsOn', targetItemId: 'bug-2' }),
    ], null, db);

    // Re-write with only bug-3.
    await rebuildItemRelationships(WS, 'plan-1', [
      edge({ sourceItemId: 'plan-1', sourceFieldId: 'dependsOn', targetItemId: 'bug-3' }),
    ], null, db);

    const out = await getOutgoingRelationships(WS, 'plan-1', db);
    expect(out.map((r) => r.targetItemId)).toEqual(['bug-3']);
  });

  it('resolves backlinks (incoming edges) from multiple sources', async () => {
    await rebuildItemRelationships(WS, 'plan-1', [edge({ sourceItemId: 'plan-1', sourceFieldId: 'dependsOn', targetItemId: 'bug-1' })], null, db);
    await rebuildItemRelationships(WS, 'plan-2', [edge({ sourceItemId: 'plan-2', sourceFieldId: 'blocks', targetItemId: 'bug-1' })], null, db);

    const back = await getBacklinks(WS, 'bug-1', db);
    expect(back.map((r) => r.sourceItemId).sort()).toEqual(['plan-1', 'plan-2']);
  });

  it('removes all outgoing edges for a deleted item (incoming danglers untouched)', async () => {
    await rebuildItemRelationships(WS, 'plan-1', [edge({ sourceItemId: 'plan-1', sourceFieldId: 'dependsOn', targetItemId: 'bug-1' })], null, db);
    await rebuildItemRelationships(WS, 'plan-2', [edge({ sourceItemId: 'plan-2', sourceFieldId: 'dependsOn', targetItemId: 'plan-1' })], null, db);

    await removeItemRelationships(WS, 'plan-1', db);

    expect(await getOutgoingRelationships(WS, 'plan-1', db)).toEqual([]);
    // plan-2 -> plan-1 edge survives as a dangler (incoming to the deleted item).
    expect((await getBacklinks(WS, 'plan-1', db)).map((r) => r.sourceItemId)).toEqual(['plan-2']);
  });

  it('scopes strictly to the workspace', async () => {
    await rebuildItemRelationships(WS, 'plan-1', [edge({ sourceItemId: 'plan-1', sourceFieldId: 'dependsOn', targetItemId: 'bug-1' })], null, db);
    await rebuildItemRelationships('/ws/beta', 'plan-1', [edge({ sourceItemId: 'plan-1', sourceFieldId: 'dependsOn', targetItemId: 'bug-9' })], null, db);

    const out = await getOutgoingRelationships(WS, 'plan-1', db);
    expect(out.map((r) => r.targetItemId)).toEqual(['bug-1']);
  });

  const planDefs: FieldDefinition[] = [
    { name: 'title', type: 'string' },
    { name: 'dependsOn', type: 'relationship', relationshipTypeKey: 'depends-on', multiValue: true },
  ];

  it('reindexItemRelationships derives edges from a fields bag', async () => {
    await reindexItemRelationships(
      WS, 'plan-1',
      { title: 'P', dependsOn: [{ itemId: 'bug-1', trackerType: 'bug' }, { itemId: 'bug-2' }] },
      planDefs, '2026-06-16T00:00:00Z', db,
    );
    const out = await getOutgoingRelationships(WS, 'plan-1', db);
    expect(out.map((r) => r.targetItemId).sort()).toEqual(['bug-1', 'bug-2']);
    expect(out.find((r) => r.targetItemId === 'bug-1')?.targetTrackerType).toBe('bug');
  });

  // The write-path hook. Before it existed the index was maintained only by the
  // renderer's reindex IPC, so anything written by MCP, the CLI or the commit
  // linker stored relationship values and produced no edges at all.
  it('reindexItemRelationshipsAfterWrite indexes a relationship set at write time', async () => {
    await reindexItemRelationshipsAfterWrite(
      WS, 'plan-1',
      { title: 'P', dependsOn: [{ itemId: 'bug-1', trackerType: 'bug' }] },
      planDefs, '2026-06-16T00:00:00Z', db,
    );
    const out = await getOutgoingRelationships(WS, 'plan-1', db);
    expect(out.map((r) => r.targetItemId)).toEqual(['bug-1']);
  });

  it('reindexItemRelationshipsAfterWrite leaves a type with no relationship fields alone', async () => {
    // Every tracker save would otherwise pay a delete for nothing.
    const querySpy = vi.spyOn(db, 'query');
    await reindexItemRelationshipsAfterWrite(
      WS, 'note-1', { title: 'N' },
      [{ name: 'title', type: 'string' } as FieldDefinition],
      '2026-06-16T00:00:00Z', db,
    );
    expect(querySpy).not.toHaveBeenCalled();
    querySpy.mockRestore();
  });

  it('reindexItemRelationshipsAfterWrite never lets an index failure fail the write', async () => {
    // The index is a rebuildable projection. A tracker item that saved must not
    // be rolled back because its projection could not be written.
    const failing = { query: () => Promise.reject(new Error('index is gone')) };
    await expect(
      reindexItemRelationshipsAfterWrite(
        WS, 'plan-1',
        { dependsOn: [{ itemId: 'bug-1' }] },
        planDefs, null, failing as never,
      ),
    ).resolves.toBeUndefined();
  });

  it('rebuildWorkspaceRelationshipIndex indexes all items from tracker_items JSON', async () => {
    // Seed tracker_items rows directly (relationship values live at data[field]).
    const insert = (id: string, type: string, data: object) =>
      db.query(
        `INSERT INTO tracker_items (id, type, data, workspace, created, updated, last_indexed, sync_status, archived, source)
         VALUES ($1, $2, $3, $4, NOW(), NOW(), NOW(), 'local', FALSE, 'native')`,
        [id, type, JSON.stringify(data), WS],
      );
    await insert('plan-1', 'plan', { title: 'P1', dependsOn: [{ itemId: 'bug-1' }] });
    await insert('plan-2', 'plan', { title: 'P2', dependsOn: [{ itemId: 'bug-1' }, { itemId: 'bug-2' }] });
    await insert('bug-1', 'bug', { title: 'B1' }); // no relationship fields

    const count = await rebuildWorkspaceRelationshipIndex(WS, (type) => (type === 'plan' ? planDefs : []), db);
    expect(count).toBe(3); // plan-1:1 + plan-2:2

    const back = await getBacklinks(WS, 'bug-1', db);
    expect(back.map((r) => r.sourceItemId).sort()).toEqual(['plan-1', 'plan-2']);
  });

  describe('body links', () => {
    const insertItem = (id: string, type: string, data: object, issueKey: string | null, content: string | null = null) =>
      db.query(
        `INSERT INTO tracker_items (id, type, data, workspace, created, updated, last_indexed, sync_status, archived, source, issue_key, content)
         VALUES ($1, $2, $3, $4, NOW(), NOW(), NOW(), 'local', FALSE, 'native', $5, $6)`,
        [id, type, JSON.stringify(data), WS, issueKey, content],
      );

    beforeEach(async () => {
      await insertItem('page-1', 'concept', { title: 'Sync' }, 'NIM-1');
      await insertItem('page-2', 'concept', { title: 'Yjs' }, 'NIM-2');
      await insertItem('page_raw3', 'concept', { title: 'Durable Objects' }, null);
    });

    const BODY = [
      '# Overview',
      '',
      'Sync is built on [Yjs](nimbalyst://NIM-2 "view=card rel=built-on") for merging. It also stores rooms.',
      '- Rooms live in [DOs](nimbalyst://page_raw3 "rel=runs-on view=inline").',
      'See [the Yjs page](nimbalyst://NIM-2) and again [Yjs](nimbalyst://NIM-2 "rel=built-on").',
      'Self: [me](nimbalyst://NIM-1 "rel=built-on"). Ghost: [x](nimbalyst://NIM-999).',
    ].join('\n');

    it('derives one row per (target, relation) and skips self and unresolvable links', async () => {
      await reindexItemRelationshipsAfterWrite(WS, 'page-1', { title: 'Sync' }, [], null, db, BODY);
      const out = await getOutgoingRelationships(WS, 'page-1', db);
      expect(out.map((r) => [r.sourceFieldId, r.targetItemId, r.relationshipTypeKey, r.predicate])).toEqual([
        ['body:built-on', 'page-2', 'built-on', 'built-on'],
        ['body:link', 'page-2', 'link', null],
        ['body:runs-on', 'page_raw3', 'runs-on', 'runs-on'],
      ]);
      const builtOn = out.find((r) => r.sourceFieldId === 'body:built-on')!;
      expect(builtOn.targetTrackerType).toBe('concept');
      expect(builtOn.metadata).toEqual({ sentence: 'Sync is built on Yjs for merging.', count: 2 });
      expect(out.find((r) => r.sourceFieldId === 'body:runs-on')!.metadata).toEqual({
        sentence: 'Rooms live in DOs.',
        count: 1,
      });
      // The incoming side reads the same rows.
      expect((await getBacklinks(WS, 'page-2', db)).map((r) => r.sourceFieldId).sort()).toEqual(['body:built-on', 'body:link']);
    });

    it('re-deriving a body drops removed links and keeps field-derived rows', async () => {
      await reindexItemRelationshipsAfterWrite(
        WS, 'page-1', { dependsOn: [{ itemId: 'page-2' }] }, planDefs, null, db, BODY,
      );
      // A fields-only write must not wipe the body rows.
      await reindexItemRelationshipsAfterWrite(WS, 'page-1', { dependsOn: [{ itemId: 'page-2' }] }, planDefs, null, db);
      expect((await getOutgoingRelationships(WS, 'page-1', db)).length).toBe(4);

      await reindexItemRelationshipsAfterWrite(
        WS, 'page-1', {}, [], null, db, 'Only [Yjs](nimbalyst://NIM-2 "rel=built-on") now',
      );
      const out = await getOutgoingRelationships(WS, 'page-1', db);
      expect(out.map((r) => r.sourceFieldId)).toEqual(['body:built-on', 'dependsOn']);
      expect(out[0].metadata).toEqual({ sentence: 'Only Yjs now', count: 1 });
    });

    it('accepts the { markdown } content shape and the workspace rebuild indexes bodies', async () => {
      await db.query(`UPDATE tracker_items SET content = $1 WHERE id = 'page-1'`, [JSON.stringify({ markdown: BODY })]);
      await rebuildWorkspaceRelationshipIndex(WS, () => [], db);
      const out = await getOutgoingRelationships(WS, 'page-1', db);
      expect(out.map((r) => r.sourceFieldId)).toEqual(['body:built-on', 'body:link', 'body:runs-on']);
    });

    it('getTrackerItemLinks lists both directions with resolved titles and the field predicate', async () => {
      await db.query(`UPDATE tracker_items SET content = $1 WHERE id = 'page-1'`, [JSON.stringify(BODY)]);
      await db.query(`UPDATE tracker_items SET data = $1 WHERE id = 'page_raw3'`, [
        JSON.stringify({ title: 'Durable Objects', uses: [{ itemId: 'page-2' }] }),
      ]);
      const defs = (type: string): FieldDefinition[] => (type === 'concept'
        ? [{ name: 'uses', type: 'relationship', multiValue: true, predicate: 'uses' } as FieldDefinition]
        : []);

      const links = await getTrackerItemLinks(WS, 'page-2', defs, db);
      expect(links).toEqual([
        { direction: 'in', predicateId: 'built-on', relationshipTypeKey: 'built-on', otherItemId: 'page-1', otherTitle: 'Sync',
          otherIssueKey: 'NIM-1', otherTypeId: 'concept', sentence: 'Sync is built on Yjs for merging.', sourceFieldId: 'body:built-on' },
        { direction: 'in', predicateId: null, relationshipTypeKey: 'link', otherItemId: 'page-1', otherTitle: 'Sync',
          otherIssueKey: 'NIM-1', otherTypeId: 'concept', sentence: 'See the Yjs page and again Yjs.', sourceFieldId: 'body:link' },
        { direction: 'in', predicateId: 'uses', relationshipTypeKey: null, otherItemId: 'page_raw3', otherTitle: 'Durable Objects',
          otherIssueKey: null, otherTypeId: 'concept', sentence: null, sourceFieldId: 'uses' },
      ]);
      expect((await getTrackerItemLinks(WS, 'page_raw3', defs, db)).map((l) => [l.direction, l.otherItemId, l.sourceFieldId]))
        .toEqual([['out', 'page-2', 'uses'], ['in', 'page-1', 'body:runs-on']]);
    });

    it('getTrackerItemLinks carries a value-level relationshipTypeKey override for field edges', async () => {
      await db.query(`UPDATE tracker_items SET data = $1 WHERE id = 'page-1'`, [
        JSON.stringify({ title: 'Sync', related: [{ itemId: 'page-2', relationshipTypeKey: 'blocks' }] }),
      ]);
      const defs = (): FieldDefinition[] => [
        { name: 'related', type: 'relationship', multiValue: true, relationshipTypeKey: 'depends-on' } as FieldDefinition,
      ];
      const [link] = await getTrackerItemLinks(WS, 'page-2', defs, db);
      expect([link.sourceFieldId, link.predicateId, link.relationshipTypeKey]).toEqual(['related', null, 'blocks']);
    });

    it('getTrackerItemLinks is scoped to the caller workspace', async () => {
      await db.query(`UPDATE tracker_items SET content = $1 WHERE id = 'page-1'`, [JSON.stringify(BODY)]);
      expect(await getTrackerItemLinks('/ws/other', 'page-2', () => [], db)).toEqual([]);
      expect((await getTrackerItemLinks(WS, 'page-2', () => [], db)).length).toBe(2);
    });

    it('tombstoned items are neither link targets, link sources, nor listed', async () => {
      const tombstone = (id: string) =>
        db.query(`UPDATE tracker_items SET deleted_at = '2026-10-01T00:00:00Z' WHERE id = $1`, [id]);
      await db.query(`UPDATE tracker_items SET content = $1 WHERE id = 'page-1'`, [JSON.stringify(BODY)]);
      await db.query(`UPDATE tracker_items SET content = $1 WHERE id = 'page_raw3'`, [JSON.stringify('Uses [Yjs](nimbalyst://NIM-2)')]);
      await tombstone('page_raw3');
      // Target resolution skips a tombstoned target.
      await reindexItemRelationshipsAfterWrite(WS, 'page-1', {}, [], null, db, BODY);
      expect((await getOutgoingRelationships(WS, 'page-1', db)).map((r) => r.targetItemId)).not.toContain('page_raw3');
      // The workspace rebuild derives nothing from a tombstoned source.
      await rebuildWorkspaceRelationshipIndex(WS, () => [], db);
      expect(await getOutgoingRelationships(WS, 'page_raw3', db)).toEqual([]);
      // The title lookup drops an edge whose other end is tombstoned, even if the
      // index still holds it (the lazy rebuild is within its TTL here).
      await ensureWorkspaceRelationshipIndex(WS, () => [], db);
      await rebuildItemRelationships(WS, 'page_raw3', [edge({ sourceItemId: 'page_raw3', sourceFieldId: 'uses', targetItemId: 'page-2' })], null, db);
      expect((await getTrackerItemLinks(WS, 'page-2', () => [], db)).map((l) => l.otherItemId)).toEqual(['page-1', 'page-1']);
      // A tombstoned item has no Links section at all.
      await tombstone('page-2');
      expect(await getTrackerItemLinks(WS, 'page-2', () => [], db)).toEqual([]);
    });

    it('a shared item whose body exists only in tracker_body_cache yields body edges after the rebuild', async () => {
      // Remote metadata sync bumps body_version but never writes `content`.
      await db.query(
        `UPDATE tracker_items SET sync_id = 7, sync_status = 'synced', body_version = 3, content = NULL WHERE id = 'page-1'`,
      );
      const cache = (version: number, markdown: string) => db.query(
        `INSERT INTO tracker_body_cache (item_id, body_version, content, cached_at) VALUES ($1, $2, $3, NOW())`,
        ['page-1', version, JSON.stringify(markdown)],
      );
      await cache(2, 'Old body with no links');
      await cache(3, BODY);
      await rebuildWorkspaceRelationshipIndex(WS, () => [], db);
      expect((await getOutgoingRelationships(WS, 'page-1', db)).map((r) => r.sourceFieldId))
        .toEqual(['body:built-on', 'body:link', 'body:runs-on']);
    });

    it('refreshRemoteBodyLinks fetches a newer remote body once, caches it, and indexes its links', async () => {
      await db.query(`UPDATE tracker_items SET sync_id = 7, body_version = 4 WHERE id = 'page-1'`);
      const readBody = vi.fn(async () => BODY);
      expect(await refreshRemoteBodyLinks(WS, 'page-1', 4, { readBody, db })).toBe(true);
      expect((await getOutgoingRelationships(WS, 'page-1', db)).length).toBe(3);
      const cached = await db.query(`SELECT content FROM tracker_body_cache WHERE item_id = 'page-1' AND body_version = 4`);
      expect(JSON.parse((cached as any).rows[0].content)).toBe(BODY);
      // An echo of the same version (or our own write) does not refetch.
      expect(await refreshRemoteBodyLinks(WS, 'page-1', 4, { readBody, db })).toBe(false);
      expect(readBody).toHaveBeenCalledTimes(1);
      // An unreachable room leaves the index as it was.
      expect(await refreshRemoteBodyLinks(WS, 'page-1', 5, { readBody: async () => null, db })).toBe(false);
      expect((await getOutgoingRelationships(WS, 'page-1', db)).length).toBe(3);
    });

    it('ignores links inside fenced code, inline code, and escaped brackets', async () => {
      const body = [
        'Real: [Yjs](nimbalyst://NIM-2 "rel=built-on").',
        '```md',
        'Example: [DOs](nimbalyst://page_raw3 "rel=runs-on")',
        '```',
        '~~~',
        '[DOs](nimbalyst://page_raw3 "rel=fenced-tilde")',
        '~~~',
        'Inline `[DOs](nimbalyst://page_raw3 "rel=inline-code")` here.',
        'Escaped \\[DOs](nimbalyst://page_raw3 "rel=escaped") here.',
      ].join('\n');
      await reindexItemRelationshipsAfterWrite(WS, 'page-1', {}, [], null, db, body);
      expect((await getOutgoingRelationships(WS, 'page-1', db)).map((r) => r.sourceFieldId)).toEqual(['body:built-on']);
    });
  });

  it('concurrent readers wait for an in-flight workspace rebuild', async () => {
    const ws = '/ws/concurrent';
    await db.query(
      `INSERT INTO tracker_items (id, type, data, workspace, created, updated, last_indexed, sync_status, archived, source)
       VALUES ('c-1', 'plan', $1, $2, NOW(), NOW(), NOW(), 'local', FALSE, 'native')`,
      [JSON.stringify({ dependsOn: [{ itemId: 'b-1' }, { itemId: 'b-2' }] }), ws],
    );
    // Slow every insert so the first rebuild is mid-flight when the second reader arrives.
    const slow = {
      query: async (sql: string, params?: unknown[]) => {
        if (/INSERT INTO tracker_relationship_index/.test(sql)) await new Promise((r) => setTimeout(r, 20));
        return db.query(sql, params as any);
      },
    };
    const first = ensureWorkspaceRelationshipIndex(ws, () => planDefs, slow);
    await new Promise((r) => setTimeout(r, 5));
    await ensureWorkspaceRelationshipIndex(ws, () => planDefs, slow);
    expect((await getOutgoingRelationships(ws, 'c-1', db)).length).toBe(2);
    await first;
  });

  it('records the field predicate on field-derived edges', async () => {
    await reindexItemRelationships(
      WS, 'plan-1', { dependsOn: [{ itemId: 'bug-1' }] },
      [{ name: 'dependsOn', type: 'relationship', multiValue: true, predicate: 'depends-on' } as FieldDefinition],
      null, db,
    );
    expect((await getOutgoingRelationships(WS, 'plan-1', db))[0].predicate).toBe('depends-on');
  });

  it('workspace rebuild clears stale rows (deleted items drop out)', async () => {
    await rebuildItemRelationships(WS, 'ghost', [edge({ sourceItemId: 'ghost', sourceFieldId: 'dependsOn', targetItemId: 'bug-1' })], null, db);
    // 'ghost' is not in tracker_items, so a full rebuild must drop it.
    await rebuildWorkspaceRelationshipIndex(WS, () => planDefs, db);
    expect(await getOutgoingRelationships(WS, 'ghost', db)).toEqual([]);
  });
});
