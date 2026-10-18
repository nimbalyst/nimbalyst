import { afterEach, describe, expect, it, vi } from 'vitest';
import { store } from '@nimbalyst/runtime/store';
import {
  canPersistSessionDraft,
  loadSessionDataAtom,
  sessionDraftHydratedAtom,
  sessionDraftInputAtom,
  sessionDraftLocalModifiedAtAtom,
  sessionLoadErrorAtom,
  sessionLoadingAtom,
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

// #1812: a session whose load threw was shown as "Session not found", which
// users read as the session having been deleted or moved to another project.
describe('session load errors', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('records why a load failed and clears it when a retry succeeds', async () => {
    const sessionId = 'load-error-retry';
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('window', {
      electronAPI: {
        aiLoadSession: vi.fn()
          .mockRejectedValueOnce(new Error(
            "Error invoking remote method 'ai:loadSession': ResponseTooLargeError: Query result is too large to return (~256 MB, limit 256 MB).",
          ))
          .mockResolvedValueOnce({ model: 'claude:test' }),
      },
    });

    await store.set(loadSessionDataAtom, { sessionId, workspacePath: '/workspace' });
    expect(store.get(sessionLoadingAtom(sessionId))).toBe(false);
    expect(store.get(sessionLoadErrorAtom(sessionId))).toBe(
      'ResponseTooLargeError: Query result is too large to return (~256 MB, limit 256 MB).',
    );

    await store.set(loadSessionDataAtom, { sessionId, workspacePath: '/workspace' });
    expect(store.get(sessionLoadErrorAtom(sessionId))).toBeNull();
  });

  it('records no error when the session does not exist', async () => {
    const sessionId = 'load-error-missing';
    vi.stubGlobal('window', { electronAPI: { aiLoadSession: vi.fn().mockResolvedValue(null) } });

    await store.set(loadSessionDataAtom, { sessionId, workspacePath: '/workspace' });
    expect(store.get(sessionLoadingAtom(sessionId))).toBe(false);
    expect(store.get(sessionLoadErrorAtom(sessionId))).toBeNull();
  });
});
