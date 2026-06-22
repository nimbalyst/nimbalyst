import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Reuse the same electron / ipc / chokidar mocks as the watcher test so the
// real TrackerSchemaService can run headless against a temp workspace dir.
const { mockSafeHandle, mockWatch, mockWindowSend } = vi.hoisted(() => ({
  mockSafeHandle: vi.fn(),
  mockWatch: vi.fn(() => ({
    on() {
      return this;
    },
    close: vi.fn().mockResolvedValue(undefined),
  })),
  mockWindowSend: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp'),
    isPackaged: false,
    getName: vi.fn(() => 'Nimbalyst'),
    getVersion: vi.fn(() => '0.0.0-test'),
    on: vi.fn(),
    off: vi.fn(),
    once: vi.fn(),
    whenReady: vi.fn(() => Promise.resolve()),
    isReady: vi.fn(() => true),
    quit: vi.fn(),
  },
  BrowserWindow: {
    getAllWindows: () => [{ webContents: { send: mockWindowSend } }],
  },
}));

vi.mock('../../utils/ipcRegistry', () => ({
  safeHandle: mockSafeHandle,
  safeOn: vi.fn(),
  safeOnce: vi.fn(),
}));

vi.mock('chokidar', () => ({
  default: { watch: mockWatch },
}));

// TrackerSchemaService transitively imports ../../database/initialize (via
// trackerTypeDefStore -> getDatabase). That module pulls in RepositoryManager
// and the sync/auth graph, which a neighbor test's leaked mock can deadlock
// under vitest 4's shared worker module registry -- the dynamic
// `await import('../TrackerSchemaService')` below would then never resolve and
// the beforeEach hook times out. Stub getDatabase here so this file owns the
// state and never depends on that fragile graph. DB writes are best-effort and
// tolerate a null database, so returning null preserves test intent.
vi.mock('../../database/initialize', () => ({
  getDatabase: () => null,
}));

interface TrackerSchemaServiceModule {
  initTrackerSchemaService: (workspacePath?: string | null) => void;
  updateTrackerSchemaWorkspace: (workspacePath: string | null) => void;
  ensureWorkspaceTrackerSchemasLoaded: (workspacePath: string | null | undefined) => void;
  getTrackerSchema: (type: string) => { type: string } | undefined;
  getAllTrackerSchemas: () => Array<{ type: string }>;
  isBuiltinTrackerSchema: (type: string) => boolean;
  upsertWorkspaceTrackerSchema: (
    workspacePath: string,
    schema: string,
    options?: { fileName?: string; overwrite?: boolean; allowBuiltinOverride?: boolean },
  ) => Promise<{ model: { type: string }; filePath: string; backupPath?: string }>;
  customizeWorkspaceTrackerSchema: (
    workspacePath: string,
    type: string,
  ) => Promise<{ model: { type: string; displayName?: string }; filePath: string; created: boolean }>;
  resetWorkspaceTrackerSchemaOverride: (
    workspacePath: string,
    type: string,
  ) => Promise<{ reset: boolean; filePath?: string }>;
  getWorkspaceTrackerSchemaOverride: (
    workspacePath: string,
    type: string,
  ) => Promise<{ overridden: boolean; filePath?: string }>;
  applyRemoteWorkspaceTrackerSchemaDef: (
    workspacePath: string,
    def: { type: string; model: string | null; syncId: number },
  ) => Promise<{ applied: boolean; deleted?: boolean; reason?: string }>;
  TrackerTypeExistsError: new (...args: any[]) => Error;
}

function buildCustomYaml(type: string, displayName: string): string {
  return `packageVersion: 1.0.0
packageId: developer

type: ${type}
displayName: ${displayName}
displayNamePlural: ${displayName}s
icon: campaign
color: "#0f766e"

modes:
  inline: true
  fullDocument: false

sync:
  mode: local
  scope: project

idPrefix: ${type.slice(0, 3)}
idFormat: ulid

fields:
  - name: title
    type: string
    required: true
    displayInline: true

roles:
  title: title
`;
}

function buildSyncedModel(type: string, displayName: string): string {
  return JSON.stringify({
    type,
    displayName,
    fields: [
      { name: 'title', type: 'string', required: true },
    ],
    roles: { title: 'title' },
  });
}

