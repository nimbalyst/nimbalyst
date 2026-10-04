// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { store } from '@nimbalyst/runtime/store';
import { activeWorkspacePathAtom } from '../openProjects';
import {
  clearNavigationHistory, currentNavigationEntryAtom, goBackAtom, goForwardAtom,
  pushNavigationEntryAtom, registerNavigationRestoreCallbacks,
} from '../navigationHistory';

vi.mock('../openProjects', async () => {
  const { atom } = await import('jotai');
  return { activeWorkspacePathAtom: atom<string | null>(null) };
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => setTimeout(callback, 0));
  vi.stubGlobal('window', {});
  store.set(activeWorkspacePathAtom, '/projects/LibraryKit');
  clearNavigationHistory();
});
afterEach(() => {
  vi.runAllTimers();
  registerNavigationRestoreCallbacks({ restoreSettings: undefined });
  clearNavigationHistory();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('keeps separate history entries for the same settings page in different projects', () => {
  const restoreSettings = vi.fn();
  registerNavigationRestoreCallbacks({ restoreSettings });
  const settings = (workspacePath: string) => ({
    category: 'project-appearance', scope: 'project' as const,
    target: { kind: 'workspace' as const, workspacePath },
  });
  const fileRocket = settings('/projects/FileRocket');
  const libraryKit = settings('/projects/LibraryKit');
  store.set(pushNavigationEntryAtom, { mode: 'settings', settings: fileRocket });
  store.set(pushNavigationEntryAtom, { mode: 'settings', settings: libraryKit });
  // A repeated render of the same destination must not create a third entry.
  store.set(pushNavigationEntryAtom, { mode: 'settings', settings: settings('/projects/LibraryKit') });
  expect(store.get(currentNavigationEntryAtom)?.settings).toEqual(libraryKit);
  store.set(goBackAtom);
  expect(restoreSettings).toHaveBeenLastCalledWith(fileRocket);
  vi.runAllTimers();
  store.set(goForwardAtom);
  expect(restoreSettings).toHaveBeenLastCalledWith(libraryKit);
});
