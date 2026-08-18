// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('electron', () => ({
  ipcMain: {
    on: vi.fn(),
    handle: vi.fn(),
  },
}));

vi.mock('../../utils/logger', () => ({
  logger: {
    main: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
  },
}));

import { ipcMain } from 'electron';
import { seedProjectIntoWindow, getPendingSeedCountForTests, RAIL_ADD_PROJECT_RESULT_CHANNEL } from '../railSeeding';
import { RAIL_ADD_PROJECT_CHANNEL } from '../resolveProjectOpenTarget';

// `railSeeding.ts` registers its `rail:add-project-result` listener exactly
// once, at module import time (a `safeOn` process singleton -- see the
// module doc comment). Capture it here, once, right after the import above
// runs; `ipcMain.on`'s mock call history is otherwise untouched by any test
// in this file.
const resultHandler = vi
  .mocked(ipcMain.on)
  .mock.calls.find(([channel]) => channel === RAIL_ADD_PROJECT_RESULT_CHANNEL)?.[1] as
  | ((event: unknown, data: unknown) => void)
  | undefined;

function createFakeWindow() {
  const emitter = new EventEmitter();
  let destroyed = false;
  return {
    isDestroyed: () => destroyed,
    webContents: { send: vi.fn() },
    once: emitter.once.bind(emitter),
    removeListener: emitter.removeListener.bind(emitter),
    listenerCount: (event: string) => emitter.listenerCount(event),
    emitClosed: () => {
      destroyed = true;
      emitter.emit('closed');
    },
  };
}

function sendPayload(fakeWindow: ReturnType<typeof createFakeWindow>) {
  const call = fakeWindow.webContents.send.mock.calls[0];
  return call?.[1] as { workspacePath: string; activate: boolean; requestId: string };
}

describe('railSeeding', () => {
  it('registers the rail:add-project-result listener exactly once at module load', () => {
    expect(resultHandler).toBeTypeOf('function');
    // Registered via `safeOn` -- the ipcRegistry channel is `ipcMain.on`'s
    // second arg, the wrapped handler itself (no extra instrumentation
    // wrapper for `.on`, unlike `safeHandle`).
    expect(
      vi.mocked(ipcMain.on).mock.calls.filter(([channel]) => channel === RAIL_ADD_PROJECT_RESULT_CHANNEL),
    ).toHaveLength(1);
  });

  // Every test below either awaits the seed promise to full resolution
  // (ack, forced timeout, or window destruction) or explicitly acks before
  // finishing -- `pending`'s entries are keyed for the process lifetime of
  // this shared module, and a real (un-awaited) 2s timeout left dangling
  // from one test would pollute `getPendingSeedCountForTests()` assertions
  // in a later one.

  it('sends rail:add-project with a generated requestId and the requested activate flag', async () => {
    const fakeWindow = createFakeWindow();
    const resultPromise = seedProjectIntoWindow(fakeWindow as any, '/ws/a', { activate: false });

    const payload = sendPayload(fakeWindow);
    expect(payload.workspacePath).toBe('/ws/a');
    expect(payload.activate).toBe(false);
    expect(payload.requestId).toBeTruthy();

    resultHandler!({}, { requestId: payload.requestId, workspacePath: '/ws/a', outcome: 'added' });
    await resultPromise;
  });

  it('defaults activate to true when not specified', async () => {
    const fakeWindow = createFakeWindow();
    const resultPromise = seedProjectIntoWindow(fakeWindow as any, '/ws/a');
    const payload = sendPayload(fakeWindow);
    expect(payload.activate).toBe(true);

    resultHandler!({}, { requestId: payload.requestId, outcome: 'added' });
    await resultPromise;
  });

  it('resolves with the renderer-reported outcome when the ack arrives, and cleans up', async () => {
    const fakeWindow = createFakeWindow();
    const resultPromise = seedProjectIntoWindow(fakeWindow as any, '/ws/a', { activate: false });
    const { requestId } = sendPayload(fakeWindow);

    resultHandler!({}, { requestId, workspacePath: '/ws/a', outcome: 'added' });

    await expect(resultPromise).resolves.toBe('added');
    expect(getPendingSeedCountForTests()).toBe(0);
    // The 'closed' listener registered for this request is removed once the
    // ack settles it -- no leak.
    expect(fakeWindow.listenerCount('closed')).toBe(0);
  });

  it.each(['already-open', 'at-cap'] as const)('resolves with outcome "%s"', async (outcome) => {
    const fakeWindow = createFakeWindow();
    const resultPromise = seedProjectIntoWindow(fakeWindow as any, '/ws/a');
    const { requestId } = sendPayload(fakeWindow);

    resultHandler!({}, { requestId, workspacePath: '/ws/a', outcome });

    await expect(resultPromise).resolves.toBe(outcome);
  });

  it('resolves "timeout" and does not leak when no ack lands in time', async () => {
    vi.useFakeTimers();
    try {
      const fakeWindow = createFakeWindow();
      const resultPromise = seedProjectIntoWindow(fakeWindow as any, '/ws/a', { timeoutMs: 50 });

      await vi.advanceTimersByTimeAsync(50);

      await expect(resultPromise).resolves.toBe('timeout');
      expect(getPendingSeedCountForTests()).toBe(0);
      expect(fakeWindow.listenerCount('closed')).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves "timeout" and does not leak when the window is destroyed before an ack arrives', async () => {
    const fakeWindow = createFakeWindow();
    const resultPromise = seedProjectIntoWindow(fakeWindow as any, '/ws/a', { timeoutMs: 5000 });

    fakeWindow.emitClosed();

    await expect(resultPromise).resolves.toBe('timeout');
    expect(getPendingSeedCountForTests()).toBe(0);
  });

  it('resolves "timeout" immediately without sending for an already-destroyed window', async () => {
    const fakeWindow = createFakeWindow();
    fakeWindow.emitClosed();
    fakeWindow.webContents.send.mockClear();

    const result = await seedProjectIntoWindow(fakeWindow as any, '/ws/a');

    expect(result).toBe('timeout');
    expect(fakeWindow.webContents.send).not.toHaveBeenCalled();
    expect(getPendingSeedCountForTests()).toBe(0);
  });

  it('ignores an ack for an unknown requestId without throwing or settling anything', async () => {
    const fakeWindow = createFakeWindow();
    const resultPromise = seedProjectIntoWindow(fakeWindow as any, '/ws/a');
    const { requestId } = sendPayload(fakeWindow);

    expect(() => resultHandler!({}, { requestId: 'unknown-id', outcome: 'added' })).not.toThrow();
    expect(getPendingSeedCountForTests()).toBeGreaterThan(0);

    resultHandler!({}, { requestId, workspacePath: '/ws/a', outcome: 'added' });
    await expect(resultPromise).resolves.toBe('added');
  });
});