describe('TrackerSchemaService custom-type visibility (NIM-760)', () => {
  let workspacePath: string;
  let trackersDir: string;
  let service: TrackerSchemaServiceModule;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'tracker-schema-custom-'));
    trackersDir = path.join(workspacePath, '.nimbalyst', 'trackers');
    await fs.mkdir(trackersDir, { recursive: true });
    await fs.writeFile(
      path.join(trackersDir, 'marketing.yaml'),
      buildCustomYaml('marketing', 'Marketing'),
      'utf-8',
    );

    service = (await import('../TrackerSchemaService')) as unknown as TrackerSchemaServiceModule;
    // Initialize with NO workspace: builtins load, IPC registers, but the
    // workspace's custom schemas are never loaded -- this is the registry state
    // the in-process MCP server sees when window/session events have not loaded
    // (or have cleared) the active workspace's schemas. Custom types are invisible.
    service.initTrackerSchemaService();
  });

  afterEach(async () => {
    service.updateTrackerSchemaWorkspace(null);
    await fs.rm(workspacePath, { recursive: true, force: true });
  });

  it('registers workspace YAML types into the registry the MCP handlers read', () => {
    // Bug state: the registry the MCP path reads only has builtins.
    expect(service.getTrackerSchema('marketing')).toBeUndefined();
    expect(service.getAllTrackerSchemas().some((m) => m.type === 'marketing')).toBe(false);

    service.ensureWorkspaceTrackerSchemasLoaded(workspacePath);

    // Fixed: the custom type is now visible to list_types and assignable by
    // create/update validation (which read the same globalRegistry).
    const model = service.getTrackerSchema('marketing');
    expect(model).toBeDefined();
    expect(model?.type).toBe('marketing');
    expect(service.getAllTrackerSchemas().some((m) => m.type === 'marketing')).toBe(true);
    expect(service.isBuiltinTrackerSchema('marketing')).toBe(false);
  });
});

describe('tracker_define_type clobber guard (NIM-760)', () => {
  let workspacePath: string;
  let trackersDir: string;
  let marketingFile: string;
  let service: TrackerSchemaServiceModule;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'tracker-schema-clobber-'));
    trackersDir = path.join(workspacePath, '.nimbalyst', 'trackers');
    await fs.mkdir(trackersDir, { recursive: true });
    marketingFile = path.join(trackersDir, 'marketing.yaml');
    await fs.writeFile(marketingFile, buildCustomYaml('marketing', 'Marketing'), 'utf-8');

    service = (await import('../TrackerSchemaService')) as unknown as TrackerSchemaServiceModule;
    service.initTrackerSchemaService(workspacePath);
  });

  afterEach(async () => {
    service.updateTrackerSchemaWorkspace(null);
    await fs.rm(workspacePath, { recursive: true, force: true });
  });

  it('refuses to overwrite an existing custom type without opt-in', async () => {
    await expect(
      service.upsertWorkspaceTrackerSchema(
        workspacePath,
        buildCustomYaml('marketing', 'Marketing REPLACED'),
      ),
    ).rejects.toBeInstanceOf(service.TrackerTypeExistsError);

    // The original definition must survive untouched (no silent data loss).
    const onDisk = await fs.readFile(marketingFile, 'utf-8');
    expect(onDisk).toContain('displayName: Marketing');
    expect(onDisk).not.toContain('Marketing REPLACED');
  });

  it('backs up the existing definition when overwrite is opted in', async () => {
    const result = await service.upsertWorkspaceTrackerSchema(
      workspacePath,
      buildCustomYaml('marketing', 'Marketing REPLACED'),
      { overwrite: true },
    );

    expect(result.backupPath).toBeDefined();

    // New definition written.
    const onDisk = await fs.readFile(marketingFile, 'utf-8');
    expect(onDisk).toContain('Marketing REPLACED');

    // Backup holds the original, and is not loadable as a schema (.bak suffix).
    const backup = await fs.readFile(result.backupPath!, 'utf-8');
    expect(backup).toContain('displayName: Marketing');
    expect(backup).not.toContain('Marketing REPLACED');
    expect(result.backupPath!.endsWith('.bak')).toBe(true);
  });

  it('keeps built-in clobber guard for direct define calls', async () => {
    await expect(
      service.upsertWorkspaceTrackerSchema(
        workspacePath,
        buildCustomYaml('bug', 'Bug Override'),
      ),
    ).rejects.toThrow("Cannot redefine built-in tracker type 'bug'");
  });

  it('customizes and resets a built-in through the explicit override path', async () => {
    const customized = await service.customizeWorkspaceTrackerSchema(workspacePath, 'bug');

    expect(customized.created).toBe(true);
    expect(customized.model.type).toBe('bug');
    expect(path.basename(customized.filePath)).toBe('bug.yaml');

    const override = await service.getWorkspaceTrackerSchemaOverride(workspacePath, 'bug');
    expect(override).toEqual({ overridden: true, filePath: customized.filePath });
    expect(await fs.readFile(customized.filePath, 'utf-8')).toContain('type: bug');

    const reset = await service.resetWorkspaceTrackerSchemaOverride(workspacePath, 'bug');
    expect(reset).toEqual({ reset: true, filePath: customized.filePath });
    await expect(fs.stat(customized.filePath)).rejects.toThrow();

    const after = await service.getWorkspaceTrackerSchemaOverride(workspacePath, 'bug');
    expect(after).toEqual({ overridden: false });
  });

  it('opens an existing override instead of overwriting it', async () => {
    const first = await service.customizeWorkspaceTrackerSchema(workspacePath, 'bug');
    await fs.writeFile(first.filePath, buildCustomYaml('bug', 'Bug Customized'), 'utf-8');

    const second = await service.customizeWorkspaceTrackerSchema(workspacePath, 'bug');

    expect(second.created).toBe(false);
    expect(second.filePath).toBe(first.filePath);
    expect(second.model.displayName).toBe('Bug Customized');
  });
});

