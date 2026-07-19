import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DocumentModel } from '../DocumentModel';
import type { DocumentBackingStore, ExternalChangeCallback, DiffState } from '../types';

// -- Mock BackingStore -------------------------------------------------------

function createMockStore(initialContent = 'hello world'): {
  store: DocumentBackingStore & {
    triggerExternalChange: (content: string, timestamp?: number, checkPendingTags?: boolean) => void;
    dispose: () => void;
  };
  saved: (string | ArrayBuffer)[];
} {
  const saved: (string | ArrayBuffer)[] = [];
  const changeCallbacks = new Set<ExternalChangeCallback>();

  const store = {
    load: vi.fn(async () => initialContent),
    save: vi.fn(async (content: string | ArrayBuffer) => {
      saved.push(content);
    }),
    onExternalChange: vi.fn((cb: ExternalChangeCallback) => {
      changeCallbacks.add(cb);
      return () => { changeCallbacks.delete(cb); };
    }),
    triggerExternalChange: (content: string, timestamp = Date.now(), checkPendingTags?: boolean) => {
      for (const cb of changeCallbacks) {
        cb({ content, timestamp, checkPendingTags });
      }
    },
    dispose: vi.fn(),
  };

  return { store, saved };
}

// -- Tests -------------------------------------------------------------------

