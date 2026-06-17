import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockSafeHandle,
  mockWatch,
  mockWindowSend,
  watcherHandlers,
} = vi.hoisted(() => {
  const handlers: Record<string, ((arg: string | unknown) => void) | undefined> = {};
  return {
    mockSafeHandle: vi.fn(),
    mockWatch: vi.fn(() => ({
      on(event: string, handler: (arg: string | unknown) => void) {
        handlers[event] = handler;
        return this;
      },
      close: vi.fn().mockResolvedValue(undefined),
    })),
    mockWindowSend: vi.fn(),
    watcherHandlers: handlers,
  };
});

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
    getAllWindows: () => [
      {
        webContents: {
          send: mockWindowSend,
        },
      },
    ],
  },
}));

vi.mock('../../utils/ipcRegistry', () => ({
  safeHandle: mockSafeHandle,
  safeOn: vi.fn(),
  safeOnce: vi.fn(),
}));

vi.mock('chokidar', () => ({
  default: {
    watch: mockWatch,
  },
}));

interface TrackerSchemaServiceModule {
  initTrackerSchemaService: (workspacePath?: string | null) => void;
  updateTrackerSchemaWorkspace: (workspacePath: string | null) => void;
  getTrackerSchema: (type: string) => { displayName: string } | undefined;
}

function buildYaml(displayName: string): string {
  return `packageVersion: 1.0.0
packageId: developer

type: runtime-watch
displayName: ${displayName}
displayNamePlural: Runtime Watches
icon: science
color: "#0f766e"

modes:
  inline: false
  fullDocument: false

sync:
  mode: local
  scope: project

idPrefix: rwt
idFormat: ulid

fields:
  - name: title
    type: string
    required: true
    displayInline: true

  - name: status
    type: select
    default: backlog
    options:
      - value: backlog
        label: Backlog
      - value: done
        label: Done

roles:
  title: title
  workflowStatus: status
`;
}

describe('TrackerSchemaService watcher', () => {
  let workspacePath: string;
  let trackersDir: string;
  let service: TrackerSchemaServiceModule;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    for (const key of Object.keys(watcherHandlers)) {
      delete watcherHandlers[key];
    }

    workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'tracker-schema-watch-'));
    trackersDir = path.join(workspacePath, '.nimbalyst', 'trackers');
    await fs.mkdir(trackersDir, { recursive: true });

    service = await import('../TrackerSchemaService');
    service.initTrackerSchemaService(workspacePath);
  });

  afterEach(async () => {
    service.updateTrackerSchemaWorkspace(null);
    await fs.rm(workspacePath, { recursive: true, force: true });
  });

  it('hot-loads added, edited, and deleted workspace schemas through watcher callbacks', async () => {
    const filePath = path.join(trackersDir, 'runtime-watch.yaml');

    expect(mockWatch).toHaveBeenCalledTimes(1);
    expect(typeof watcherHandlers.add).toBe('function');
    expect(typeof watcherHandlers.change).toBe('function');
    expect(typeof watcherHandlers.unlink).toBe('function');

    await fs.writeFile(filePath, buildYaml('Runtime Watch Added'), 'utf-8');
    watcherHandlers.add?.(filePath);

    expect(service.getTrackerSchema('runtime-watch')?.displayName).toBe('Runtime Watch Added');
    expect(mockWindowSend).toHaveBeenCalledWith(
      'tracker-schema:changed',
      expect.arrayContaining([expect.objectContaining({ type: 'runtime-watch' })]),
    );

    mockWindowSend.mockClear();
    await fs.writeFile(filePath, buildYaml('Runtime Watch Updated'), 'utf-8');
    watcherHandlers.change?.(filePath);

    expect(service.getTrackerSchema('runtime-watch')?.displayName).toBe('Runtime Watch Updated');
    expect(mockWindowSend).toHaveBeenCalledWith(
      'tracker-schema:changed',
      expect.arrayContaining([
        expect.objectContaining({
          type: 'runtime-watch',
          displayName: 'Runtime Watch Updated',
        }),
      ]),
    );

    mockWindowSend.mockClear();
    await fs.unlink(filePath);
    watcherHandlers.unlink?.(filePath);

    expect(service.getTrackerSchema('runtime-watch')).toBeUndefined();
    expect(mockWindowSend).toHaveBeenCalledWith('tracker-schema:changed', expect.any(Array));
  });
});
