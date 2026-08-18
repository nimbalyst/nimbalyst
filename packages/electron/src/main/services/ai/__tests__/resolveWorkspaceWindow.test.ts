// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  AUTO_OPEN_COOLDOWN_MS,
  createWorkspaceWindowResolver,
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

  const openWorkspace = vi.fn((workspacePath: string) => {
    const window = { id: nextId++, destroyed: false };
    windows.set(workspacePath, window);
    return { window, isNewWindow: true };
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
    openWorkspace,
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
    createWindow: openWorkspace,
    finishLoad: () => resolveLoad?.(),
    advance: (ms: number) => {
      clock += ms;
    },
  };
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

  it('does not wait for load when the workspace was added to an already-loaded rail window', async () => {
    const railWindow: FakeWindow = { id: 99, destroyed: false };
    const waitForLoad = vi.fn(() => new Promise<void>(() => {}));
    const harness = createHarness({
      openWorkspace: vi.fn(() => ({ window: railWindow, isNewWindow: false })),
      waitForLoad,
    });

    const result = await harness.resolver.resolve('/ws');

    expect(waitForLoad).not.toHaveBeenCalled();
    expect(result).toEqual({ kind: 'window', window: railWindow, opened: true });
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
});
