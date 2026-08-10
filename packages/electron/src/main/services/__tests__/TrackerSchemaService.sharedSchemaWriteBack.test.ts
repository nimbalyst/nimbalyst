/**
 * #1178: team schema sync is authoritative, and the workspace's YAML dir is a
 * PROJECTION of the shared definition -- not a competing source. Applying a
 * remote schema must write the shared model onto disk and record it, so a later
 * hand edit of that file is distinguishable from a leftover file and reaches
 * teammates. A retraction must retire the local file, or the member who has one
 * keeps running the deleted definition forever.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockWatch, dbRef } = vi.hoisted(() => ({
  mockWatch: vi.fn(() => ({ on() { return this; }, close: vi.fn().mockResolvedValue(undefined) })),
  dbRef: { current: null as unknown },
}));

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp'), isPackaged: false, getName: vi.fn(() => 'Nimbalyst'),
    getVersion: vi.fn(() => '0.0.0-test'), on: vi.fn(), off: vi.fn(), once: vi.fn(),
    whenReady: vi.fn(() => Promise.resolve()), isReady: vi.fn(() => true), quit: vi.fn(),
  },
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => null },
}));

vi.mock('../../utils/ipcRegistry', () => ({
  safeHandle: vi.fn(), safeOn: vi.fn(), safeOnce: vi.fn(),
}));

vi.mock('chokidar', () => ({ default: { watch: mockWatch } }));

vi.mock('../../database/initialize', () => ({ getDatabase: () => dbRef.current }));

import { SQLiteDatabase } from '../../database/sqlite/SQLiteDatabase';
import { applyRemoteWorkspaceTrackerSchemaDef } from '../TrackerSchemaService';
import {
  applyRemoteTrackerSchemaDef,
  listUnprojectedTeamOwnedTrackerTypes,
  listUnsyncedTrackerSchemaDefs,
  markTrackerTypeDefProjected,
  materializeYamlTrackerTypeDef,
} from '../tracker/trackerTypeDefStore';
import {
  parseTrackerYAML,
  diffTrackerSchema,
  decodeTrackerSchemaPayload,
  encodeTrackerSchemaPatchPayload,
  resolveTrackerSchemaPatch,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/models';

const SCHEMA_DIR = path.resolve(__dirname, '..', '..', 'database', 'sqlite', 'schemas');
const TYPE = 'bug-1178';

const sharedModel = {
  type: TYPE,
  displayName: 'Bug',
  displayNamePlural: 'Bugs',
  icon: 'bug_report',
  color: '#dc2626',
  modes: { inline: true, fullDocument: false },
  idPrefix: 'bug',
  fields: [
    { name: 'title', type: 'string' },
    { name: 'collection', type: 'relationship', relationshipTypeKey: 'in-collection' },
  ],
  roles: { title: 'title' },
};

describe('shared tracker schema write-back (#1178)', () => {
  let tmp: string;
  let ws: string;
  let db: SQLiteDatabase;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-writeback-'));
    ws = path.join(tmp, 'project');
    fs.mkdirSync(path.join(ws, '.nimbalyst', 'trackers'), { recursive: true });
    db = new SQLiteDatabase({
      dbDir: path.join(tmp, 'sqlite-db'), schemaDir: SCHEMA_DIR,
      slowQueryThresholdMs: 1000, sampleRate: 0,
    });
    await db.initialize();
    dbRef.current = db;
  });

  afterEach(async () => {
    dbRef.current = null;
    await db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const schemaFile = (): string => path.join(ws, '.nimbalyst', 'trackers', `${TYPE}.yaml`);

  it('projects the shared definition onto the workspace YAML file', async () => {
    fs.writeFileSync(
      schemaFile(),
      `type: ${TYPE}\ndisplayName: Stale\ndisplayNamePlural: Stales\nicon: bug_report\ncolor: '#dc2626'\nmodes:\n  inline: true\n  fullDocument: false\nidPrefix: bug\nfields:\n  - name: title\n    type: string\n`,
    );

    const result = await applyRemoteWorkspaceTrackerSchemaDef(ws, {
      type: TYPE, model: JSON.stringify(sharedModel), syncId: 14,
    });

    expect(result).toEqual({ applied: true, deleted: false });
    const written = parseTrackerYAML(fs.readFileSync(schemaFile(), 'utf-8'));
    expect(written.fields.map((f) => f.name)).toContain('collection');
  });

  it('leaves nothing to push after write-back (no echo back to the team)', async () => {
    await applyRemoteWorkspaceTrackerSchemaDef(ws, {
      type: TYPE, model: JSON.stringify(sharedModel), syncId: 14,
    });

    // The next workspace load re-reads the file we just wrote.
    const onDisk = parseTrackerYAML(fs.readFileSync(schemaFile(), 'utf-8'));
    await materializeYamlTrackerTypeDef(ws, onDisk, db);

    expect(await listUnsyncedTrackerSchemaDefs(ws, db)).toEqual([]);
  });

  it('queues an edit made to the projected file, so a UI/hand change reaches teammates', async () => {
    await applyRemoteWorkspaceTrackerSchemaDef(ws, {
      type: TYPE, model: JSON.stringify(sharedModel), syncId: 14,
    });

    const edited = { ...sharedModel, displayName: 'Defect' };
    await materializeYamlTrackerTypeDef(ws, edited as never, db);

    const pending = await listUnsyncedTrackerSchemaDefs(ws, db);
    expect(pending).toHaveLength(1);
    expect(JSON.parse(pending[0].model!).displayName).toBe('Defect');
  });

  it('retires the local file when the team retracts the type', async () => {
    await applyRemoteWorkspaceTrackerSchemaDef(ws, {
      type: TYPE, model: JSON.stringify(sharedModel), syncId: 14,
    });
    expect(fs.existsSync(schemaFile())).toBe(true);

    await applyRemoteWorkspaceTrackerSchemaDef(ws, { type: TYPE, model: null, syncId: 15 });

    expect(fs.existsSync(schemaFile())).toBe(false);
    const kept = fs.readdirSync(path.join(ws, '.nimbalyst', 'trackers'));
    expect(kept.some((f) => f.startsWith(`${TYPE}.yaml.`) && f.endsWith('.bak'))).toBe(true);
  });
});

/**
 * A builtin override travels as a delta, so a peer resolves it against ITS OWN
 * builtin. This is the property that stops one member's app version from
 * freezing a builtin type for the whole team.
 */
