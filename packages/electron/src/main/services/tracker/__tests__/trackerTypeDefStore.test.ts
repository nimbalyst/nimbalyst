/**
 * NIM-856: the DB materialization of tracker type definitions is the local
 * source of truth for custom schemas (what the `nim` CLI and a future schema-
 * sync path read). It was shipped untested and best-effort; these cover the
 * materialize / upsert / soft-delete / un-delete lifecycle against a real
 * SQLiteDatabase + migration 0012 (the more divergent backend).
 *
 * `model` is stored as JSON TEXT, so it reads identically on PGLite — no
 * `data->'k'` sub-extraction (DATABASE.md parity).
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
  materializeTrackerTypeDef,
  materializeTrackerTypeDefs,
  removeTrackerTypeDef,
  listMaterializedTrackerTypes,
  listMaterializedTrackerTypeDefs,
  reconcileYamlTrackerTypeDefs,
  classifyTrackerSchemaDrift,
  hasSchemaDrift,
  applyRemoteTrackerSchemaDef,
  listUnsyncedTrackerSchemaDefs,
  getMaxTrackerSchemaSyncId,
} from '../trackerTypeDefStore';
import type { TrackerDataModel } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';

const SCHEMA_DIR = path.resolve(__dirname, '..', '..', '..', 'database', 'sqlite', 'schemas');
const WS = '/ws/alpha';

function model(type: string, extra?: Record<string, unknown>): TrackerDataModel {
  return { type, displayName: type, fields: [], roles: {}, ...extra } as unknown as TrackerDataModel;
}

interface TypeDefRow {
  workspace: string;
  type: string;
  model: string;
  source: string | null;
  deleted_at: string | null;
  sync_status: string | null;
}

describe('trackerTypeDefStore materialization lifecycle (SQLite, migration 0012)', () => {
  let tmp: string;
  let db: SQLiteDatabase;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-typedefs-'));
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

  async function rows(): Promise<TypeDefRow[]> {
    const r = await db.query<TypeDefRow>(`SELECT * FROM tracker_type_defs ORDER BY type ASC`);
    return r.rows;
  }

  it('materializes a single type with parseable model JSON and local status', async () => {
    await materializeTrackerTypeDef(WS, model('epic', { displayName: 'Epic' }), 'yaml', db);

    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0].type).toBe('epic');
    expect(all[0].workspace).toBe(WS);
    expect(all[0].source).toBe('yaml');
    expect(all[0].sync_status).toBe('local');
    expect(all[0].deleted_at).toBeNull();
    const parsed = JSON.parse(all[0].model);
    expect(parsed.type).toBe('epic');
    expect(parsed.displayName).toBe('Epic');
  });

  it('upserts on (workspace, type) — one row, latest model wins', async () => {
    await materializeTrackerTypeDef(WS, model('epic', { displayName: 'Old' }), 'yaml', db);
    await materializeTrackerTypeDef(WS, model('epic', { displayName: 'New' }), 'cli', db);

    const all = await rows();
    expect(all).toHaveLength(1);
    expect(JSON.parse(all[0].model).displayName).toBe('New');
    expect(all[0].source).toBe('cli');
  });

  it('keeps the same type distinct across workspaces', async () => {
    await materializeTrackerTypeDef(WS, model('epic'), 'yaml', db);
    await materializeTrackerTypeDef('/ws/beta', model('epic'), 'yaml', db);

    const all = await rows();
    expect(all).toHaveLength(2);
    expect(new Set(all.map((r) => r.workspace))).toEqual(new Set([WS, '/ws/beta']));
  });

  it('batch-materializes many types', async () => {
    await materializeTrackerTypeDefs(WS, [model('epic'), model('story'), model('spike')], 'yaml', db);
    const all = await rows();
    expect(all.map((r) => r.type)).toEqual(['epic', 'spike', 'story']);
  });

  it('soft-deletes a type (tombstone, sync pending, body retained)', async () => {
    await materializeTrackerTypeDef(WS, model('epic'), 'yaml', db);
    await removeTrackerTypeDef(WS, 'epic', db);

    const all = await rows();
    expect(all).toHaveLength(1); // row kept for sync
    expect(all[0].deleted_at).not.toBeNull();
    expect(all[0].sync_status).toBe('pending');
  });

  it('re-materializing a tombstoned type un-deletes it (DO UPDATE clears deleted_at)', async () => {
    await materializeTrackerTypeDef(WS, model('epic'), 'yaml', db);
    await removeTrackerTypeDef(WS, 'epic', db);
    await materializeTrackerTypeDef(WS, model('epic', { displayName: 'Revived' }), 'yaml', db);

    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0].deleted_at).toBeNull();
    expect(JSON.parse(all[0].model).displayName).toBe('Revived');
  });

  describe('listMaterializedTrackerTypes', () => {
    it('returns only active (non-tombstoned) rows for the workspace', async () => {
      await materializeTrackerTypeDefs(WS, [model('epic'), model('story')], 'yaml', db);
      await materializeTrackerTypeDef('/ws/beta', model('spike'), 'yaml', db);
      await removeTrackerTypeDef(WS, 'story', db);

      const active = await listMaterializedTrackerTypes(WS, db);
      expect(active.map((r) => r.type)).toEqual(['epic']);
      expect(active[0].source).toBe('yaml');
    });
  });

  describe('reconcileYamlTrackerTypeDefs (source-of-truth mirror)', () => {
    it('tombstones a YAML type whose file was deleted on disk', async () => {
      await materializeTrackerTypeDefs(WS, [model('epic'), model('story')], 'yaml', db);

      // Only 'epic' is still backed by a YAML file.
      await reconcileYamlTrackerTypeDefs(WS, ['epic'], db);

      const all = await rows();
      const epic = all.find((r) => r.type === 'epic')!;
      const story = all.find((r) => r.type === 'story')!;
      expect(epic.deleted_at).toBeNull();
      expect(story.deleted_at).not.toBeNull();
      expect(story.sync_status).toBe('pending');
    });

    it('keeps every still-loaded YAML type', async () => {
      await materializeTrackerTypeDefs(WS, [model('epic'), model('story')], 'yaml', db);
      await reconcileYamlTrackerTypeDefs(WS, ['epic', 'story'], db);

      const active = await listMaterializedTrackerTypes(WS, db);
      expect(active.map((r) => r.type).sort()).toEqual(['epic', 'story']);
    });

    it('never retracts cli/sync-sourced types (out of YAML scope)', async () => {
      await materializeTrackerTypeDef(WS, model('synced'), 'sync', db);
      await materializeTrackerTypeDef(WS, model('clitype'), 'cli', db);
      await materializeTrackerTypeDef(WS, model('epic'), 'yaml', db);

      // Empty YAML set: every yaml row should tombstone, cli/sync survive.
      await reconcileYamlTrackerTypeDefs(WS, [], db);

      const active = await listMaterializedTrackerTypes(WS, db);
      expect(active.map((r) => r.type).sort()).toEqual(['clitype', 'synced']);
    });

    it('scopes strictly to the workspace (does not touch a peer workspace)', async () => {
      await materializeTrackerTypeDef(WS, model('epic'), 'yaml', db);
      await materializeTrackerTypeDef('/ws/beta', model('epic'), 'yaml', db);

      await reconcileYamlTrackerTypeDefs(WS, [], db);

      const betaActive = await listMaterializedTrackerTypes('/ws/beta', db);
      expect(betaActive.map((r) => r.type)).toEqual(['epic']);
    });
  });

  describe('listMaterializedTrackerTypeDefs (full model)', () => {
    it('returns the stored model JSON for active rows only', async () => {
      await materializeTrackerTypeDef(WS, model('epic', { displayName: 'Epic' }), 'yaml', db);
      await materializeTrackerTypeDef(WS, model('story'), 'yaml', db);
      await removeTrackerTypeDef(WS, 'story', db);

      const full = await listMaterializedTrackerTypeDefs(WS, db);
      expect(full.map((r) => r.type)).toEqual(['epic']);
      expect(JSON.parse(full[0].model).displayName).toBe('Epic');
      expect(full[0].source).toBe('yaml');
    });
  });

  describe('applyRemoteTrackerSchemaDef (Epic B Phase 3 — inbound sync)', () => {
    const def = (type: string, m: TrackerDataModel | null, syncId: number) => ({
      type,
      model: m === null ? null : JSON.stringify(m),
      syncId,
    });

    it('ingests a peer schema into the sync lane (source=sync, status=synced, sync_id set)', async () => {
      const res = await applyRemoteTrackerSchemaDef(WS, def('epic', model('epic', { displayName: 'Epic' }), 5), db);
      expect(res).toEqual({ applied: true, deleted: false });

      const all = await rows();
      expect(all).toHaveLength(1);
      expect(all[0].type).toBe('epic');
      expect(all[0].source).toBe('sync');
      expect(all[0].sync_status).toBe('synced');
      expect(all[0].deleted_at).toBeNull();
      expect(JSON.parse(all[0].model).displayName).toBe('Epic');
      // Synced (db-native) types are surfaced by the active list for resolution.
      const active = await listMaterializedTrackerTypes(WS, db);
      expect(active.map((r) => r.type)).toEqual(['epic']);
    });

    it('is version-gated: a stale or duplicate syncId never clobbers a newer row', async () => {
      await applyRemoteTrackerSchemaDef(WS, def('epic', model('epic', { displayName: 'New' }), 10), db);

      const stale = await applyRemoteTrackerSchemaDef(WS, def('epic', model('epic', { displayName: 'Old' }), 3), db);
      expect(stale).toEqual({ applied: false, reason: 'stale' });
      const dup = await applyRemoteTrackerSchemaDef(WS, def('epic', model('epic', { displayName: 'Same' }), 10), db);
      expect(dup).toEqual({ applied: false, reason: 'stale' });

      const all = await rows();
      expect(JSON.parse(all[0].model).displayName).toBe('New');
    });

    it('a newer syncId wins and updates the model', async () => {
      await applyRemoteTrackerSchemaDef(WS, def('epic', model('epic', { displayName: 'V1' }), 1), db);
      const res = await applyRemoteTrackerSchemaDef(WS, def('epic', model('epic', { displayName: 'V2' }), 2), db);
      expect(res).toEqual({ applied: true, deleted: false });
      const all = await rows();
      expect(JSON.parse(all[0].model).displayName).toBe('V2');
    });

    it('overwrites a local (NULL sync_id) yaml row — synced definition is authoritative', async () => {
      await materializeTrackerTypeDef(WS, model('epic', { displayName: 'Local' }), 'yaml', db);
      const res = await applyRemoteTrackerSchemaDef(WS, def('epic', model('epic', { displayName: 'Team' }), 1), db);
      expect(res).toEqual({ applied: true, deleted: false });

      const all = await rows();
      expect(all).toHaveLength(1);
      expect(all[0].source).toBe('sync');
      expect(JSON.parse(all[0].model).displayName).toBe('Team');
    });

    it('a synced row is never retracted by a YAML reconcile (different lane)', async () => {
      await applyRemoteTrackerSchemaDef(WS, def('synced', model('synced'), 1), db);
      await materializeTrackerTypeDef(WS, model('epic'), 'yaml', db);

      // Empty YAML set: the yaml row tombstones, the synced row survives.
      await reconcileYamlTrackerTypeDefs(WS, [], db);

      const active = await listMaterializedTrackerTypes(WS, db);
      expect(active.map((r) => r.type)).toEqual(['synced']);
    });

    it('a null model tombstones the type, stamped synced (nothing to push back)', async () => {
      await applyRemoteTrackerSchemaDef(WS, def('epic', model('epic'), 1), db);
      const res = await applyRemoteTrackerSchemaDef(WS, def('epic', null, 2), db);
      expect(res).toEqual({ applied: true, deleted: true });

      const all = await rows();
      expect(all[0].deleted_at).not.toBeNull();
      expect(all[0].sync_status).toBe('synced');
      const active = await listMaterializedTrackerTypes(WS, db);
      expect(active).toHaveLength(0);
    });

    it('rejects an invalid delta without touching the DB', async () => {
      const res = await applyRemoteTrackerSchemaDef(WS, def('', model('x'), 1), db);
      expect(res).toEqual({ applied: false, reason: 'invalid' });
      const nan = await applyRemoteTrackerSchemaDef(WS, { type: 'epic', model: '{}', syncId: NaN }, db);
      expect(nan).toEqual({ applied: false, reason: 'invalid' });
      expect(await rows()).toHaveLength(0);
    });

    it('scopes strictly to its workspace', async () => {
      await applyRemoteTrackerSchemaDef(WS, def('epic', model('epic'), 1), db);
      const beta = await listMaterializedTrackerTypes('/ws/beta', db);
      expect(beta).toHaveLength(0);
    });
  });

  describe('listUnsyncedTrackerSchemaDefs (Epic B Phase 3 — push outbox)', () => {
    it('returns locally-originated changes and excludes synced rows', async () => {
      await materializeTrackerTypeDef(WS, model('local', { displayName: 'Local' }), 'yaml', db);
      await materializeTrackerTypeDef(WS, model('clitype'), 'cli', db);
      await applyRemoteTrackerSchemaDef(WS, { type: 'fromPeer', model: JSON.stringify(model('fromPeer')), syncId: 1 }, db);

      const out = await listUnsyncedTrackerSchemaDefs(WS, db);
      expect(out.map((r) => r.type).sort()).toEqual(['clitype', 'local']);
      const local = out.find((r) => r.type === 'local')!;
      expect(local.deleted).toBe(false);
      expect(JSON.parse(local.model!).displayName).toBe('Local');
    });

    it('surfaces a pending deletion as a null-model tombstone', async () => {
      await materializeTrackerTypeDef(WS, model('local'), 'yaml', db);
      await removeTrackerTypeDef(WS, 'local', db); // sets sync_status='pending', deleted_at set

      const out = await listUnsyncedTrackerSchemaDefs(WS, db);
      expect(out).toHaveLength(1);
      expect(out[0]).toEqual({ type: 'local', model: null, deleted: true });
    });
  });

  describe('getMaxTrackerSchemaSyncId (Epic B Phase 3 — bootstrap cursor)', () => {
    it('returns the highest applied schema sync id for the workspace', async () => {
      await applyRemoteTrackerSchemaDef(WS, { type: 'alpha', model: JSON.stringify(model('alpha')), syncId: 2 }, db);
      await applyRemoteTrackerSchemaDef(WS, { type: 'beta', model: JSON.stringify(model('beta')), syncId: 7 }, db);
      await applyRemoteTrackerSchemaDef('/ws/beta', { type: 'gamma', model: JSON.stringify(model('gamma')), syncId: 99 }, db);
      await materializeTrackerTypeDef(WS, model('local'), 'yaml', db);

      await expect(getMaxTrackerSchemaSyncId(WS, db)).resolves.toBe(7);
      await expect(getMaxTrackerSchemaSyncId('/ws/beta', db)).resolves.toBe(99);
      await expect(getMaxTrackerSchemaSyncId('/ws/empty', db)).resolves.toBe(0);
    });
  });
});

describe('classifyTrackerSchemaDrift (pure)', () => {
  function dbDef(type: string, source: string | null, m: TrackerDataModel) {
    return { type, source, model: JSON.stringify(m) };
  }

  it('reports in-sync when YAML and DB models match (ignoring key order)', () => {
    const yaml = model('epic', { displayName: 'Epic', color: '#fff' });
    // Reorder keys in the DB copy: must still be in-sync.
    const dbModel = { color: '#fff', displayName: 'Epic', type: 'epic', fields: [], roles: {} } as unknown as TrackerDataModel;
    const entries = classifyTrackerSchemaDrift([yaml], [dbDef('epic', 'yaml', dbModel)]);
    expect(entries).toEqual([{ type: 'epic', status: 'in-sync', source: 'yaml' }]);
    expect(hasSchemaDrift(entries)).toBe(false);
  });

  it('reports drifted when the definitions differ', () => {
    const yaml = model('epic', { displayName: 'Epic' });
    const dbModel = model('epic', { displayName: 'Changed' });
    const entries = classifyTrackerSchemaDrift([yaml], [dbDef('epic', 'yaml', dbModel)]);
    expect(entries).toEqual([{ type: 'epic', status: 'drifted', source: 'yaml' }]);
    expect(hasSchemaDrift(entries)).toBe(true);
  });

  it('reports yaml-only when the DB has no row yet', () => {
    const entries = classifyTrackerSchemaDrift([model('epic')], []);
    expect(entries).toEqual([{ type: 'epic', status: 'yaml-only', source: null }]);
    expect(hasSchemaDrift(entries)).toBe(true);
  });

  it('reports db-only-orphan for a YAML-sourced row with no file', () => {
    const entries = classifyTrackerSchemaDrift([], [dbDef('epic', 'yaml', model('epic'))]);
    expect(entries).toEqual([{ type: 'epic', status: 'db-only-orphan', source: 'yaml' }]);
    expect(hasSchemaDrift(entries)).toBe(true);
  });

  it('reports db-native (not a warning) for cli/sync-sourced rows with no file', () => {
    const entries = classifyTrackerSchemaDrift(
      [],
      [dbDef('clitype', 'cli', model('clitype')), dbDef('synced', 'sync', model('synced'))],
    );
    expect(entries.map((e) => e.status)).toEqual(['db-native', 'db-native']);
    expect(hasSchemaDrift(entries)).toBe(false);
  });

  it('classifies a mixed set deterministically (sorted by type)', () => {
    const entries = classifyTrackerSchemaDrift(
      [model('alpha'), model('beta', { displayName: 'B' })],
      [
        dbDef('beta', 'yaml', model('beta', { displayName: 'Different' })),
        dbDef('gamma', 'yaml', model('gamma')),
      ],
    );
    expect(entries).toEqual([
      { type: 'alpha', status: 'yaml-only', source: null },
      { type: 'beta', status: 'drifted', source: 'yaml' },
      { type: 'gamma', status: 'db-only-orphan', source: 'yaml' },
    ]);
  });
});
