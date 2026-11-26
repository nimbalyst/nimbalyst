// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { handlers, read } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  read: vi.fn(),
}));
vi.mock('fs', async () => ({
  ...await vi.importActual<typeof import('fs')>('fs'),
  existsSync: (path: string) => path !== '/test/missing.mp4',
  readFileSync: read,
}));
vi.mock('electron', () => ({ BrowserWindow: {}, shell: {}, clipboard: {}, nativeImage: {} }));
vi.mock('../../utils/ipcRegistry', () => ({
  safeHandle: (name: string, handler: any) => handlers.set(name, handler),
  safeOn: vi.fn(),
}));
vi.mock('../../services/analytics/AnalyticsService', () => ({
  AnalyticsService: { getInstance: () => ({ sendEvent: vi.fn() }) },
}));
vi.mock('../../file/FileOpener', () => ({}));
vi.mock('../../window/WindowManager', () => ({}));
vi.mock('../../window/windowState', () => ({}));
vi.mock('../../file/FileWatcher', () => ({}));
vi.mock('../../utils/FileTree', () => ({}));
vi.mock('../../utils/store', () => ({}));
vi.mock('../../file/FileOperations', () => ({}));
vi.mock('../../services/DocSyncService', () => ({}));
vi.mock('../../services/tracker/localKeyAllocator', () => ({}));
vi.mock('../../services/tracker/workspaceLocalKeyStore', () => ({}));
vi.mock('../../database/PGLiteDatabaseWorker', () => ({}));
vi.mock('../../services/ripgrepPath', () => ({}));
vi.mock('../../file/QuickOpenFileScanner', () => ({}));
vi.mock('../../file/QuickOpenFileNameCache', () => ({}));

import { registerWorkspaceHandlers } from '../WorkspaceHandlers';

describe('read-file-content for binary tab bookkeeping', () => {
  beforeEach(() => {
    read.mockReset().mockReturnValue(Buffer.from('file bytes'));
    registerWorkspaceHandlers();
  });
  const load = (path: string, options?: object) =>
    handlers.get('read-file-content')!({}, path, options);

  it.each(['mp4', 'MP4'])(
    'does not read or base64-encode %s for the document model',
    async (extension) => {
      expect(await load(`/test/file.${extension}`, { skipVideoContent: true }))
        .toEqual({ success: true, content: '', isBinary: true });
      expect(read).not.toHaveBeenCalled();
    },
  );

  it('keeps explicit binary loads and default binary reads intact', async () => {
    for (const options of [undefined, { binary: true }, { binary: true, skipVideoContent: true }]) {
      expect(await load('/test/file.mp4', options)).toEqual({
        success: true,
        content: Buffer.from('file bytes').toString('base64'),
        isBinary: true,
      });
    }
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('still decodes externally changed text when binary content is skipped', async () => {
    const text = 'External edit — café';
    read.mockReturnValue(Buffer.from(text));
    expect(await load('/test/note.md', { skipVideoContent: true }))
      .toMatchObject({ success: true, content: text, isBinary: false });
    expect(read).toHaveBeenCalledExactlyOnceWith('/test/note.md');
  });

  it('does not turn a missing binary file into a successful empty read', async () => {
    expect(await load('/test/missing.mp4', { skipVideoContent: true })).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });
});
