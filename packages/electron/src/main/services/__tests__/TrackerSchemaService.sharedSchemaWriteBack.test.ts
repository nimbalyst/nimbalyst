// @vitest-environment node

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

vi.mock('electron', async () => ({
  app: {
    getPath: (await import('../../../../test-stubs/privateUserData')).testApp.getPath, isPackaged: false, getName: vi.fn(() => 'Nimbalyst'),
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

vi.mock('../TeamService', () => ({
  findTeamForWorkspace: vi.fn(async () => ({ name: 'Acme' })),
}));

vi.mock('../TrackerIdentityService', () => ({
  getCurrentIdentity: vi.fn(() => ({ displayName: 'Test User', email: 'test@example.com' })),
}));

import { SQLiteDatabase } from '../../database/sqlite/SQLiteDatabase';
import { createScratchRepo } from '../testSupport/gitTestSandbox';
import {
  applyRemoteWorkspaceTrackerSchemaDef,
  handleSchemaFileDeleted,
  reloadWorkspaceSchema,
  reloadWorkspacePredicateRegistry,
  encodeTrackerSchemaDefForPush,
} from '../TrackerSchemaService';
import {
  applyRemoteTrackerSchemaDef,
  listUnprojectedTeamOwnedTrackerTypes,
  listUnsyncedTrackerSchemaDefs,
  markTrackerTypeDefProjected,
  materializeYamlTrackerTypeDef,
} from '../tracker/trackerTypeDefStore';
import {
  globalRegistry,
  parseTrackerYAML,
  serializeTrackerYAML,
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
  sharing: 'team' as const,
  draftByDefault: false,
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
    // The registry is module state shared by every test here. Leaving a model
    // registered makes the NEXT test's file edit diff against it, which is how
    // one test's schema silently becomes another's baseline.
    globalRegistry.clearWorkspaceSchemas();
    dbRef.current = null;
    await db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const schemaFile = (): string => path.join(ws, '.nimbalyst', 'trackers', `${TYPE}.yaml`);

  it('keeps the last valid predicate registry while a hand edit is malformed', async () => {
    const predicateFile = path.join(ws, '.nimbalyst', 'predicates.yaml');
    fs.writeFileSync(predicateFile, [
      'predicates:',
      '  - id: depends-on',
      '    label: depends on',
      '    subjectKinds: ["*"]',
      '    valueShape: entity',
      '    direction: directed',
      '',
    ].join('\n'));
    await reloadWorkspacePredicateRegistry(ws);
    expect(globalRegistry.getPredicate('depends-on')?.label).toBe('depends on');

    fs.writeFileSync(predicateFile, 'predicates:\n  - id: [broken');
    await reloadWorkspacePredicateRegistry(ws);

    expect(globalRegistry.getPredicate('depends-on')?.label).toBe('depends on');
  });

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
    const modelWithActivity = {
      ...sharedModel,
      activity: [{
        id: 'activity_1',
        authorIdentity: { displayName: 'Alice' },
        action: 'schema_updated',
        field: 'schema',
        timestamp: 1,
      }],
    };
    await applyRemoteWorkspaceTrackerSchemaDef(ws, {
      type: TYPE, model: JSON.stringify(modelWithActivity), syncId: 14,
    });

    const content = fs.readFileSync(schemaFile(), 'utf-8');
    expect(content.split('\n')[0]).toBe(
      '# Shared with Acme. Saving this file updates it for everyone. Last changed by Alice.',
    );
    // The next workspace load re-reads the file we just wrote.
    const onDisk = parseTrackerYAML(content);
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

  it('queues the first hand edit after an unprojected shared row lands without a restart', async () => {
    await applyRemoteTrackerSchemaDef(
      ws, { type: TYPE, model: JSON.stringify(sharedModel), syncId: 14 }, db,
    );
    const edited = { ...sharedModel, displayName: 'Defect' };
    fs.writeFileSync(schemaFile(), serializeTrackerYAML(edited as never));

    await reloadWorkspaceSchema(ws, schemaFile());

    await vi.waitFor(async () => {
      const pending = await listUnsyncedTrackerSchemaDefs(ws, db);
      expect(pending).toHaveLength(1);
      expect(JSON.parse(pending[0].model!).displayName).toBe('Defect');
      expect(parseTrackerYAML(fs.readFileSync(schemaFile(), 'utf-8')).displayName).toBe('Defect');
    });
  });

  it('queues the first hand edit after restart loaded a stale file before projection', async () => {
    await applyRemoteTrackerSchemaDef(
      ws, { type: TYPE, model: JSON.stringify(sharedModel), syncId: 14 }, db,
    );
    const stale = { ...sharedModel, displayName: 'Stale checkout' };
    await materializeYamlTrackerTypeDef(ws, stale as never, db);
    expect(await listUnsyncedTrackerSchemaDefs(ws, db)).toEqual([]);

    const edited = { ...sharedModel, displayName: 'Defect after restart' };
    fs.writeFileSync(schemaFile(), serializeTrackerYAML(edited as never));
    await reloadWorkspaceSchema(ws, schemaFile());

    await vi.waitFor(async () => {
      const pending = await listUnsyncedTrackerSchemaDefs(ws, db);
      expect(pending).toHaveLength(1);
      expect(JSON.parse(pending[0].model!).displayName).toBe('Defect after restart');
      expect(parseTrackerYAML(fs.readFileSync(schemaFile(), 'utf-8')).displayName).toBe('Defect after restart');
    });
  });

  it('keeps the full schema activity trail when a person edits the projected YAML', async () => {
    vi.useFakeTimers();
    const sharedWithHistory = {
      ...sharedModel,
      activity: [{
        id: 'activity_1',
        authorIdentity: { displayName: 'Alice' },
        action: 'schema_updated',
        field: 'schema',
        timestamp: 1,
      }],
    };
    await applyRemoteWorkspaceTrackerSchemaDef(ws, {
      type: TYPE, model: JSON.stringify(sharedWithHistory), syncId: 14,
    });
    vi.advanceTimersByTime(2_001);
    vi.useRealTimers();

    // The write-back just projected a model that CARRIES a trail. The trail is
    // provenance held beside the schema (DB row + sync payload), never part of
    // the schema document -- a user opening this file must see config, not a
    // history log. Any new YAML write path has to keep stripping it.
    expect(fs.readFileSync(schemaFile(), 'utf-8')).not.toContain('activity:');

    fs.writeFileSync(schemaFile(), serializeTrackerYAML({ ...sharedModel, displayName: 'Defect' } as never));

    await reloadWorkspaceSchema(ws, schemaFile());

    const pending = await listUnsyncedTrackerSchemaDefs(ws, db);
    const stored = JSON.parse(pending[0].model!);
    expect(stored.activity).toHaveLength(2);
    expect(stored.activity).toEqual([
      expect.objectContaining({ action: 'schema_updated', authorIdentity: { displayName: 'Alice' } }),
      expect.objectContaining({ action: 'schema_updated', authorIdentity: expect.objectContaining({ displayName: 'Test User' }) }),
    ]);
    expect(fs.readFileSync(schemaFile(), 'utf-8').split('\n')[0]).toBe(
      '# Shared with Acme. Saving this file updates it for everyone. Last changed by Test User.',
    );
  });

  /**
   * D3, on the one path that cannot show a confirm: the file is already saved by
   * the time the watcher fires, so the half a dialog could never have supplied --
   * "only an admin may remove part of a team's schema" -- is enforced here
   * instead. The mocked team lookup returns no role, so the actor is a member.
   */
  it("refuses a member's destructive hand edit to a team schema and restores the team's copy", async () => {
    vi.useFakeTimers();
    await applyRemoteWorkspaceTrackerSchemaDef(ws, {
      type: TYPE, model: JSON.stringify(sharedModel), syncId: 14,
    });
    vi.advanceTimersByTime(2_001);
    vi.useRealTimers();
    // What the service does once the projected definition is in force. Cleared
    // first: this file's tests share one registry.
    globalRegistry.clearWorkspaceSchema(TYPE);
    globalRegistry.register(sharedModel as never);

    const stripped = { ...sharedModel, fields: [sharedModel.fields[0]] };
    fs.writeFileSync(schemaFile(), serializeTrackerYAML(stripped as never));
    await reloadWorkspaceSchema(ws, schemaFile());

    // Not loaded: running a schema nobody else has is the divergence the sharing
    // model exists to prevent.
    // `tags` is injected by the registry, so compare the declared fields only.
    expect(globalRegistry.get(TYPE)?.fields.map((f) => f.name)).toContain('collection');
    // Not queued: the removal never reaches the team.
    expect(await listUnsyncedTrackerSchemaDefs(ws, db)).toEqual([]);
    // The team's copy is back on disk...
    expect(parseTrackerYAML(fs.readFileSync(schemaFile(), 'utf-8')).fields.map((f) => f.name))
      .toContain('collection');
    // ...and the member's version survives beside it rather than being discarded.
    const trackersDir = path.join(ws, '.nimbalyst', 'trackers');
    const backups = fs.readdirSync(trackersDir).filter((name) => name.endsWith('.bak'));
    expect(backups).toHaveLength(1);
    expect(
      parseTrackerYAML(fs.readFileSync(path.join(trackersDir, backups[0]), 'utf-8')).fields
        .map((f) => f.name),
    ).not.toContain('collection');
  });

  /**
   * The guard used to answer `null` when it could not run at all -- and `null`
   * fell through to "register the model", so any error pricing the change turned
   * a member's removal into an allow. The realistic trigger is the blast-radius
   * query: it reads the item table, and a database that is down throws straight
   * out of the guard. An unclassifiable change to a TEAM schema is the strongest
   * form of "unknown", which the classifier's own rule calls destructive.
   */
  it("refuses a member's hand edit when the change cannot be classified at all", async () => {
    vi.useFakeTimers();
    await applyRemoteWorkspaceTrackerSchemaDef(ws, {
      type: TYPE, model: JSON.stringify(sharedModel), syncId: 14,
    });
    vi.advanceTimersByTime(2_001);
    vi.useRealTimers();
    globalRegistry.clearWorkspaceSchema(TYPE);
    globalRegistry.register(sharedModel as never);

    // Fail only the guard's own read. Everything else still needs a live db, and
    // a blanket failure would prove nothing about which check did the refusing.
    dbRef.current = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== 'query') return Reflect.get(target, prop, receiver);
        return (sql: string, params?: unknown[]) =>
          sql.includes('FROM tracker_items')
            ? Promise.reject(new Error('database unavailable'))
            : (target as unknown as { query: (s: string, p?: unknown[]) => Promise<unknown> })
                .query(sql, params);
      },
    });

    const stripped = { ...sharedModel, fields: [sharedModel.fields[0]] };
    fs.writeFileSync(schemaFile(), serializeTrackerYAML(stripped as never));
    await reloadWorkspaceSchema(ws, schemaFile());

    dbRef.current = db;

    expect(globalRegistry.get(TYPE)?.fields.map((f) => f.name)).toContain('collection');
    expect(await listUnsyncedTrackerSchemaDefs(ws, db)).toEqual([]);
    expect(parseTrackerYAML(fs.readFileSync(schemaFile(), 'utf-8')).fields.map((f) => f.name))
      .toContain('collection');
  });

  /** The additive half of the same rule: no role check, no ceremony, applies. */
  it("applies a member's additive hand edit to a team schema and queues it", async () => {
    vi.useFakeTimers();
    await applyRemoteWorkspaceTrackerSchemaDef(ws, {
      type: TYPE, model: JSON.stringify(sharedModel), syncId: 14,
    });
    vi.advanceTimersByTime(2_001);
    vi.useRealTimers();
    globalRegistry.clearWorkspaceSchema(TYPE);
    globalRegistry.register(sharedModel as never);

    const widened = {
      ...sharedModel,
      fields: [...sharedModel.fields, { name: 'severity', type: 'number' }],
    };
    fs.writeFileSync(schemaFile(), serializeTrackerYAML(widened as never));
    await reloadWorkspaceSchema(ws, schemaFile());

    expect(globalRegistry.get(TYPE)?.fields.map((f) => f.name)).toEqual(
      expect.arrayContaining(['title', 'collection', 'severity']),
    );
    const pending = await listUnsyncedTrackerSchemaDefs(ws, db);
    expect(pending).toHaveLength(1);
    expect(JSON.parse(pending[0].model!).fields.map((f: { name: string }) => f.name)).toContain('severity');
  });

  it('does not echo a watcher event on a file that already holds the shared definition', async () => {
    // The baseline the watcher establishes must be what a RE-READ of the file
    // yields, not the raw shared model: a serialize->parse round trip normalizes
    // defaults and key order, so a raw baseline would read this as an edit and
    // every peer would push back what it just received.
    await applyRemoteTrackerSchemaDef(
      ws, { type: TYPE, model: JSON.stringify(sharedModel), syncId: 14 }, db,
    );
    fs.writeFileSync(schemaFile(), serializeTrackerYAML(sharedModel as never));

    await reloadWorkspaceSchema(ws, schemaFile());

    expect(await listUnsyncedTrackerSchemaDefs(ws, db)).toEqual([]);
  });

  it('keeps the trail out of a projected .patch.yaml too', async () => {
    // A builtin override projects as a DELTA, and diffTrackerSchema deliberately
    // carries `activity` into the patch so the trail reaches teammates over sync.
    // That makes the patch file the easiest place for the trail to leak onto
    // disk: the only thing stopping it is serializeSchemaForFile stripping
    // activity BEFORE it diffs. Assert on the file, not on that ordering.
    const BUILTIN = 'builtin-activity-1178';
    const seed = { ...sharedModel, type: BUILTIN, fields: [{ name: 'title', type: 'string' }] };
    globalRegistry.register(seed as never, true);
    const sharedWithHistory = {
      ...seed,
      displayName: 'Bug (team)',
      activity: [{
        id: 'activity_1',
        authorIdentity: { displayName: 'Alice' },
        action: 'schema_updated',
        field: 'schema',
        timestamp: 1,
      }],
    };

    // Arrives the way a teammate's builtin override really does: as a delta,
    // which is what makes the projection target the patch file.
    const payload = encodeTrackerSchemaPatchPayload(
      diffTrackerSchema(seed as never, sharedWithHistory as never),
    );
    expect(payload).toContain('activity'); // the trail really is on the wire
    await applyRemoteWorkspaceTrackerSchemaDef(ws, {
      type: BUILTIN, model: payload, syncId: 14,
    });

    const patchFile = path.join(ws, '.nimbalyst', 'trackers', `${BUILTIN}.patch.yaml`);
    await vi.waitFor(() => expect(fs.existsSync(patchFile)).toBe(true));
    const written = fs.readFileSync(patchFile, 'utf-8');
    // The one-line header names the last editor -- that is the point of it. What
    // must not land on disk is the trail itself.
    expect(written).toContain('Last changed by Alice.');
    expect(written).not.toContain('activity:');
    expect(written).not.toContain('schema_updated');
  });

  it('leaves a builtin override in the file the user edited, with no patch-file detour', async () => {
    // The projection target for a builtin override is `<type>.patch.yaml`, but a
    // hand edit lands in whatever file the user actually has. Routing the edit
    // through a projection would rewrite it into the patch file and retire the
    // one they were looking at.
    const BUILTIN = 'builtin-1178';
    const seed = { ...sharedModel, type: BUILTIN, fields: [{ name: 'title', type: 'string' }] };
    globalRegistry.register(seed as never, true);
    const shared = { ...seed, displayName: 'Bug (team)' };
    await applyRemoteTrackerSchemaDef(
      ws, { type: BUILTIN, model: JSON.stringify(shared), syncId: 14 }, db,
    );

    const file = path.join(ws, '.nimbalyst', 'trackers', `${BUILTIN}.yaml`);
    fs.writeFileSync(file, serializeTrackerYAML({ ...shared, displayName: 'Defect' } as never));
    await reloadWorkspaceSchema(ws, file);

    const pending = await listUnsyncedTrackerSchemaDefs(ws, db);
    expect(pending).toHaveLength(1);
    expect(JSON.parse(pending[0].model!).displayName).toBe('Defect');
    expect(fs.readdirSync(path.join(ws, '.nimbalyst', 'trackers'))).toEqual([`${BUILTIN}.yaml`]);
    expect(parseTrackerYAML(fs.readFileSync(file, 'utf-8')).displayName).toBe('Defect');
  });

  it('projects a stale checked-in file without queueing it as an edit (#1178)', async () => {
    const stale = { ...sharedModel, displayName: 'Stale checkout' };
    fs.writeFileSync(schemaFile(), serializeTrackerYAML(stale as never));

    await applyRemoteWorkspaceTrackerSchemaDef(ws, {
      type: TYPE, model: JSON.stringify(sharedModel), syncId: 14,
    });

    expect(parseTrackerYAML(fs.readFileSync(schemaFile(), 'utf-8')).displayName).toBe('Bug');
    expect(await listUnsyncedTrackerSchemaDefs(ws, db)).toEqual([]);
  });

  it('warns for a git-tracked team YAML and stays silent for an untracked one', async () => {
    // The folder belongs to the test's own setup, so the fixture uses it in place.
    const repo = createScratchRepo({ at: ws });

    fs.writeFileSync(schemaFile(), serializeTrackerYAML(sharedModel as never));
    repo.git('add', '-f', path.relative(ws, schemaFile()));
    await applyRemoteWorkspaceTrackerSchemaDef(ws, {
      type: TYPE, model: JSON.stringify(sharedModel), syncId: 14,
    });
    expect(fs.readFileSync(schemaFile(), 'utf-8')).toContain(
      "# Warning: This file is tracked by git. The team's copy will overwrite it.",
    );

    const untracked = { ...sharedModel, type: 'untracked-team-schema' };
    const untrackedFile = path.join(ws, '.nimbalyst', 'trackers', 'untracked-team-schema.yaml');
    await applyRemoteWorkspaceTrackerSchemaDef(ws, {
      type: untracked.type, model: JSON.stringify(untracked), syncId: 15,
    });
    expect(fs.readFileSync(untrackedFile, 'utf-8')).not.toContain('# Warning:');
  });

  it('restores a team-owned YAML file when its local copy is deleted', async () => {
    await applyRemoteWorkspaceTrackerSchemaDef(ws, {
      type: TYPE, model: JSON.stringify(sharedModel), syncId: 14,
    });
    fs.unlinkSync(schemaFile());

    await handleSchemaFileDeleted(ws, schemaFile());

    await vi.waitFor(() => expect(fs.existsSync(schemaFile())).toBe(true));
    expect(parseTrackerYAML(fs.readFileSync(schemaFile(), 'utf-8'))).toMatchObject(sharedModel);
    expect(await listUnsyncedTrackerSchemaDefs(ws, db)).toEqual([]);
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
    // Attribution rides alongside the model, never as a TrackerDataModel field.
    const senderOverride = {
      ...senderSeed,
      displayName: 'Defect',
      activity: [{ action: 'schema_updated', authorIdentity: { displayName: 'Alice' }, timestamp: 1 }],
    } as never as import('../tracker/trackerTypeDefStore').TrackerSchemaWithActivity;

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
    expect((resolvedModel as typeof resolvedModel & { activity?: unknown[] }).activity).toEqual(senderOverride.activity);
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
    // The registry is module state shared by every test here. Leaving a model
    // registered makes the NEXT test's file edit diff against it, which is how
    // one test's schema silently becomes another's baseline.
    globalRegistry.clearWorkspaceSchemas();
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

/**
 * The derived-type counterpart of the delta above: a type declaring `extends`
 * pushes its resolved model AND its declaration, so a peer resolves against its
 * own base instead of inheriting the sender's frozen copy.
 */
describe('derived types push both forms', () => {
  const BASE = 'entity-ext';
  const DERIVED = 'product-ext';

  afterEach(() => {
    globalRegistry.clearWorkspaceSchema(DERIVED);
    globalRegistry.clearWorkspaceSchema(BASE);
  });

  it('carries the declaration alongside the resolved model', () => {
    globalRegistry.register({ ...sharedModel, type: BASE } as never);
    globalRegistry.register({
      type: DERIVED,
      extends: BASE,
      fields: [{ name: 'license', type: 'string' }],
    } as never);

    const resolved = globalRegistry.get(DERIVED)!;
    const pushed = encodeTrackerSchemaDefForPush({
      type: DERIVED,
      model: JSON.stringify(resolved),
    });

    const decoded = decodeTrackerSchemaPayload(DERIVED, pushed.model!);
    expect(decoded?.kind).toBe('model');
    // Resolved form for any client, declaration for one that can use it.
    expect((decoded as { model: { fields: Array<{ name: string }> } }).model.fields.map(f => f.name))
      .toEqual(expect.arrayContaining(['title', 'collection', 'license']));
    expect((decoded as { declared?: { fields?: Array<{ name: string }> } }).declared?.fields?.map(f => f.name))
      .toEqual(['license']);
  });

  it('leaves the payload of a plain type untouched', () => {
    globalRegistry.register({ ...sharedModel, type: BASE } as never);
    const model = JSON.stringify(globalRegistry.get(BASE));
    expect(encodeTrackerSchemaDefForPush({ type: BASE, model }).model).toBe(model);
  });
});
