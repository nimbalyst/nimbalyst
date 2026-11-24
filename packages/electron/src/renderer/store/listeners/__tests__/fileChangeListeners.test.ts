// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { FileWatchHealth } from '../../../../shared/fileWatchHealth';

const notify = vi.hoisted(() => ({ showWarning: vi.fn(), showInfo: vi.fn() }));
vi.mock('../../../services/ErrorNotificationService', () => ({ errorNotificationService: notify }));

let emit: (health: FileWatchHealth & { root: string }) => void;
let cleanup: () => void = () => {};

beforeEach(async () => {
  vi.useFakeTimers();
  (globalThis as { window?: unknown }).window = {
    electronAPI: {
      on: (channel: string, callback: typeof emit) => {
        if (channel === 'file:watch-health') emit = callback;
        return () => {};
      },
    },
  };
  const { initFileChangeListeners } = await import('../fileChangeListeners');
  cleanup = initFileChangeListeners();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  notify.showWarning.mockClear();
  notify.showInfo.mockClear();
});

it('keeps the delayed warning while a retry scans, names a full watch limit, and announces only a ready watcher', () => {
  emit({ root: '/w', state: 'recovering', generation: 2, reason: 'ENOSPC' });
  vi.advanceTimersByTime(5000);
  // The retry starts a new scan; the outage is not over until that scan is ready.
  emit({ root: '/w', state: 'starting', generation: 3 });
  vi.advanceTimersByTime(5000);
  expect(notify.showWarning).toHaveBeenCalledExactlyOnceWith(
    'File updates delayed',
    expect.stringContaining('Too many files to watch in this project. Add large folders to .gitignore.'),
    { duration: 10_000 },
  );
  emit({ root: '/w', state: 'recovering', generation: 4, reason: 'ENOSPC' });
  emit({ root: '/w', state: 'starting', generation: 5 });
  expect(notify.showInfo).not.toHaveBeenCalled();
  emit({ root: '/w', state: 'watching', generation: 5 });
  expect(notify.showInfo).toHaveBeenCalledExactlyOnceWith('File updates resumed', expect.any(String));
  expect(notify.showWarning).toHaveBeenCalledTimes(1);
});

it('keeps the generic delayed text for other failures and stays quiet when recovery is quick', () => {
  emit({ root: '/a', state: 'recovering', generation: 2, reason: 'EMFILE' });
  vi.advanceTimersByTime(10_000);
  expect(notify.showWarning).toHaveBeenCalledExactlyOnceWith(
    'File updates delayed',
    expect.stringContaining('Automatic file updates are recovering.'),
    { duration: 10_000 },
  );
  emit({ root: '/b', state: 'recovering', generation: 2, reason: 'EMFILE' });
  emit({ root: '/b', state: 'starting', generation: 3 });
  emit({ root: '/b', state: 'watching', generation: 3 });
  vi.advanceTimersByTime(10_000);
  expect(notify.showWarning).toHaveBeenCalledTimes(1);
  expect(notify.showInfo).not.toHaveBeenCalled();
});
