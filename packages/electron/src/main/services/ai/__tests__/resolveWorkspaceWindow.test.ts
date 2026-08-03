// @vitest-environment node
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  AUTO_OPEN_COOLDOWN_MS,
  WORKSPACE_WINDOW_LOAD_TIMEOUT_MS,
  createWorkspaceWindowResolver,
  waitForWorkspaceWindowLoad,
  type WorkspaceWindowResolverDeps,
} from '../resolveWorkspaceWindow';

interface FakeWindow {
  id: number;
  destroyed: boolean;
}

function createHarness(overrides: Partial<WorkspaceWindowResolverDeps<FakeWindow>> = {}) {
  const windows = new Map<string, FakeWindow>();
  let nextId = 1;
  let clock = 1_000;
  let resolveLoad: (() => void) | null = null;

  const createWindow = vi.fn((workspacePath: string) => {
    const window = { id: nextId++, destroyed: false };
    windows.set(workspacePath, window);
    return window;
  });

  const waitForLoad = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        resolveLoad = resolve;
      }),
  );

  const deps: WorkspaceWindowResolverDeps<FakeWindow> = {
    findWindow: (workspacePath) => windows.get(workspacePath) ?? null,
    isDestroyed: (window) => window.destroyed,
    workspaceExists: () => true,
    createWindow,
    waitForLoad,
    isQuitting: () => false,
    now: () => clock,
    logInfo: vi.fn(),
    logWarn: vi.fn(),
    ...overrides,
  };

  return {
    resolver: createWorkspaceWindowResolver(deps),
    windows,
    createWindow,
    finishLoad: () => resolveLoad?.(),
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

function createLoadHarness() {
  const window = new EventEmitter() as EventEmitter & { destroyed: boolean; isDestroyed(): boolean };
  const webContents = new EventEmitter() as EventEmitter & {
    destroyed: boolean;
    isDestroyed(): boolean;
  };
  window.destroyed = false;
  window.isDestroyed = () => window.destroyed;
  webContents.destroyed = false;
  webContents.isDestroyed = () => webContents.destroyed;
  Object.assign(window, { webContents });

  const timerCalls: Array<{ fn: () => void; ms: number; handle: number }> = [];
  const clearedHandles: unknown[] = [];
  const timers = {
    setTimeout: (fn: () => void, ms: number) => {
      const handle = timerCalls.length + 1;
      timerCalls.push({ fn, ms, handle });
      return handle;
    },
    clearTimeout: (handle: unknown) => {
      clearedHandles.push(handle);
    },
  };

  return { window, webContents, timers, timerCalls, clearedHandles };
}

describe('resolveWorkspaceWindow', () => {
  it('uses the live window without opening anything', async () => {
    const harness = createHarness();
    harness.windows.set('/ws', { id: 42, destroyed: false });

    const result = await harness.resolver.resolve('/ws');

    expect(result).toEqual({ kind: 'window', window: { id: 42, destroyed: false }, opened: false });
    expect(harness.createWindow).not.toHaveBeenCalled();
  });

  it('auto-opens a window when none exists and reports it as opened', async () => {
    const harness = createHarness();

    const pending = harness.resolver.resolve('/ws');
    harness.finishLoad();
    const result = await pending;

    expect(harness.createWindow).toHaveBeenCalledTimes(1);
    expect(result.kind).toBe('window');
    expect(result.kind === 'window' && result.opened).toBe(true);
  });

  it('opens one window for two rapid prompts on the same workspace', async () => {
    const harness = createHarness();

    const first = harness.resolver.resolve('/ws');
    const second = harness.resolver.resolve('/ws');
    harness.finishLoad();

    const [a, b] = await Promise.all([first, second]);

    expect(harness.createWindow).toHaveBeenCalledTimes(1);
    expect(a.kind).toBe('window');
    expect(b.kind).toBe('window');
    expect(a.kind === 'window' && b.kind === 'window' && a.window.id).toBe(
      b.kind === 'window' ? b.window.id : -1,
    );
  });

  it('joins an opening window before applying a concurrent caller auto-open policy', async () => {
    const harness = createHarness();

    const first = harness.resolver.resolve('/ws');
    const second = harness.resolver.resolve('/ws', { allowAutoOpen: false });

    expect(harness.createWindow).toHaveBeenCalledTimes(1);
    harness.finishLoad();
    const [a, b] = await Promise.all([first, second]);

    expect(a.kind === 'window' && a.opened).toBe(true);
    expect(b.kind === 'window' && b.opened).toBe(true);
  });

  it('preserves an existing live window even when the workspace folder is unavailable', async () => {
    const existing = { id: 7, destroyed: false };
    const harness = createHarness({
      findWindow: vi.fn(() => existing),
      workspaceExists: vi.fn(() => false),
    });

    await expect(harness.resolver.resolve('/ws')).resolves.toEqual({
      kind: 'window',
      window: existing,
      opened: false,
    });
    expect(harness.createWindow).not.toHaveBeenCalled();
  });

  it('defers instead of re-opening while the auto-open cooldown is active', async () => {
    const harness = createHarness();

    const first = harness.resolver.resolve('/ws');
    harness.finishLoad();
    await first;

    // The window is gone again (user closed it) well inside the cooldown.
    harness.windows.delete('/ws');
    const second = await harness.resolver.resolve('/ws');

    expect(second).toEqual({ kind: 'deferred', reason: 'no-window' });
    expect(harness.createWindow).toHaveBeenCalledTimes(1);

    harness.advance(AUTO_OPEN_COOLDOWN_MS + 1);
    const third = harness.resolver.resolve('/ws');
    harness.finishLoad();
    await third;

    expect(harness.createWindow).toHaveBeenCalledTimes(2);
  });

  it('defers without opening when auto-open is disallowed or the app is quitting', async () => {
    const harness = createHarness();
    expect(await harness.resolver.resolve('/ws', { allowAutoOpen: false })).toEqual({
      kind: 'deferred',
      reason: 'no-window',
    });

    const quitting = createHarness({ isQuitting: () => true });
    expect(await quitting.resolver.resolve('/ws')).toEqual({ kind: 'deferred', reason: 'no-window' });
    expect(quitting.createWindow).not.toHaveBeenCalled();
    expect(harness.createWindow).not.toHaveBeenCalled();
  });

  it('reports a missing project folder as terminal rather than deferring forever', async () => {
    const harness = createHarness({ workspaceExists: () => false });

    expect(await harness.resolver.resolve('/gone')).toEqual({
      kind: 'terminal',
      reason: 'workspace-missing',
    });
    expect(harness.createWindow).not.toHaveBeenCalled();
  });

  it('settles the production load waiter on a successful load and removes all resources', async () => {
    const harness = createLoadHarness();
    const pending = waitForWorkspaceWindowLoad(harness.window as never, harness.timers);

    expect(harness.timerCalls).toHaveLength(1);
    expect(harness.timerCalls[0].ms).toBe(WORKSPACE_WINDOW_LOAD_TIMEOUT_MS);
    harness.webContents.emit('did-finish-load');
    await expect(pending).resolves.toBeUndefined();

    expect(harness.clearedHandles).toEqual([1]);
    expect(harness.webContents.eventNames()).toHaveLength(0);
    expect(harness.window.eventNames()).toHaveLength(0);
  });

  it.each([
    ['failed load', 'webContents', 'did-fail-load'],
    ['renderer loss', 'webContents', 'render-process-gone'],
    ['renderer destruction', 'webContents', 'destroyed'],
    ['window close', 'window', 'close'],
    ['window destruction', 'window', 'closed'],
  ])('settles and cleans up when there is %s', async (_label, target, event) => {
    const harness = createLoadHarness();
    const pending = waitForWorkspaceWindowLoad(harness.window as never, harness.timers);

    (target === 'window' ? harness.window : harness.webContents).emit(event);
    await expect(pending).rejects.toThrow();

    expect(harness.clearedHandles).toEqual([1]);
    expect(harness.webContents.eventNames()).toHaveLength(0);
    expect(harness.window.eventNames()).toHaveLength(0);
  });

  it('settles and cleans up when the production load bound expires', async () => {
    const harness = createLoadHarness();
    const pending = waitForWorkspaceWindowLoad(harness.window as never, harness.timers);

    harness.timerCalls[0].fn();
    await expect(pending).rejects.toThrow('Workspace window load timed out');

    expect(harness.clearedHandles).toEqual([1]);
    expect(harness.webContents.eventNames()).toHaveLength(0);
    expect(harness.window.eventNames()).toHaveLength(0);
  });
});
