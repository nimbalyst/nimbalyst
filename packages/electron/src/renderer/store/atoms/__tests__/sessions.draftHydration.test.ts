import { afterEach, describe, expect, it, vi } from 'vitest';
import { store } from '@nimbalyst/runtime/store';
import {
  canPersistSessionDraft,
  loadSessionDataAtom,
  sessionDraftHydratedAtom,
  sessionDraftInputAtom,
  sessionDraftLocalModifiedAtAtom,
} from '../sessions';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

describe('session draft hydration', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not allow the default empty draft to persist before hydration', () => {
    expect(canPersistSessionDraft(false, 0)).toBe(false);
    expect(canPersistSessionDraft(false, Date.now())).toBe(true);
    expect(canPersistSessionDraft(true, 0)).toBe(true);
  });

  it('seeds the saved draft and marks the session hydrated', async () => {
    const sessionId = 'draft-hydration-saved';
    vi.stubGlobal('window', {
      electronAPI: {
        aiLoadSession: vi.fn().mockResolvedValue({
          model: 'claude:test',
          draftInput: 'saved draft',
        }),
      },
    });

    await store.set(loadSessionDataAtom, { sessionId, workspacePath: '/workspace' });

    expect(store.get(sessionDraftInputAtom(sessionId))).toBe('saved draft');
    expect(store.get(sessionDraftHydratedAtom(sessionId))).toBe(true);
  });

  it('preserves typing that happens while the saved draft is loading', async () => {
    const sessionId = 'draft-hydration-local-edit';
    const load = deferred<{ model: string; draftInput: string }>();
    vi.stubGlobal('window', {
      electronAPI: {
        aiLoadSession: vi.fn().mockReturnValue(load.promise),
      },
    });

    const loadPromise = store.set(loadSessionDataAtom, { sessionId, workspacePath: '/workspace' });
    store.set(sessionDraftInputAtom(sessionId), 'typed locally');
    store.set(sessionDraftLocalModifiedAtAtom(sessionId), 123);

    load.resolve({ model: 'claude:test', draftInput: 'stale saved draft' });
    await loadPromise;

    expect(store.get(sessionDraftInputAtom(sessionId))).toBe('typed locally');
    expect(store.get(sessionDraftHydratedAtom(sessionId))).toBe(true);
  });
});
