// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { store } from '../../index';
import { activeWorkspacePathAtom } from '../../atoms/openProjects';
import { ollamaUsageAtom } from '../../atoms/ollamaUsageAtoms';
import { initOllamaUsageListeners, loadOllamaResetTimes } from '../ollamaUsageListeners';

vi.mock('../../index', async () => {
  const { createStore } = await import('jotai');
  return { store: createStore() };
});

describe('Ollama usage listener workspace boundary', () => {
  beforeEach(() => {
    store.set(activeWorkspacePathAtom, null);
    store.set(ollamaUsageAtom, null);
  });

  it('ignores a stale startup response and a broadcast from another project', async () => {
    const requests: Array<{ workspacePath: string; resolve: (value: any) => void }> = [];
    const callbacks: { broadcast?: (payload: any) => void } = {};
    (window as any).electronAPI = {
      on: vi.fn((_channel: string, handler: (payload: any) => void) => {
        callbacks.broadcast = handler;
        return () => {};
      }),
      invoke: vi.fn((_channel: string, workspacePath: string) =>
        new Promise((resolve) => requests.push({ workspacePath, resolve }))),
    };
    store.set(activeWorkspacePathAtom, '/ws/A');
    const cleanup = initOllamaUsageListeners();
    store.set(activeWorkspacePathAtom, '/ws/B');
    expect(requests.map(({ workspacePath }) => workspacePath)).toEqual(['/ws/A', '/ws/B']);

    const usageA = { limitsAvailable: true, weekly: { utilization: 10 } };
    const usageB = { limitsAvailable: true, weekly: { utilization: 20 } };
    requests[0].resolve(usageA);
    await Promise.resolve();
    expect(store.get(ollamaUsageAtom)).toBeNull();
    requests[1].resolve(usageB);
    await Promise.resolve();
    expect(store.get(ollamaUsageAtom)).toBe(usageB);
    callbacks.broadcast?.({ workspacePath: '/ws/A', usage: usageA });
    expect(store.get(ollamaUsageAtom)).toBe(usageB);
    cleanup();
  });
  it('loads reset times only for the requested active project and rejects a late reply after a switch', async () => {
    let resolve!: (value: any) => void;
    (window as any).electronAPI = { invoke: vi.fn(() => new Promise(done => { resolve = done; })) };
    store.set(activeWorkspacePathAtom, '/fixture/A');
    const pending = loadOllamaResetTimes();
    expect(window.electronAPI.invoke).toHaveBeenCalledWith('ollama-usage:reset-times', '/fixture/A');
    store.set(activeWorkspacePathAtom, '/fixture/B'); resolve({ limitsAvailable: true });
    await pending; expect(store.get(ollamaUsageAtom)).toBeNull();
  });
});
