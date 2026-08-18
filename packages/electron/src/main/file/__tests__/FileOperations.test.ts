// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  windowStates: new Map<number, any>(),
  getWindowId: vi.fn(),
  addToRecentItems: vi.fn(),
  loggerWarn: vi.fn(),
}));

vi.mock('../../window/WindowManager', () => ({
  windowStates: mocks.windowStates,
  getWindowId: mocks.getWindowId,
}));

vi.mock('../../utils/store', () => ({
  addToRecentItems: mocks.addToRecentItems,
}));

vi.mock('../../utils/logger', () => ({
  logger: {
    main: { warn: mocks.loggerWarn, error: vi.fn(), info: vi.fn(), debug: vi.fn() },
  },
}));

import { loadFileIntoWindow, deliverAfterWorkspaceSeed } from '../FileOperations';

function fakeWindow() {
  return {
    webContents: { send: vi.fn() },
    setRepresentedFilename: vi.fn(),
  };
}

/** Deferred promise so tests can control exactly when the seed "resolves"
 *  relative to assertions about `deliver`/`onBlocked` not having run yet. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('loadFileIntoWindow', () => {
  beforeEach(() => {
    mocks.windowStates.clear();
    mocks.getWindowId.mockReset();
    mocks.loggerWarn.mockClear();
  });

  it('warns when expectedWorkspacePath was never registered on the target window', () => {
    mocks.getWindowId.mockReturnValue(1);
    mocks.windowStates.set(1, { workspacePath: '/ws/a', additionalWorkspacePaths: [] });

    loadFileIntoWindow(fakeWindow() as any, '/ws/b/file.md', '/ws/b');

    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('not registered the expected workspace'),
      expect.objectContaining({ expectedWorkspacePath: '/ws/b' }),
    );
  });

  it('does not warn when expectedWorkspacePath is the window primary workspace', () => {
    mocks.getWindowId.mockReturnValue(1);
    mocks.windowStates.set(1, { workspacePath: '/ws/a', additionalWorkspacePaths: [] });

    loadFileIntoWindow(fakeWindow() as any, '/ws/a/file.md', '/ws/a');

    expect(mocks.loggerWarn).not.toHaveBeenCalled();
  });

  it('does not warn when expectedWorkspacePath is a rail-seeded additional workspace', () => {
    mocks.getWindowId.mockReturnValue(1);
    mocks.windowStates.set(1, { workspacePath: '/ws/a', additionalWorkspacePaths: ['/ws/b'] });

    loadFileIntoWindow(fakeWindow() as any, '/ws/b/file.md', '/ws/b');

    expect(mocks.loggerWarn).not.toHaveBeenCalled();
  });

  it('does not warn when no expectedWorkspacePath is passed (existing callers unaffected)', () => {
    mocks.getWindowId.mockReturnValue(1);
    mocks.windowStates.set(1, { workspacePath: '/ws/a', additionalWorkspacePaths: [] });

    loadFileIntoWindow(fakeWindow() as any, '/ws/a/file.md');

    expect(mocks.loggerWarn).not.toHaveBeenCalled();
  });
});

describe('deliverAfterWorkspaceSeed', () => {
  it('does not call deliver until the outcome promise resolves', async () => {
    const { promise, resolve } = deferred<{ kind: 'add-to-rail' }>();
    const deliver = vi.fn();

    const resultPromise = deliverAfterWorkspaceSeed(promise, deliver);

    // Outcome is still in flight -- deliver must not have run yet.
    await Promise.resolve();
    await Promise.resolve();
    expect(deliver).not.toHaveBeenCalled();

    resolve({ kind: 'add-to-rail' });
    await resultPromise;

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith({ kind: 'add-to-rail' });
  });

  it('calls deliver for a non-blocked outcome and returns true', async () => {
    const deliver = vi.fn();
    const onBlocked = vi.fn();

    const delivered = await deliverAfterWorkspaceSeed(
      Promise.resolve({ kind: 'focus-existing' as const }),
      deliver,
      onBlocked,
    );

    expect(delivered).toBe(true);
    expect(deliver).toHaveBeenCalledWith({ kind: 'focus-existing' });
    expect(onBlocked).not.toHaveBeenCalled();
  });

  it.each(['at-cap', 'timeout'] as const)(
    'never calls deliver when the seed resolves "blocked" (reason: %s) -- the payload must not land in the wrong project',
    async (reason) => {
      const deliver = vi.fn();
      const onBlocked = vi.fn();

      const delivered = await deliverAfterWorkspaceSeed(
        Promise.resolve({ kind: 'blocked' as const, reason }),
        deliver,
        onBlocked,
      );

      expect(delivered).toBe(false);
      expect(deliver).not.toHaveBeenCalled();
      expect(onBlocked).toHaveBeenCalledWith({ kind: 'blocked', reason });
    },
  );

  it('does not throw when onBlocked is omitted for a blocked outcome', async () => {
    const deliver = vi.fn();

    await expect(
      deliverAfterWorkspaceSeed(Promise.resolve({ kind: 'blocked' as const, reason: 'timeout' as const }), deliver),
    ).resolves.toBe(false);
    expect(deliver).not.toHaveBeenCalled();
  });
});
