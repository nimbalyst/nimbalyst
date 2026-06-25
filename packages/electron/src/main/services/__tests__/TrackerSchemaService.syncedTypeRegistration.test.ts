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

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp'), isPackaged: false, getName: vi.fn(() => 'Nimbalyst'),
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
import { applyRemoteTrackerSchemaDef, materializeTrackerTypeDef } from '../tracker/trackerTypeDefStore';
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
