/**
 * Epic C Phase 2: the local-only derived relationship index. Covers rebuild
 * (delete-then-insert), backlinks/outgoing queries, and removal, against a real
 * SQLiteDatabase + migration 0014.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/mock/path'),
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
  rebuildWorkspaceRelationshipIndex,
} from '../trackerRelationshipIndexStore';
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

  it('workspace rebuild clears stale rows (deleted items drop out)', async () => {
    await rebuildItemRelationships(WS, 'ghost', [edge({ sourceItemId: 'ghost', sourceFieldId: 'dependsOn', targetItemId: 'bug-1' })], null, db);
    // 'ghost' is not in tracker_items, so a full rebuild must drop it.
    await rebuildWorkspaceRelationshipIndex(WS, () => planDefs, db);
    expect(await getOutgoingRelationships(WS, 'ghost', db)).toEqual([]);
  });
});
