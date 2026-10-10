/**
 * NIM-865: a tracker type shared via schema sync (source='sync', no workspace
 * YAML) must be registered into the runtime registry on load, or it vanishes
 * from the type list after restart (loadWorkspaceSchemas only reads YAML, and
 * the incremental schema delta never re-arrives). Verified against a real
 * SQLiteDatabase + the materialization store.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockWatch, mockWindowSend } = vi.hoisted(() => ({
  mockWatch: vi.fn(() => ({ on() { return this; }, close: vi.fn().mockResolvedValue(undefined) })),
  mockWindowSend: vi.fn(),
}));

vi.mock('electron', async () => ({
  app: {
    getPath: (await import('../../../../test-stubs/privateUserData')).testApp.getPath, isPackaged: false, getName: vi.fn(() => 'Nimbalyst'),
    getVersion: vi.fn(() => '0.0.0-test'), on: vi.fn(), off: vi.fn(), once: vi.fn(),
    whenReady: vi.fn(() => Promise.resolve()), isReady: vi.fn(() => true), quit: vi.fn(),
  },
  BrowserWindow: { getAllWindows: () => [{ webContents: { send: mockWindowSend } }] },
}));

vi.mock('../../utils/ipcRegistry', () => ({
  safeHandle: vi.fn(), safeOn: vi.fn(), safeOnce: vi.fn(),
}));

vi.mock('chokidar', () => ({ default: { watch: mockWatch } }));

import { SQLiteDatabase } from '../../database/sqlite/SQLiteDatabase';
import { applyRemoteTrackerSchemaDef, listMaterializedTrackerTypeDefs, materializeTrackerTypeDef } from '../tracker/trackerTypeDefStore';
import { registerMaterializedSyncedTypes } from '../TrackerSchemaService';
import { globalRegistry } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';

const SCHEMA_DIR = path.resolve(__dirname, '..', '..', 'database', 'sqlite', 'schemas');
const WS = '/ws/synced';
const TYPE = 'github-pr-test-nim865';

describe('registerMaterializedSyncedTypes (NIM-865)', () => {
  let tmp: string;
  let db: SQLiteDatabase;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-synced-'));
    db = new SQLiteDatabase({
      dbDir: path.join(tmp, 'sqlite-db'), schemaDir: SCHEMA_DIR,
      slowQueryThresholdMs: 1000, sampleRate: 0,
    });
    await db.initialize();
    globalRegistry.clearWorkspaceSchema(TYPE);
  });

  afterEach(async () => {
    globalRegistry.clearWorkspaceSchema(TYPE);
    await db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('registers a DB-materialized synced type that has no workspace YAML', async () => {
    const model = JSON.stringify({
      type: TYPE, displayName: 'GitHub PR Test',
      fields: [{ name: 'title', type: 'string' }], roles: { title: 'title' },
    });
    const applied = await applyRemoteTrackerSchemaDef(WS, { type: TYPE, model, syncId: 7 }, db);
    expect(applied.applied).toBe(true);

    // Mirrors a fresh restart: the type is materialized in the DB but not yet
    // in the registry (loadWorkspaceSchemas only registered YAML).
    expect(globalRegistry.has(TYPE)).toBe(false);

    const count = await registerMaterializedSyncedTypes(WS, db);
    expect(count).toBeGreaterThanOrEqual(1);
    expect(globalRegistry.has(TYPE)).toBe(true);
  });

  it('overrides an already-registered (stale) definition with the synced one', async () => {
    // A built-in/stale model occupies the slot (mirrors built-ins always being in
    // the registry). The synced definition must win to match the live sync path.
    globalRegistry.register({ type: TYPE, displayName: 'OLD', fields: [], roles: {} } as never);
    const model = JSON.stringify({
      type: TYPE, displayName: 'NEW',
      fields: [{ name: 'title', type: 'string' }], roles: { title: 'title' },
    });
    await applyRemoteTrackerSchemaDef(WS, { type: TYPE, model, syncId: 7 }, db);

    const count = await registerMaterializedSyncedTypes(WS, db);
    expect(count).toBeGreaterThanOrEqual(1);
    expect(globalRegistry.get(TYPE)?.displayName).toBe('NEW');
  });

  it('does not register a yaml-sourced materialized type (YAML load owns those)', async () => {
    // yaml-sourced rows are the DB mirror of an on-disk file that
    // loadWorkspaceSchemas already registered from source; this path must skip
    // them so it never clobbers the authoritative on-disk copy with a stale mirror.
    await materializeTrackerTypeDef(
      WS,
      { type: TYPE, displayName: 'FromYaml', fields: [], roles: {} } as never,
      'yaml',
      db,
    );
    expect(globalRegistry.has(TYPE)).toBe(false);

    const count = await registerMaterializedSyncedTypes(WS, db);
    expect(count).toBe(0);
    expect(globalRegistry.has(TYPE)).toBe(false);
  });

  it('registers a yaml-sourced row the TEAM owns (shared definition wins) (#1178)', async () => {
    // The state every team member ends up in: a local YAML file for a type the
    // team also shares. Skipping on source='yaml' alone left the stale local
    // definition registered and froze the type for that member.
    await materializeTrackerTypeDef(
      WS,
      { type: TYPE, displayName: 'StaleLocal', fields: [], roles: {} } as never,
      'yaml',
      db,
    );
    await db.query(`UPDATE tracker_type_defs SET sync_id = 14 WHERE type = '${TYPE}'`);

    const count = await registerMaterializedSyncedTypes(WS, db);
    expect(count).toBe(1);
    expect(globalRegistry.get(TYPE)?.displayName).toBe('StaleLocal');
  });

  it('does not let an obsolete team-owned row replace a migrated personal schema', async () => {
    globalRegistry.register({
      type: TYPE,
      displayName: 'Personal',
      sharing: 'personal',
      draftByDefault: false,
      fields: [],
      roles: {},
    } as never);
    await materializeTrackerTypeDef(
      WS,
      { type: TYPE, displayName: 'Old team copy', fields: [], roles: {} } as never,
      'yaml',
      db,
    );
    await db.query(`UPDATE tracker_type_defs SET sync_id = 14 WHERE type = '${TYPE}'`);

    const count = await registerMaterializedSyncedTypes(WS, db);

    expect(count).toBe(0);
    expect(globalRegistry.get(TYPE)?.displayName).toBe('Personal');
  });

  it('registers a mirrored subtype as its declaration and persists that declaration', async () => {
    const base = {
      type: 'tech-r1', displayName: 'Tech', displayNamePlural: 'Techs', icon: 'memory', color: '#000',
      modes: { inline: true, fullDocument: false }, idPrefix: 'tec', idFormat: 'ulid' as const,
      fields: [
        { name: 'title', type: 'string' as const, required: true },
        { name: 'status', type: 'select' as const, options: ['a', 'b', 'c'].map((value) => ({ value, label: value })) },
      ],
    };
    globalRegistry.register(base);
    const resolved = { ...globalRegistry.get('tech-r1')!, type: 'lib-r1', extends: 'tech-r1', sharing: 'team' as const,
      fields: [...globalRegistry.get('tech-r1')!.fields, { name: 'npmPackage', type: 'string' as const }] };
    // The live mirror's shape: a resolved copy with no declaration beside it.
    await applyRemoteTrackerSchemaDef(WS, { type: 'lib-r1', model: JSON.stringify(resolved), syncId: 3 }, db);

    await registerMaterializedSyncedTypes(WS, db);

    expect(globalRegistry.getDeclaredModel('lib-r1')?.fields?.map((f) => f.name)).toEqual(['npmPackage']);
    globalRegistry.register({ ...base, fields: [base.fields[0], { ...base.fields[1], options: base.fields[1].options!.slice(0, 2) }] });
    expect(globalRegistry.get('lib-r1')).toBeDefined();

    await materializeTrackerTypeDef(WS, globalRegistry.get('lib-r1')!, 'yaml', db);
    const row = (await listMaterializedTrackerTypeDefs(WS, db)).find((def) => def.type === 'lib-r1');
    const stored = typeof row!.model === 'string' ? JSON.parse(row!.model) : row!.model;
    expect(stored.declaredForm.fields.map((f: any) => f.name)).toEqual(['npmPackage']);
    globalRegistry.clearWorkspaceSchema('lib-r1');
    globalRegistry.clearWorkspaceSchema('tech-r1');
  });

  it('does not mutate the registry when the workspace is no longer active', async () => {
    const model = JSON.stringify({
      type: TYPE, displayName: 'GitHub PR Test',
      fields: [{ name: 'title', type: 'string' }], roles: { title: 'title' },
    });
    await applyRemoteTrackerSchemaDef(WS, { type: TYPE, model, syncId: 7 }, db);

    // Simulate a workspace switch landing while the DB read was in flight.
    const count = await registerMaterializedSyncedTypes(WS, db, () => false);
    expect(count).toBe(0);
    expect(globalRegistry.has(TYPE)).toBe(false);
  });
});