describe('TrackerSchemaService remote schema sync apply', () => {
  let workspacePath: string;
  let service: TrackerSchemaServiceModule;
  let applyRemoteMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    applyRemoteMock = vi.fn(async (_workspacePath: string, def: { model: string | null }) => ({
      applied: true,
      deleted: def.model === null,
    }));
    vi.doMock('../tracker/trackerTypeDefStore', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../tracker/trackerTypeDefStore')>();
      return {
        ...actual,
        applyRemoteTrackerSchemaDef: applyRemoteMock,
      };
    });

    workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'tracker-schema-sync-'));
    await fs.mkdir(path.join(workspacePath, '.nimbalyst', 'trackers'), { recursive: true });

    service = (await import('../TrackerSchemaService')) as unknown as TrackerSchemaServiceModule;
    service.initTrackerSchemaService(workspacePath);
  });

  afterEach(async () => {
    service.updateTrackerSchemaWorkspace(null);
    vi.doUnmock('../tracker/trackerTypeDefStore');
    await fs.rm(workspacePath, { recursive: true, force: true });
  });

  it('registers a valid applied remote schema in the active workspace registry', async () => {
    const model = buildSyncedModel('remoteEpic', 'Remote Epic');
    const result = await service.applyRemoteWorkspaceTrackerSchemaDef(workspacePath, {
      type: 'remoteEpic',
      model,
      syncId: 42,
    });

    expect(result).toEqual({ applied: true, deleted: false });
    expect(applyRemoteMock).toHaveBeenCalledWith(workspacePath, {
      type: 'remoteEpic',
      model,
      syncId: 42,
    });
    expect(service.getTrackerSchema('remoteEpic')?.type).toBe('remoteEpic');
    expect(mockWindowSend).toHaveBeenCalledWith('tracker-schema:changed', expect.any(Array));
  });

  it('rejects malformed remote schema JSON before it reaches the DB mirror', async () => {
    const result = await service.applyRemoteWorkspaceTrackerSchemaDef(workspacePath, {
      type: 'remoteEpic',
      model: '{"type":"different","fields":[]}',
      syncId: 1,
    });

    expect(result).toEqual({ applied: false, reason: 'invalid' });
    expect(applyRemoteMock).not.toHaveBeenCalled();
    expect(service.getTrackerSchema('remoteEpic')).toBeUndefined();
  });

  it('applies a remote tombstone to the active registry', async () => {
    await service.applyRemoteWorkspaceTrackerSchemaDef(workspacePath, {
      type: 'remoteEpic',
      model: buildSyncedModel('remoteEpic', 'Remote Epic'),
      syncId: 1,
    });
    expect(service.getTrackerSchema('remoteEpic')).toBeDefined();
    mockWindowSend.mockClear();

    const result = await service.applyRemoteWorkspaceTrackerSchemaDef(workspacePath, {
      type: 'remoteEpic',
      model: null,
      syncId: 2,
    });

    expect(result).toEqual({ applied: true, deleted: true });
    expect(service.getTrackerSchema('remoteEpic')).toBeUndefined();
    expect(mockWindowSend).toHaveBeenCalledWith('tracker-schema:changed', expect.any(Array));
  });
});
