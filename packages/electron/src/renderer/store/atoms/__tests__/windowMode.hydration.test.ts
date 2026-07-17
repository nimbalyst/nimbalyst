import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { store } from '@nimbalyst/runtime/store';
import {
  initWindowMode,
  resetWindowMode,
  windowModeAtom,
} from '../windowMode';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

describe('window mode hydration', () => {
  beforeEach(() => {
    resetWindowMode();
  });

  afterEach(() => {
    resetWindowMode();
    vi.unstubAllGlobals();
  });

  it('does not let a stale workspace response replace the active workspace mode', async () => {
    const workspaceA = deferred<{ activeMode: 'agent' }>();
    const workspaceB = deferred<{ activeMode: 'tracker' }>();
    const invoke = vi.fn((_channel: string, workspacePath: string) => (
      workspacePath === '/workspace-a' ? workspaceA.promise : workspaceB.promise
    ));
    vi.stubGlobal('window', { electronAPI: { invoke } });

    const loadA = initWindowMode('/workspace-a');
    const loadB = initWindowMode('/workspace-b');

    workspaceB.resolve({ activeMode: 'tracker' });
    await loadB;
    expect(store.get(windowModeAtom)).toBe('tracker');

    workspaceA.resolve({ activeMode: 'agent' });
    await loadA;
    expect(store.get(windowModeAtom)).toBe('tracker');

    await initWindowMode('/workspace-a');
    expect(store.get(windowModeAtom)).toBe('agent');
  });
});
