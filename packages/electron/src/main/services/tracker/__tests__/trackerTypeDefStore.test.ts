// @vitest-environment node

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
  materializeYamlTrackerTypeDef,
  markTrackerTypeDefProjected,
} from '../trackerTypeDefStore';
import { registerTrackerSchemaFlushHandler, TRACKER_SCHEMA_FLUSH_DEBOUNCE_MS } from '../trackerSchemaFlush';
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
  sync_id: number | null;
  synced_model: string | null;
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

    it('is version-gated: an older syncId never clobbers a newer row, and re-delivery is idempotent', async () => {
      await applyRemoteTrackerSchemaDef(WS, def('epic', model('epic', { displayName: 'New' }), 10), db);

      const stale = await applyRemoteTrackerSchemaDef(WS, def('epic', model('epic', { displayName: 'Old' }), 3), db);
      expect(stale).toEqual({ applied: false, reason: 'stale' });
      // Same version AND same content: nothing to do. (Same version with
      // DIFFERENT content is a diverged row and heals -- see the repair suite.)
      const dup = await applyRemoteTrackerSchemaDef(WS, def('epic', model('epic', { displayName: 'New' }), 10), db);
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

  describe('team-owned schemas beat local YAML (#1178)', () => {
    // A workspace load re-reads .nimbalyst/trackers/*.yaml and mirrors every model
    // it finds. When the team already shares that type, the shared definition is
    // authoritative: the YAML write must not overwrite it, must not steal the row
    // back into the yaml lane, and must not strand `sync_id` on a stale model --
    // the bootstrap cursor is MAX(sync_id), so a clobbered row is never re-sent.
    const shared = model('bug', { displayName: 'Bug', fields: [{ name: 'collection' }] });
    const staleYaml = model('bug', { displayName: 'Bug', fields: [] });
    const def = (type: string, m: TrackerDataModel, syncId: number) => ({
      type,
      model: JSON.stringify(m),
      syncId,
    });

    it('a stale YAML load never clobbers the shared definition', async () => {
      await applyRemoteTrackerSchemaDef(WS, def('bug', shared, 14), db);

      await materializeYamlTrackerTypeDef(WS, staleYaml, db);

      const all = await rows();
      expect(JSON.parse(all[0].model)).toEqual(shared);
      expect(all[0].source).toBe('sync');
      expect(all[0].sync_id).toBe(14);
      expect(all[0].synced_model).toBeNull();
      expect(all[0].sync_status).toBe('synced');
    });

    it('does not queue a stale YAML load for push', async () => {
      await applyRemoteTrackerSchemaDef(WS, def('bug', shared, 14), db);
      await materializeYamlTrackerTypeDef(WS, staleYaml, db);

      expect(await listUnsyncedTrackerSchemaDefs(WS, db)).toEqual([]);
    });

    it('a personal YAML model clears obsolete team ownership during migration', async () => {
      await applyRemoteTrackerSchemaDef(WS, def('bug', shared, 14), db);
      const personal = model('bug', {
        displayName: 'Personal bugs',
        sharing: 'personal',
        draftByDefault: false,
      });

      await materializeYamlTrackerTypeDef(WS, personal, db);

      const all = await rows();
      expect(JSON.parse(all[0].model)).toEqual(personal);
      expect(all[0].source).toBe('yaml');
      expect(all[0].sync_status).toBe('local');
      expect(all[0].sync_id).toBeNull();
      expect(all[0].synced_model).toBeNull();
      expect(await listUnsyncedTrackerSchemaDefs(WS, db)).toEqual([]);
    });

    it('a YAML edit made AFTER the shared definition landed is queued for push', async () => {
      await applyRemoteTrackerSchemaDef(WS, def('bug', shared, 14), db);
      // Write-back projected `shared` onto disk; the user then edits that file.
      await markTrackerTypeDefProjected(WS, 'bug', JSON.stringify(shared), db);
      const edited = model('bug', { displayName: 'Defect', fields: [{ name: 'collection' }] });
      await materializeYamlTrackerTypeDef(WS, edited, db);

      const out = await listUnsyncedTrackerSchemaDefs(WS, db);
      expect(out).toHaveLength(1);
      expect(JSON.parse(out[0].model!)).toEqual(edited);
      const all = await rows();
      expect(JSON.parse(all[0].model)).toEqual(edited);
      expect(all[0].sync_id).toBe(14); // still team-owned; server assigns the next version
      expect(JSON.parse(all[0].synced_model!)).toEqual(shared); // baseline stays server truth
      expect(out[0].createOnly).toBeUndefined(); // an edit of the room's type is an update
    });

    it('pushes a team type the room has never held as create-only, so it cannot replace a concurrent one', async () => {
      const customer = model('customer', { displayName: 'Customer', sharing: 'team' });
      await materializeYamlTrackerTypeDef(WS, customer, db);

      const out = await listUnsyncedTrackerSchemaDefs(WS, db);
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ type: 'customer', deleted: false, createOnly: 'whenSupported' });
    });

    it('asks the connected engine to push a queued edit instead of waiting for a reconnect (NIM-6654)', async () => {
      // Let flushes debounced by earlier tests on this workspace fire unobserved.
      await new Promise(resolve => setTimeout(resolve, TRACKER_SCHEMA_FLUSH_DEBOUNCE_MS + 20));
      const flush = vi.fn();
      const unregister = registerTrackerSchemaFlushHandler(flush);
      try {
        await applyRemoteTrackerSchemaDef(WS, def('bug', shared, 14), db);
        await markTrackerTypeDefProjected(WS, 'bug', JSON.stringify(shared), db);
        await materializeYamlTrackerTypeDef(
          WS,
          model('bug', { displayName: 'Defect', fields: [{ name: 'collection' }] }),
          db,
        );
        // A brand-new team type and a deletion enter the same outbox.
        await materializeYamlTrackerTypeDef(WS, model('ontology-proposal', { sharing: 'team' }), db);
        await removeTrackerTypeDef(WS, 'ontology-proposal', db);

        await vi.waitFor(() => expect(flush).toHaveBeenCalledWith(WS));
        // Debounced: a burst of saves is one push, not one per write.
        expect(flush).toHaveBeenCalledTimes(1);
      } finally {
        unregister();
      }
    });

    it('carries the full activity trail forward and attributes a real YAML edit', async () => {
      const priorActivity = {
        id: 'activity_1',
        authorIdentity: { displayName: 'Alice' },
        action: 'schema_updated',
        field: 'schema',
        timestamp: 1,
      };
      const sharedWithHistory = { ...shared, activity: [priorActivity] } as TrackerDataModel;
      await applyRemoteTrackerSchemaDef(WS, def('bug', sharedWithHistory, 14), db);
      await markTrackerTypeDefProjected(WS, 'bug', JSON.stringify(sharedWithHistory), db);
      const edited = model('bug', { displayName: 'Defect', fields: [{ name: 'collection' }] });

      await materializeYamlTrackerTypeDef(WS, edited, db, {
        activity: {
          authorIdentity: { displayName: 'Bob' },
          action: 'schema_updated',
          details: { field: 'schema' },
        },
      });

      const stored = JSON.parse((await rows())[0].model);
      expect(stored.activity).toEqual([
        priorActivity,
        expect.objectContaining({
          authorIdentity: { displayName: 'Bob' },
          action: 'schema_updated',
          field: 'schema',
        }),
      ]);
    });

    it('takes a caller-supplied baseline from the row itself and queues the edit against it', async () => {
      // The watcher knows a file was just edited; this layer does not. When it
      // supplies the missing baseline, the shared model is already in hand on
      // the row -- no second read, and no projection to disk.
      await applyRemoteTrackerSchemaDef(WS, def('bug', shared, 14), db);
      const edited = model('bug', { displayName: 'Defect', fields: [{ name: 'collection' }] });
      const offered: string[] = [];

      await materializeYamlTrackerTypeDef(WS, edited, db, {
        establishBaseline: (sharedJson) => { offered.push(sharedJson); return sharedJson; },
      });

      expect(offered.map((j) => JSON.parse(j))).toEqual([shared]);
      const all = await rows();
      expect(JSON.parse(all[0].synced_model!)).toEqual(shared);
      expect(JSON.parse(all[0].model)).toEqual(edited);
      expect(all[0].sync_id).toBe(14);
      expect(await listUnsyncedTrackerSchemaDefs(WS, db)).toHaveLength(1);
    });

    it('never tombstones a team-owned row whose YAML file is gone', async () => {
      // The exact shape a pre-fix database is in: yaml-sourced row that later
      // received a sync_id. Reconcile keyed on source='yaml' would push a
      // team-wide schema deletion just because one member deleted a local file.
      await materializeTrackerTypeDef(WS, staleYaml, 'yaml', db);
      await db.query(`UPDATE tracker_type_defs SET sync_id = 14 WHERE type = 'bug'`);

      await reconcileYamlTrackerTypeDefs(WS, [], db);

      const active = await listMaterializedTrackerTypes(WS, db);
      expect(active.map((r) => r.type)).toEqual(['bug']);
    });
  });

  describe('the server definition repairs a diverged local row (#1178)', () => {
    // Schemas bootstrap from sync_id=0 on every connect, so the server re-offers
    // the version we already claim to have. When our stored model does not match
    // it, ours is wrong -- the server is the authority for a shared type and must
    // be able to heal a row without the user deleting anything.
    const server = model('bug', { displayName: 'Bug', fields: [{ name: 'collection' }] });
    const diverged = model('bug', { displayName: 'Bug', fields: [] });
    const def = (m: TrackerDataModel | null, syncId: number) => ({
      type: 'bug',
      model: m ? JSON.stringify(m) : null,
      syncId,
    });

    it('re-applies the server model at the SAME syncId when ours diverged', async () => {
      await applyRemoteTrackerSchemaDef(WS, def(server, 14), db);
      // However it happened (an older build's YAML clobber), our row now holds a
      // different model under the same version.
      await db.query(`UPDATE tracker_type_defs SET model = $1 WHERE type = 'bug'`, [
        JSON.stringify(diverged),
      ]);

      const res = await applyRemoteTrackerSchemaDef(WS, def(server, 14), db);

      expect(res).toEqual({ applied: true, deleted: false });
      const all = await rows();
      expect(JSON.parse(all[0].model)).toEqual(server);
    });

    it('is a no-op when our row already matches (no reconnect churn)', async () => {
      await applyRemoteTrackerSchemaDef(WS, def(server, 14), db);

      const res = await applyRemoteTrackerSchemaDef(WS, def(server, 14), db);

      expect(res).toEqual({ applied: false, reason: 'stale' });
    });

    it('never discards a local edit still waiting to be pushed', async () => {
      await applyRemoteTrackerSchemaDef(WS, def(server, 14), db);
      await markTrackerTypeDefProjected(WS, 'bug', JSON.stringify(server), db);
      const edit = model('bug', { displayName: 'Defect', fields: [{ name: 'collection' }] });
      await materializeYamlTrackerTypeDef(WS, edit, db);

      const res = await applyRemoteTrackerSchemaDef(WS, def(server, 14), db);

      expect(res).toEqual({ applied: false, reason: 'stale' });
      const all = await rows();
      expect(JSON.parse(all[0].model)).toEqual(edit);
      expect(await listUnsyncedTrackerSchemaDefs(WS, db)).toHaveLength(1);
    });

    it('still rejects a strictly older version', async () => {
      await applyRemoteTrackerSchemaDef(WS, def(server, 20), db);
      const res = await applyRemoteTrackerSchemaDef(WS, def(diverged, 14), db);
      expect(res).toEqual({ applied: false, reason: 'stale' });
      expect(JSON.parse((await rows())[0].model)).toEqual(server);
    });

    it('re-applies a retraction we somehow missed at the same version', async () => {
      await applyRemoteTrackerSchemaDef(WS, def(server, 14), db);
      await db.query(`UPDATE tracker_type_defs SET sync_id = 15 WHERE type = 'bug'`);

      const res = await applyRemoteTrackerSchemaDef(WS, def(null, 15), db);

      expect(res).toEqual({ applied: true, deleted: true });
      expect(await listMaterializedTrackerTypes(WS, db)).toHaveLength(0);
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

    it('excludes personal schemas and includes team schemas regardless of their draft default', async () => {
      await materializeTrackerTypeDef(WS, model('teamType', { sharing: 'team', draftByDefault: false }), 'cli', db);
      await materializeTrackerTypeDef(WS, model('draftType', { sharing: 'team', draftByDefault: true }), 'cli', db);
      await materializeTrackerTypeDef(WS, model('personalType', { sharing: 'personal', draftByDefault: false }), 'cli', db);

      const out = await listUnsyncedTrackerSchemaDefs(WS, db);
      expect(out.map((r) => r.type).sort()).toEqual(['draftType', 'teamType']);
    });

    it('still surfaces sync-undefined types (custom-type back-compat)', async () => {
      // model() has no sync policy; those keep syncing as before (only explicit
      // local is filtered), so this feature never silently stops an existing type.
      await materializeTrackerTypeDef(WS, model('noSync'), 'cli', db);
      const out = await listUnsyncedTrackerSchemaDefs(WS, db);
      expect(out.map((r) => r.type)).toContain('noSync');
    });

    it('excludes a pending tombstone for a personal override (nothing to retract)', async () => {
      // The model column retains the last-known JSON even when tombstoned, so the
      // personal-sharing filter applies to deletions too.
      await materializeTrackerTypeDef(WS, model('personalType', { sharing: 'personal', draftByDefault: false }), 'cli', db);
      await removeTrackerTypeDef(WS, 'personalType', db);
      const out = await listUnsyncedTrackerSchemaDefs(WS, db);
      expect(out.map((r) => r.type)).not.toContain('personalType');
    });
  });

  describe('old-client tolerance for builtin-type schema defs', () => {
    // An older peer's apply path (which predates builtin-override intent) keys
    // purely on (workspace, type) with no builtin concept. A def whose type
    // happens to be a builtin name must apply/version-gate/tombstone like any
    // other row — never crash or corrupt the mirror.
    const def = (type: string, m: TrackerDataModel | null, syncId: number) => ({
      type,
      model: m === null ? null : JSON.stringify(m),
      syncId,
    });

    it('applies a builtin-named override def without special-casing', async () => {
      const res = await applyRemoteTrackerSchemaDef(
        WS,
        def('feature', model('feature', { displayName: 'Feature', sharing: 'team', draftByDefault: false }), 1),
        db,
      );
      expect(res).toEqual({ applied: true, deleted: false });

      const all = await rows();
      expect(all).toHaveLength(1);
      expect(all[0].type).toBe('feature');
      expect(all[0].source).toBe('sync');
      expect(all[0].sync_status).toBe('synced');
    });

    it('version-gates and tombstones a builtin override without corrupting the mirror', async () => {
      await applyRemoteTrackerSchemaDef(WS, def('feature', model('feature', { displayName: 'V1' }), 2), db);
      // Stale delivery ignored.
      const stale = await applyRemoteTrackerSchemaDef(WS, def('feature', model('feature', { displayName: 'V0' }), 1), db);
      expect(stale).toEqual({ applied: false, reason: 'stale' });
      // A reset from the admin arrives as a tombstone → row soft-deleted, no crash.
      const del = await applyRemoteTrackerSchemaDef(WS, def('feature', null, 3), db);
      expect(del).toEqual({ applied: true, deleted: true });

      const active = await listMaterializedTrackerTypes(WS, db);
      expect(active).toHaveLength(0);
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

  // Ownership decides whether a difference is drift at all: for a team-owned
  // row the two writes a resync performs are no-ops, so reporting drift there
  // offered a "Resync from files" button whose work would be discarded.
  describe('team-owned rows', () => {
    const yaml = model('epic', { displayName: 'Local edit' });
    const shared = model('epic', { displayName: 'Team' });

    it('is not drift when the file has no baseline, so materialize ignores it', () => {
      const entries = classifyTrackerSchemaDrift(
        [yaml],
        [{ ...dbDef('epic', 'yaml', shared), sync_id: 7, synced_model: null }],
      );
      expect(entries).toEqual([{ type: 'epic', status: 'team-owned', source: 'yaml' }]);
      expect(hasSchemaDrift(entries)).toBe(false);
    });

    it('is not drift when the file already matches the last projected shared model', () => {
      const entries = classifyTrackerSchemaDrift(
        [shared],
        [{
          ...dbDef('epic', 'yaml', model('epic', { displayName: 'Changed elsewhere' })),
          sync_id: 7,
          synced_model: JSON.stringify(shared),
        }],
      );
      expect(entries[0].status).toBe('team-owned');
      expect(hasSchemaDrift(entries)).toBe(false);
    });

    it('is drift when the file is a real edit on top of the baseline, which a resync pushes', () => {
      const entries = classifyTrackerSchemaDrift(
        [yaml],
        [{ ...dbDef('epic', 'yaml', shared), sync_id: 7, synced_model: JSON.stringify(shared) }],
      );
      expect(entries[0].status).toBe('drifted');
      expect(hasSchemaDrift(entries)).toBe(true);
    });

    it('is not an orphan when the file is missing -- reconcile refuses to retract it', () => {
      const entries = classifyTrackerSchemaDrift(
        [],
        [{ ...dbDef('epic', 'yaml', shared), sync_id: 7, synced_model: null }],
      );
      expect(entries).toEqual([{ type: 'epic', status: 'team-owned', source: 'yaml' }]);
      expect(hasSchemaDrift(entries)).toBe(false);
    });
  });
});