describe('builtin override travels as a delta (#1178)', () => {
  const BUILTIN = 'bug';

  it('a peer on a newer builtin keeps the newly shipped field', () => {
    // Sender's builtin, and the override they made on top of it.
    const senderSeed = {
      ...sharedModel, type: BUILTIN,
      fields: [{ name: 'title', type: 'string' }],
    } as never as import('@nimbalyst/runtime/plugins/TrackerPlugin/models').TrackerDataModel;
    const senderOverride = {
      ...senderSeed, displayName: 'Defect',
    } as never as import('@nimbalyst/runtime/plugins/TrackerPlugin/models').TrackerDataModel;

    const payload = encodeTrackerSchemaPatchPayload(diffTrackerSchema(senderSeed, senderOverride));

    // Receiver ships a builtin that gained `collection` after the sender's version.
    const receiverSeed = {
      ...senderSeed,
      fields: [
        { name: 'title', type: 'string' },
        { name: 'collection', type: 'relationship', relationshipTypeKey: 'in-collection' },
      ],
    } as never as import('@nimbalyst/runtime/plugins/TrackerPlugin/models').TrackerDataModel;

    const decoded = decodeTrackerSchemaPayload(BUILTIN, payload);
    expect(decoded?.kind).toBe('patch');
    const resolvedModel = resolveTrackerSchemaPatch(
      receiverSeed,
      (decoded as { kind: 'patch'; patch: never }).patch,
    );

    expect(resolvedModel.displayName).toBe('Defect'); // the teammate's override applied
    expect(resolvedModel.fields.map((f) => f.name)).toContain('collection'); // and the new builtin field survived
  });

  it('a pre-delta client rejects the payload instead of ingesting a broken schema', () => {
    const payload = encodeTrackerSchemaPatchPayload({ type: BUILTIN, displayName: 'Defect' });
    // Exactly what an older client validates a model on.
    const parsed = JSON.parse(payload) as { type?: string; fields?: unknown };
    expect(parsed.type === BUILTIN && Array.isArray(parsed.fields)).toBe(false);
  });
});

/**
 * Without a projection there is no baseline, so an edit to a shared type's file
 * is indistinguishable from a leftover and gets ignored. Projecting on load is
 * what makes a team-shared type locally editable at all.
 */
describe('unprojected shared schemas are written to disk on load (#1178)', () => {
  let tmp: string;
  let ws: string;
  let db: SQLiteDatabase;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-project-'));
    ws = path.join(tmp, 'project');
    fs.mkdirSync(path.join(ws, '.nimbalyst', 'trackers'), { recursive: true });
    db = new SQLiteDatabase({
      dbDir: path.join(tmp, 'sqlite-db'), schemaDir: SCHEMA_DIR,
      slowQueryThresholdMs: 1000, sampleRate: 0,
    });
    await db.initialize();
    dbRef.current = db;
  });

  afterEach(async () => {
    dbRef.current = null;
    await db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('reports a team-owned row with no projection, and stops once projected', async () => {
    await applyRemoteTrackerSchemaDef(
      ws, { type: TYPE, model: JSON.stringify(sharedModel), syncId: 14 }, db,
    );

    expect((await listUnprojectedTeamOwnedTrackerTypes(ws, db)).map((r) => r.type)).toEqual([TYPE]);

    await markTrackerTypeDefProjected(ws, TYPE, JSON.stringify(sharedModel), db);

    expect(await listUnprojectedTeamOwnedTrackerTypes(ws, db)).toEqual([]);
  });

  it('leaves a purely local type alone (nothing shared to project)', async () => {
    await materializeYamlTrackerTypeDef(ws, sharedModel as never, db);

    expect(await listUnprojectedTeamOwnedTrackerTypes(ws, db)).toEqual([]);
  });
});