describe('DocumentModel', () => {
  let model: DocumentModel;
  let mockStore: ReturnType<typeof createMockStore>['store'];
  let saved: (string | ArrayBuffer)[];

  beforeEach(() => {
    vi.useFakeTimers();
    const mock = createMockStore();
    mockStore = mock.store;
    saved = mock.saved;
    model = new DocumentModel('/test/file.md', mockStore, {
      autosaveInterval: 2000,
      autosaveDebounce: 200,
      getPendingTags: async () => [],
      updateTagStatus: async () => {},
    });
  });

  afterEach(() => {
    model.dispose();
    vi.useRealTimers();
  });

  describe('loadContent', () => {
    it('loads from backing store and caches as lastPersistedContent', async () => {
      const content = await model.loadContent();
      expect(content).toBe('hello world');
      expect(model.getLastPersistedContent()).toBe('hello world');
    });
  });

  describe('attach/detach', () => {
    it('returns a handle on attach', () => {
      const handle = model.attach();
      expect(handle.id).toBeDefined();
      expect(model.getAttachCount()).toBe(1);
    });

    it('increments attach count for multiple editors', () => {
      const h1 = model.attach();
      const h2 = model.attach();
      expect(model.getAttachCount()).toBe(2);
      h1.detach();
      expect(model.getAttachCount()).toBe(1);
      h2.detach();
      expect(model.getAttachCount()).toBe(0);
    });
  });

  describe('dirty state', () => {
    it('is not dirty initially', () => {
      expect(model.isDirty()).toBe(false);
    });

    it('becomes dirty when an editor reports dirty', () => {
      const handle = model.attach();
      handle.setDirty(true);
      expect(model.isDirty()).toBe(true);
    });

    it('ORs dirty state across editors', () => {
      const h1 = model.attach();
      const h2 = model.attach();
      h1.setDirty(true);
      expect(model.isDirty()).toBe(true);
      h1.setDirty(false);
      expect(model.isDirty()).toBe(false);
      h2.setDirty(true);
      expect(model.isDirty()).toBe(true);
    });

    it('emits dirty-changed event', () => {
      const handle = model.attach();
      const listener = vi.fn();
      model.on('dirty-changed', listener);

      handle.setDirty(true);
      expect(listener).toHaveBeenCalledTimes(1);

      // Setting dirty again (already dirty) should NOT emit
      handle.setDirty(true);
      expect(listener).toHaveBeenCalledTimes(1);

      handle.setDirty(false);
      expect(listener).toHaveBeenCalledTimes(2);
    });

    it('clears dirty on detach and emits if aggregate changes', () => {
      const handle = model.attach();
      handle.setDirty(true);
      const listener = vi.fn();
      model.on('dirty-changed', listener);

      handle.detach();
      expect(model.isDirty()).toBe(false);
      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

  describe('saveContent', () => {
    it('saves through the backing store', async () => {
      await model.loadContent();
      const handle = model.attach();
      handle.setDirty(true);

      await handle.saveContent('updated content');

      expect(saved).toEqual(['updated content']);
      expect(model.getLastPersistedContent()).toBe('updated content');
    });

    it('clears the saving editors dirty flag', async () => {
      const handle = model.attach();
      handle.setDirty(true);
      expect(model.isDirty()).toBe(true);

      await handle.saveContent('new');
      expect(model.isDirty()).toBe(false);
    });

    it('notifies clean sibling editors on save, skips dirty ones', async () => {
      const h1 = model.attach();
      const h2 = model.attach();
      const h3 = model.attach();
      const h1FileChanged = vi.fn();
      const h2FileChanged = vi.fn();
      const h3FileChanged = vi.fn();
      h1.onFileChanged(h1FileChanged);
      h2.onFileChanged(h2FileChanged);
      h3.onFileChanged(h3FileChanged);

      // h3 is dirty (has unsaved edits)
      h3.setDirty(true);

      await h1.saveContent('from editor 1');

      // h1 (saver) should NOT be notified
      expect(h1FileChanged).not.toHaveBeenCalled();
      // h2 (clean sibling) SHOULD be notified
      expect(h2FileChanged).toHaveBeenCalledWith('from editor 1');
      // h3 (dirty sibling) should NOT be notified -- preserve its in-flight edits
      expect(h3FileChanged).not.toHaveBeenCalled();
    });

    it('emits content-saved event', async () => {
      const handle = model.attach();
      const listener = vi.fn();
      model.on('content-saved', listener);

      await handle.saveContent('saved!');
      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

  describe('external changes (file watcher)', () => {
    it('notifies all editors on external change', async () => {
      await model.loadContent();
      const h1 = model.attach();
      const h2 = model.attach();
      const h1Cb = vi.fn();
      const h2Cb = vi.fn();
      h1.onFileChanged(h1Cb);
      h2.onFileChanged(h2Cb);

      mockStore.triggerExternalChange('external edit');

      // Need to await the async handler
      await vi.waitFor(() => {
        expect(h1Cb).toHaveBeenCalledWith('external edit');
        expect(h2Cb).toHaveBeenCalledWith('external edit');
      });
    });

    it('suppresses echo when content matches lastPersistedContent', async () => {
      await model.loadContent(); // 'hello world'
      const handle = model.attach();
      const cb = vi.fn();
      handle.onFileChanged(cb);

      // Trigger change with same content -- should be suppressed
      mockStore.triggerExternalChange('hello world');

      // Give async handler time to run
      await vi.advanceTimersByTimeAsync(100);
      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe('autosave timer', () => {
    it('requests save from dirty editor after interval', async () => {
      const handle = model.attach();
      const saveRequested = vi.fn();
      handle.onSaveRequested(saveRequested);

      handle.setDirty(true);

      // Advance past debounce (200ms) and autosave interval (2000ms)
      await vi.advanceTimersByTimeAsync(2100);

      expect(saveRequested).toHaveBeenCalledTimes(1);
    });

    it('does not fire when not dirty', async () => {
      const handle = model.attach();
      const saveRequested = vi.fn();
      handle.onSaveRequested(saveRequested);

      await vi.advanceTimersByTimeAsync(5000);
      expect(saveRequested).not.toHaveBeenCalled();
    });

    it('fires during diff mode (editor callback decides whether to save)', async () => {
      // Create model with pending tags
      model.dispose();
      const mock2 = createMockStore();
      model = new DocumentModel('/test/file.md', mock2.store, {
        autosaveInterval: 2000,
        autosaveDebounce: 200,
        getPendingTags: async () => [{ id: 'tag1', sessionId: 'sess1' }],
        updateTagStatus: async () => {},
      });
      await model.loadContent();

      // Trigger external change to enter diff mode
      mock2.store.triggerExternalChange('ai edit');
      await vi.advanceTimersByTimeAsync(100);

      const handle = model.attach();
      const saveRequested = vi.fn();
      handle.onSaveRequested(saveRequested);
      handle.setDirty(true);

      // DocumentModel still fires onSaveRequested in diff mode.
      // The editor callback checks for remaining diff nodes and decides
      // whether to save or skip (e.g. clears resolved diffs).
      await vi.advanceTimersByTimeAsync(2100);
      expect(saveRequested).toHaveBeenCalledTimes(1);
    });

    it('respects debounce (skips if edit too recent)', async () => {
      const handle = model.attach();
      const saveRequested = vi.fn();
      handle.onSaveRequested(saveRequested);

      handle.setDirty(true);

      // Advance 1900ms (not past interval yet)
      await vi.advanceTimersByTimeAsync(1900);
      expect(saveRequested).not.toHaveBeenCalled();

      // Set dirty again (resets lastEditTime)
      handle.setDirty(true);

      // Advance to next interval tick
      await vi.advanceTimersByTimeAsync(200);
      // Should skip because lastEditTime is too recent (within 200ms debounce)
      expect(saveRequested).not.toHaveBeenCalled();

      // Now advance past debounce + next interval
      await vi.advanceTimersByTimeAsync(2000);
      expect(saveRequested).toHaveBeenCalledTimes(1);
    });
  });

  describe('diff mode', () => {
    let diffModel: DocumentModel;
    let diffStore: ReturnType<typeof createMockStore>['store'];

    beforeEach(async () => {
      const mock = createMockStore('original content');
      diffStore = mock.store;
      diffModel = new DocumentModel('/test/diff.md', diffStore, {
        autosaveInterval: 0, // Disable for diff tests
        getPendingTags: async () => [{ id: 'tag-1', sessionId: 'session-1', createdAt: '2026-01-01T00:00:00Z' }],
        updateTagStatus: vi.fn(async () => {}),
      });
      await diffModel.loadContent();
    });

    afterEach(() => {
      diffModel.dispose();
    });

    it('enters diff mode on external change with pending tags', async () => {
      const handle = diffModel.attach();
      const diffCb = vi.fn();
      handle.onDiffRequested(diffCb);

      diffStore.triggerExternalChange('ai modified content');

      await vi.waitFor(() => {
        expect(diffCb).toHaveBeenCalledTimes(1);
      });

      const diffState: DiffState = diffCb.mock.calls[0][0];
      expect(diffState.tagId).toBe('tag-1');
      expect(diffState.sessionId).toBe('session-1');
      expect(diffState.oldContent).toBe('original content');
      expect(diffState.newContent).toBe('ai modified content');
    });

    it('notifies all editors when entering diff mode', async () => {
      const h1 = diffModel.attach();
      const h2 = diffModel.attach();
      const cb1 = vi.fn();
      const cb2 = vi.fn();
      h1.onDiffRequested(cb1);
      h2.onDiffRequested(cb2);

      diffStore.triggerExternalChange('ai edit');

      await vi.waitFor(() => {
        expect(cb1).toHaveBeenCalledTimes(1);
        expect(cb2).toHaveBeenCalledTimes(1);
      });
    });

    it('immediately notifies late subscribers if already in diff mode', async () => {
      const h1 = diffModel.attach();
      const cb1 = vi.fn();
      h1.onDiffRequested(cb1);
      diffStore.triggerExternalChange('ai edit');

      await vi.waitFor(() => expect(cb1).toHaveBeenCalled());

      // Late subscriber
      const h2 = diffModel.attach();
      const cb2 = vi.fn();
      h2.onDiffRequested(cb2);
      expect(cb2).toHaveBeenCalledTimes(1);
    });

    it('resolves diff and notifies other editors', async () => {
      const h1 = diffModel.attach();
      const h2 = diffModel.attach();
      const diffCb1 = vi.fn();
      const diffCb2 = vi.fn();
      const resolvedCb2 = vi.fn();
      h1.onDiffRequested(diffCb1);
      h2.onDiffRequested(diffCb2);
      h2.onDiffResolved(resolvedCb2);

      diffStore.triggerExternalChange('ai edit');
      await vi.waitFor(() => expect(diffCb1).toHaveBeenCalled());

      // Editor 1 accepts the diff
      await h1.resolveDiff(true);

      expect(resolvedCb2).toHaveBeenCalledWith(true);
      expect(diffModel.getDiffState()).toBeNull();
    });

    it('clearDiffState fans out diffResolved to sibling attachments', async () => {
      // Reproduces the dual-attachment bug: when one tab dispatches the
      // Lexical CLEAR_DIFF_TAG_COMMAND flow (which calls clearDiffState
      // directly rather than resolveDiff), the *other* attachment must still
      // be told to exit diff mode. Without this fan-out, a Files-mode tab
      // stays stuck in diff mode after Agent-mode hits Approve All.
      const h1 = diffModel.attach();
      const h2 = diffModel.attach();
      const h3 = diffModel.attach();
      const diffCb1 = vi.fn();
      const resolvedCb1 = vi.fn();
      const resolvedCb2 = vi.fn();
      const resolvedCb3 = vi.fn();
      h1.onDiffRequested(diffCb1);
      h1.onDiffResolved(resolvedCb1);
      h2.onDiffResolved(resolvedCb2);
      h3.onDiffResolved(resolvedCb3);

      diffStore.triggerExternalChange('ai edit');
      await vi.waitFor(() => expect(diffCb1).toHaveBeenCalled());

      // Editor 1 cleans up via clearDiffState (mirrors the Lexical
      // CLEAR_DIFF_TAG_COMMAND path) and excludes itself from the fan-out.
      diffModel.clearDiffState(h1.id, true);

      expect(resolvedCb1).not.toHaveBeenCalled(); // self excluded
      expect(resolvedCb2).toHaveBeenCalledWith(true);
      expect(resolvedCb3).toHaveBeenCalledWith(true);
      expect(diffModel.getDiffState()).toBeNull();
    });

    it('skips empty-diff session when pre-edit tag fires before the agent has written', async () => {
      // Reproduces the bug where Claude's AgentToolHooks (and Codex's pre-edit
      // attribution) fires `history:pending-tag-created` BEFORE the actual disk
      // write completes. The renderer reads disk on that signal and sees the OLD
      // content. Without a guard, DocumentModel would create a DiffSession with
      // appliedContent === baselineContent and lock the editor into an empty
      // 'applying' phase, causing the real disk-write event that arrives a moment
      // later to be queued (never visibly applied) -- the editor stays frozen on
      // old content while disk has the new content.
      const baseline = 'original content'; // matches mock's initialContent
      const racingDiffModel = new DocumentModel('/test/race.md', diffStore, {
        autosaveInterval: 0,
        getPendingTags: async () => [{ id: 'tag-race', sessionId: 'sess-race', createdAt: '2026-01-01T00:00:00Z' }],
        updateTagStatus: vi.fn(async () => {}),
        getDiffBaseline: async () => ({ content: baseline }),
      });
      try {
        await racingDiffModel.loadContent();

        const handle = racingDiffModel.attach();
        const diffCb = vi.fn();
        handle.onDiffRequested(diffCb);

        // Step 1: pre-edit tag fires; renderer reads disk; agent has not written yet.
        diffStore.triggerExternalChange(baseline, Date.now(), true);
        await vi.advanceTimersByTimeAsync(10);
        // Race guard: no DiffSession should be created, no diff should be requested.
        expect(diffCb).not.toHaveBeenCalled();
        expect(racingDiffModel.getDiffSessionSnapshot()).toBeNull();

        // Step 2: real disk-write event arrives with the actual new content.
        diffStore.triggerExternalChange('ai modified content', Date.now() + 100, false);
        await vi.waitFor(() => expect(diffCb).toHaveBeenCalledTimes(1));

        const diffState: DiffState = diffCb.mock.calls[0][0];
        expect(diffState.tagId).toBe('tag-race');
        expect(diffState.oldContent).toBe(baseline);
        expect(diffState.newContent).toBe('ai modified content');
      } finally {
        racingDiffModel.dispose();
      }
    });

    it('clearDiffState propagates rejection to siblings', async () => {
      const h1 = diffModel.attach();
      const h2 = diffModel.attach();
      const diffCb1 = vi.fn();
      const resolvedCb2 = vi.fn();
      h1.onDiffRequested(diffCb1);
      h2.onDiffResolved(resolvedCb2);

      diffStore.triggerExternalChange('ai edit');
      await vi.waitFor(() => expect(diffCb1).toHaveBeenCalled());

      diffModel.clearDiffState(h1.id, false);

      expect(resolvedCb2).toHaveBeenCalledWith(false);
    });

    it('does not fire onDiffRequested for a duplicate payload after markDiffApplied', async () => {
      const handle = diffModel.attach();
      const diffCb = vi.fn();
      handle.onDiffRequested(diffCb);

      diffStore.triggerExternalChange('ai edit');
      await vi.waitFor(() => expect(diffCb).toHaveBeenCalledTimes(1));

      // Editor reports its apply finished.
      handle.markDiffApplied();

      // Same disk content arrives again (e.g. the second of the dual-IPC events). Should be
      // recognized as duplicate by the session and NOT trigger another applyDiffState.
      diffStore.triggerExternalChange('ai edit');
      await vi.advanceTimersByTimeAsync(50);
      expect(diffCb).toHaveBeenCalledTimes(1);
    });

    it('queues a payload that arrives during apply and drains via markDiffApplied', async () => {
      const handle = diffModel.attach();
      const diffCb = vi.fn();
      handle.onDiffRequested(diffCb);

      // First edit -- enters 'applying'.
      diffStore.triggerExternalChange('first ai edit');
      await vi.waitFor(() => expect(diffCb).toHaveBeenCalledTimes(1));
      expect(diffCb.mock.calls[0][0].newContent).toBe('first ai edit');

      // Second edit lands BEFORE the editor reports apply done. DocumentModel should queue
      // it inside the session rather than firing onDiffRequested again.
      diffStore.triggerExternalChange('second ai edit');
      await vi.advanceTimersByTimeAsync(50);
      expect(diffCb).toHaveBeenCalledTimes(1);
      // The session has the queued payload visible via the snapshot.
      expect(diffModel.getDiffSessionSnapshot()?.pendingContent).toBe('second ai edit');

      // Editor finishes the first apply and tells the model.
      handle.markDiffApplied();
      // Drain should fire onDiffRequested with the second payload.
      expect(diffCb).toHaveBeenCalledTimes(2);
      expect(diffCb.mock.calls[1][0].newContent).toBe('second ai edit');
      expect(diffModel.getDiffSessionSnapshot()?.pendingContent).toBeNull();
      expect(diffModel.getDiffSessionSnapshot()?.phase).toBe('applying');
    });

    it('completePartialResolve rotates tag and re-baselines the session', async () => {
      const handle = diffModel.attach();
      const diffCb = vi.fn();
      handle.onDiffRequested(diffCb);

      diffStore.triggerExternalChange('ai edit');
      await vi.waitFor(() => expect(diffCb).toHaveBeenCalledTimes(1));
      handle.markDiffApplied();

      handle.completePartialResolve({
        newTagId: 'tag-2',
        newBaseline: 'partial-accepted-baseline',
      });

      const snap = diffModel.getDiffSessionSnapshot();
      expect(snap?.tagId).toBe('tag-2');
      expect(snap?.baselineContent).toBe('partial-accepted-baseline');
      // appliedContent unchanged -- the un-resolved groups stay on screen.
      expect(snap?.appliedContent).toBe('ai edit');
      expect(snap?.phase).toBe('applied');
      // diffState mirrors the rotation.
      expect(diffModel.getDiffState()?.tagId).toBe('tag-2');
      expect(diffModel.getDiffState()?.oldContent).toBe('partial-accepted-baseline');
    });

    it('emits diff-state-changed event on enter and exit', async () => {
      const listener = vi.fn();
      diffModel.on('diff-state-changed', listener);

      const handle = diffModel.attach();
      handle.onDiffRequested(vi.fn());
      diffStore.triggerExternalChange('ai edit');

      await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1));

      await handle.resolveDiff(false);
      expect(listener).toHaveBeenCalledTimes(2);
    });
  });

  describe('flushDirtyEditors', () => {
    it('requests save from all dirty editors', async () => {
      const h1 = model.attach();
      const h2 = model.attach();
      const save1 = vi.fn();
      const save2 = vi.fn();
      h1.onSaveRequested(save1);
      h2.onSaveRequested(save2);

      h1.setDirty(true);
      // h2 not dirty

      await model.flushDirtyEditors();

      expect(save1).toHaveBeenCalledTimes(1);
      expect(save2).not.toHaveBeenCalled();
    });

    it('waits for an asynchronous editor save to finish', async () => {
      const handle = model.attach();
      let finishSave: (() => void) | undefined;
      const save = vi.fn(() => new Promise<void>((resolve) => {
        finishSave = resolve;
      }));
      handle.onSaveRequested(save);
      handle.setDirty(true);
      let flushFinished = false;

      const flush = model.flushDirtyEditors().then(() => {
        flushFinished = true;
      });
      await Promise.resolve();
      expect(flushFinished).toBe(false);

      finishSave?.();
      await flush;
      expect(flushFinished).toBe(true);
    });
  });

  describe('getState', () => {
    it('returns a complete state snapshot', () => {
      const handle = model.attach();
      handle.setDirty(true);

      const state = model.getState();
      expect(state).toEqual({
        filePath: '/test/file.md',
        isDirty: true,
        diffState: null,
        attachCount: 1,
      });
    });
  });

  describe('dispose', () => {
    it('clears all attachments and stops timers', () => {
      const h1 = model.attach();
      const h2 = model.attach();
      model.dispose();

      expect(model.getAttachCount()).toBe(0);
    });

    it('disposes the backing store', () => {
      model.dispose();
      expect(mockStore.dispose).toHaveBeenCalled();
    });
  });
});
