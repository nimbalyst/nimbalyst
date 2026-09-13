// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { usePrTrackerContext } from '../usePrTrackerContext';

vi.mock('@nimbalyst/runtime/plugins/TrackerPlugin/prReferences', async () => {
  const { atom } = await import('jotai');
  const references = atom(new Map());
  return { prTrackerReferencesAtom: () => references };
});
vi.mock('../../../store/atoms/sessions', async () => {
  const { atom } = await import('jotai');
  return {
    sessionRegistryAtom: atom(new Map([
      ['session-1', { id: 'session-1', worktreeId: 'worktree-1', updatedAt: 1 }],
    ])),
  };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('never exposes the previous PR worktree session while the new lookup is pending', async () => {
  let resolveLookup!: (rows: unknown[]) => void;
  vi.stubGlobal('electronAPI', {
    invoke: vi.fn().mockImplementation(() => new Promise(resolve => {
      resolveLookup = resolve;
    })),
  });
  const renders: string[][] = [];
  const view = renderHook(({ number }) => {
    const context = usePrTrackerContext('/workspace', 'owner/repo', number);
    renders.push(context.sessions.map(session => session.id));
    return context;
  }, { initialProps: { number: 1 } });

  await act(async () => {
    resolveLookup([{ id: 'worktree-1', prNumber: 1, prRemote: 'owner/repo' }]);
  });
  expect(view.result.current.sessions.map(session => session.id)).toEqual(['session-1']);
  renders.length = 0;
  view.rerender({ number: 2 });
  expect(renders.every(sessions => sessions.length === 0)).toBe(true);
  await act(async () => { resolveLookup([]); });
  expect(view.result.current.sessions).toEqual([]);
});
