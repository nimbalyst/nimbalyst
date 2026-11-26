// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { store } from '@nimbalyst/runtime/store';
import { fileChangedOnDiskAtomFamily } from '../../../store/atoms/fileWatch';
import { DiskBackedStore } from '../DiskBackedStore';

vi.mock('../../ErrorNotificationService', () => ({
  errorNotificationService: { showWarning: vi.fn() },
}));

const stores: DiskBackedStore[] = [];
afterEach(() => {
  stores.splice(0).forEach((backing) => backing.dispose());
  vi.unstubAllGlobals();
});

it('requests no binary payload on initial load or external-change reload', async () => {
  const read = vi.fn(async (_path, options) => ({
    success: true,
    content: options?.skipVideoContent ? '' : 'large base64 payload',
    isBinary: true,
  }));
  vi.stubGlobal('window', { electronAPI: { readFileContent: read } });
  const backing = new DiskBackedStore('/test/video.mp4');
  stores.push(backing);
  expect(await backing.load()).toBe('');
  const changed = vi.fn();
  backing.onExternalChange(changed);
  store.set(fileChangedOnDiskAtomFamily('/test/video.mp4'), 1);
  await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
  expect(read).toHaveBeenCalledTimes(2);
  for (const call of read.mock.calls) {
    expect(call).toEqual(['/test/video.mp4', { skipVideoContent: true }]);
  }
  expect(changed.mock.calls[0][0].content).toBe('');
});

it('still loads externally changed text and reports read failures', async () => {
  const read = vi.fn().mockResolvedValue({ success: true, content: 'old', isBinary: false });
  vi.stubGlobal('window', { electronAPI: { readFileContent: read } });
  const backing = new DiskBackedStore('/test/note.md');
  stores.push(backing);
  expect(await backing.load()).toBe('old');
  const changed = vi.fn();
  backing.onExternalChange(changed);
  read.mockResolvedValue({ success: true, content: 'external edit', isBinary: false });
  store.set(fileChangedOnDiskAtomFamily('/test/note.md'), 1);
  await vi.waitFor(() => expect(changed).toHaveBeenCalledWith(
    expect.objectContaining({ content: 'external edit' }),
  ));
  read.mockResolvedValue({ success: false, error: 'denied' });
  await expect(backing.load()).rejects.toThrow('Failed to load file');
});
