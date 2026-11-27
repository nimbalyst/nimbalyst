// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { read, window, states } = vi.hoisted(() => ({
  read: vi.fn(() => 'text content'),
  window: { isDestroyed: () => false, setRepresentedFilename: vi.fn() },
  states: new Map(),
}));
vi.mock('electron', () => ({ BrowserWindow: {}, dialog: {} }));
vi.mock('fs', () => ({ existsSync: () => true, readFileSync: read }));
vi.mock('../../window/WindowManager', () => ({
  windowStates: states,
  getWindowId: () => 1,
}));
vi.mock('../FileWatcher', () => ({ startFileWatcher: vi.fn() }));
vi.mock('../../utils/store', () => ({ addWorkspaceRecentFile: vi.fn() }));
vi.mock('../../services/analytics/AnalyticsService', () => ({
  AnalyticsService: { getInstance: () => ({ sendEvent: vi.fn() }) },
}));
vi.mock('../../utils/dialogPaths', () => ({}));

import { openFile } from '../FileOpener';
import { clearRegisteredExtensions, registerFileExtension } from '../../extensions/RegisteredFileTypes';

describe('opening streamed video files', () => {
  beforeEach(() => {
    read.mockClear();
    states.clear();
    clearRegisteredExtensions();
    registerFileExtension('.mp4');
  });

  const open = (filePath: string) => openFile({
    filePath,
    targetWindow: window as any,
    skipFileWatcher: true,
    skipAnalytics: true,
  });

  it.each(['video.mp4', 'VIDEO.MP4'])(
    'opens %s without reading or sending the file bytes',
    async (file) => {
      expect(await open(file)).toMatchObject({ filePath: file, content: '' });
      expect(read).not.toHaveBeenCalled();
      expect(states.get(1).filePath).toBe(file);
    },
  );

  it('still loads text content', async () => {
    expect(await open('note.md')).toMatchObject({ content: 'text content' });
    expect(read).toHaveBeenCalledExactlyOnceWith('note.md', 'utf-8');
  });

  it('rejects an MP4 without a registered editor', async () => {
    clearRegisteredExtensions();
    await expect(open('video.mp4')).rejects.toThrow('does not support that file type');
    expect(read).not.toHaveBeenCalled();
  });
});
