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
    options?: { fileName?: string; overwrite?: boolean },
  ) => Promise<{ model: { type: string }; filePath: string; backupPath?: string }>;
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
});
