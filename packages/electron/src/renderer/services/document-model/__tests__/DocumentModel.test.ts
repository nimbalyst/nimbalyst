// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DocumentModel } from '../DocumentModel';
import type {
  DocumentBackingStore,
  DocumentModelEditorHandle,
  ExternalChangeCallback,
  DiffState,
} from '../types';

// -- Mock BackingStore -------------------------------------------------------

function createMockStore(initialContent = 'hello world'): {
  store: DocumentBackingStore & {
    triggerExternalChange: (content: string, timestamp?: number, checkPendingTags?: boolean) => void;
    dispose: () => void;
  };
  saved: (string | ArrayBuffer)[];
  baselines: (string | undefined)[];
} {
  const saved: (string | ArrayBuffer)[] = [];
  const baselines: (string | undefined)[] = [];
  const changeCallbacks = new Set<ExternalChangeCallback>();

  const store = {
    load: vi.fn(async () => initialContent),
    save: vi.fn(async (content: string | ArrayBuffer, expectedDiskContent?: string) => {
      saved.push(content);
      baselines.push(expectedDiskContent);
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

  return { store, saved, baselines };
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

  it('retains the verified baseline after repeated rejected saves (#1499)', async () => {
    await model.loadContent();
    const handle = model.attach();
    handle.setDirty(true);
    vi.mocked(mockStore.save).mockRejectedValue(new Error('verification failed'));
    await expect(handle.saveContent('unsaved edit')).rejects.toThrow('verification failed');
    await expect(handle.saveContent('unsaved edit')).rejects.toThrow('verification failed');
    expect(vi.mocked(mockStore.save).mock.calls.map(call => call[1])).toEqual(['hello world', 'hello world']);
    expect(model.getLastPersistedContent()).toBe('hello world');
    expect(model.isDirty()).toBe(true);
  });

  it('retains the baseline when an editor explicitly rejects an unverified reload', async () => {
    await model.loadContent();
    model.attach().onFileChanged(() => false);
    mockStore.triggerExternalChange('unapplied disk bytes');
    await vi.advanceTimersByTimeAsync(0);
    expect(model.getLastPersistedContent()).toBe('hello world');
  });

  it.each(['delete', 'rename'])('does not apply a history lookup started before %s', async (action) => {
    model.dispose();
    let finish!: (tags: []) => void;
    model = new DocumentModel('/test/file.md', mockStore, {
      autosaveInterval: 0,
      getPendingTags: () => new Promise<[]>(resolve => { finish = resolve; }),
    });
    model.setLastPersistedContent('hello world');
    const changed = vi.fn();
    model.attach().onFileChanged(changed);
    mockStore.triggerExternalChange('read before deletion');
    if (action === 'delete') model.markDeleted();
    else model.migrateToNewPath('/test/renamed.md', createMockStore('renamed bytes').store);
    finish([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(changed).not.toHaveBeenCalled();
    expect(model.isDeleted()).toBe(action === 'delete');
    expect(model.getLastPersistedContent()).toBe(action === 'delete' ? null : 'hello world');
  });

  it('reports an external conflict immediately without discarding a dirty buffer (#1499)', async () => {
    await model.loadContent();
    const handle = model.attach();
    const changed = vi.fn();
    handle.onFileChanged(changed);
    handle.setDirty(true);
    const conflict = vi.fn();
    model.on('external-conflict', conflict);
    mockStore.triggerExternalChange('external edit');
    await vi.advanceTimersByTimeAsync(100);
    expect(changed).not.toHaveBeenCalled();
    expect(conflict).toHaveBeenCalledWith(expect.objectContaining({ diskContent: 'external edit' }));
    expect(model.getLastPersistedContent()).toBe('hello world');
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

    /**
     * #3684. NIM-905 named this exact hazard in a HiddenTabManager comment --
     * "the file watcher may advance [the shared baseline] to an agent's
     * out-of-band write and thereby mask a divergence" -- and worked around it
     * with a private baseline for hidden editors. Every visible tab stayed on
     * the masked one, so a dirty tab's next save sailed through the conflict
     * check and reverted the agent.
     */
    it('holds the conflict baseline when an external change reaches no editor', async () => {
      await model.loadContent(); // 'hello world'
      const handle = model.attach();
      const cb = vi.fn();
      handle.onFileChanged(cb);
      handle.setDirty(true); // dirty editors are skipped, to protect their edits

      mockStore.triggerExternalChange('written by an agent');
      await vi.advanceTimersByTimeAsync(100);

      expect(cb).not.toHaveBeenCalled();
      // The editor never saw the agent's write, so the baseline must not claim it.
      expect(model.getLastPersistedContent()).toBe('hello world');
    });

    it('sends the pre-write baseline to the store so it can refuse a clobber', async () => {
      const mock = createMockStore('hello world');
      const m = new DocumentModel('/test/baseline.md', mock.store, {
        autosaveInterval: 0,
        getPendingTags: async () => [],
      });
      try {
        await m.loadContent();
        const handle = m.attach();
        handle.setDirty(true);

        mock.store.triggerExternalChange('written by an agent');
        await vi.advanceTimersByTimeAsync(100);

        await handle.saveContent('what the stale editor holds');

        // Not 'written by an agent': the store is told what this editor last
        // agreed with, so the main-process conflict check can trip.
        expect(mock.baselines).toEqual(['hello world']);
      } finally {
        m.dispose();
      }
    });

    it('still suppresses the echo of content no editor took', async () => {
      // The baseline split must not cost us echo suppression: disk-seen and
      // editors-in-sync are now separate facts, and echo keys off the former.
      await model.loadContent();
      const handle = model.attach();
      const cb = vi.fn();
      handle.onFileChanged(cb);
      handle.setDirty(true);

      mockStore.triggerExternalChange('written by an agent');
      await vi.advanceTimersByTimeAsync(100);

      handle.setDirty(false);
      mockStore.triggerExternalChange('written by an agent'); // same bytes again
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

    it('bounds retries when a persistent autosave request keeps failing', async () => {
      const handle = model.attach();
      const saveError = Object.assign(new Error('write failed'), { code: 'EACCES' });
      const saveRequested = vi.fn(async () => {
        throw saveError;
      });
      handle.onSaveRequested(saveRequested);
      handle.setDirty(true);

      // A permanently unwritable file must not be retried every two seconds.
      // The autosave policy allows a small bounded retry sequence, then waits
      // for an explicit/manual save or a new clean -> dirty edit cycle.
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

      expect(saveRequested).toHaveBeenCalledTimes(3);

      // A successful manual save clears dirty state and rearms autosave for
      // later edits instead of permanently disabling it for this document.
      handle.setDirty(false);
      handle.setDirty(true);
      await vi.advanceTimersByTimeAsync(2100);

      expect(saveRequested).toHaveBeenCalledTimes(4);
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

// -- NIM-5359: ordered, recoverable, single-path diff lifecycle ---------------
//
// An agent writing to a file that is already in diff mode is the common case:
// it edits a plan five times in a turn while the user has the diff open. The
// tests below describe the contract that makes that safe. They are written
// against a harness that can stall a tag/baseline lookup mid-flight, hand out
// several attachments, and fail either half of a resolution -- the four things
// the real system does routinely and the state machine currently assumes away.

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: unknown) => void;
}

function createDeferred(): Deferred {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res as () => void;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface LifecycleHarness {
  model: DocumentModel;
  /**
   * Deliver a disk-change event the way the file watcher does: fire and forget.
   * `sequence` mirrors `DiskBackedStore`, which stamps every signal from its own
   * counter starting at 1 -- pass it when the test cares about the model's
   * ordering watermark rather than just content.
   */
  emit(content: string, opts?: { checkPendingTags?: boolean; sequence?: number }): void;
  /** Hold the Nth (0-based) pending-tag lookup open until the returned gate is released. */
  gateTagLookup(callIndex: number): Deferred;
  /** Hold the Nth (0-based) diff-baseline lookup open. */
  gateBaselineLookup(callIndex: number): Deferred;
  failNextSave(err: unknown): void;
  failNextTagUpdate(err: unknown): void;
  failNextLoad(err: unknown): void;
  /** Switch which tag the pending-tag lookup reports from here on. */
  setTag(tag: { id: string; sessionId: string; createdAt?: string }): void;
  /** Contents written to the backing store, in order. */
  saved: string[];
  /** Conflict baselines the model handed the store for each write. */
  saveBaselines: (string | undefined)[];
  tagUpdates: Array<{ tagId: string; status: string }>;
  /** Errors the model let escape its own callback, as an unhandled rejection would. */
  escapedErrors: unknown[];
  loadCalls(): number;
  disk(): string;
  attachPresenter(): { handle: DocumentModelEditorHandle; diffCb: ReturnType<typeof vi.fn> };
  dispose(): void;
}

function createLifecycleHarness(init: {
  baseline?: string;
  /** What disk already holds. Defaults to the baseline (no pending agent write). */
  diskContent?: string;
  /**
   * What the model is seeded with, mimicking TabEditor's synchronous
   * `setLastPersistedContent(initialContent)`. `null` leaves the model
   * un-seeded, which is the state hydration has to work from.
   */
  seedPersistedContent?: string | null;
  tag?: { id: string; sessionId: string; createdAt?: string };
  watchdogMs?: number;
} = {}): LifecycleHarness {
  const baseline = init.baseline ?? 'C0';
  let tag = init.tag ?? { id: 'tag-1', sessionId: 'sess-1', createdAt: '2026-09-01T00:00:00Z' };

  let disk = init.diskContent ?? baseline;
  let loadCalls = 0;
  let tagLookupCalls = 0;
  let baselineLookupCalls = 0;
  let nextSaveError: unknown = null;
  let nextTagUpdateError: unknown = null;
  let nextLoadError: unknown = null;

  const saved: string[] = [];
  const saveBaselines: (string | undefined)[] = [];
  const tagUpdates: Array<{ tagId: string; status: string }> = [];
  const escapedErrors: unknown[] = [];
  const changeCallbacks = new Set<ExternalChangeCallback>();
  const tagGates = new Map<number, Deferred>();
  const baselineGates = new Map<number, Deferred>();

  const store: DocumentBackingStore = {
    load: async () => {
      loadCalls++;
      if (nextLoadError) {
        const err = nextLoadError;
        nextLoadError = null;
        throw err;
      }
      return disk;
    },
    save: async (content, expectedDiskContent) => {
      if (nextSaveError) {
        const err = nextSaveError;
        nextSaveError = null;
        throw err;
      }
      saved.push(content as string);
      saveBaselines.push(expectedDiskContent);
      disk = content as string;
    },
    onExternalChange: (cb) => {
      changeCallbacks.add(cb);
      return () => {
        changeCallbacks.delete(cb);
      };
    },
    dispose: () => {},
  };

  const model = new DocumentModel('/test/lifecycle.md', store, {
    autosaveInterval: 0,
    diffApplyWatchdogMs: init.watchdogMs ?? 1000,
    getPendingTags: async () => {
      const gate = tagGates.get(tagLookupCalls++);
      if (gate) await gate.promise;
      return [tag];
    },
    getDiffBaseline: async () => {
      const gate = baselineGates.get(baselineLookupCalls++);
      if (gate) await gate.promise;
      return { content: baseline };
    },
    updateTagStatus: async (_filePath, tagId, status) => {
      if (nextTagUpdateError) {
        const err = nextTagUpdateError;
        nextTagUpdateError = null;
        throw err;
      }
      tagUpdates.push({ tagId, status });
    },
  });

  // What TabEditor does today: seed the model from the bytes it already loaded.
  if (init.seedPersistedContent !== null) {
    model.setLastPersistedContent(init.seedPersistedContent ?? baseline);
  }

  return {
    model,
    emit(content, opts) {
      disk = content;
      for (const cb of changeCallbacks) {
        let result: unknown;
        try {
          result = cb({
            content,
            timestamp: Date.now(),
            checkPendingTags: opts?.checkPendingTags,
            sequence: opts?.sequence,
          });
        } catch (err) {
          escapedErrors.push(err);
          continue;
        }
        // DiskBackedStore invokes the model callback without awaiting it, so an
        // async failure inside the model escapes as an unhandled rejection.
        if (result instanceof Promise) {
          result.catch((err) => escapedErrors.push(err));
        }
      }
    },
    gateTagLookup(callIndex) {
      const gate = createDeferred();
      tagGates.set(callIndex, gate);
      return gate;
    },
    gateBaselineLookup(callIndex) {
      const gate = createDeferred();
      baselineGates.set(callIndex, gate);
      return gate;
    },
    failNextSave(err) {
      nextSaveError = err;
    },
    failNextTagUpdate(err) {
      nextTagUpdateError = err;
    },
    failNextLoad(err) {
      nextLoadError = err;
    },
    setTag(next) {
      tag = next;
    },
    saved,
    saveBaselines,
    tagUpdates,
    escapedErrors,
    loadCalls: () => loadCalls,
    disk: () => disk,
    attachPresenter() {
      const handle = model.attach();
      const diffCb = vi.fn();
      handle.onDiffRequested(diffCb);
      return { handle, diffCb };
    },
    dispose() {
      model.dispose();
    },
  };
}

/** Let queued microtasks and any 0/1ms timers run. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(1);
}

function contentsOf(cb: ReturnType<typeof vi.fn>): string[] {
  return cb.mock.calls.map((call) => (call[0] as DiffState).newContent);
}

function generationOf(cb: ReturnType<typeof vi.fn>, index: number): number {
  return (cb.mock.calls[index][0] as DiffState).generation;
}

function lastGeneration(cb: ReturnType<typeof vi.fn>): number {
  return generationOf(cb, cb.mock.calls.length - 1);
}

describe('DocumentModel diff lifecycle (NIM-5359)', () => {
  let harness: LifecycleHarness;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    harness?.dispose();
    vi.useRealTimers();
  });

  // -- 1b. Reordered external changes (defect E) -----------------------------

  describe('ordering of external changes', () => {
    /**
     * Every watcher event starts its own un-awaited async handler, and the
     * handler awaits a tag lookup and a baseline lookup before it touches the
     * session. If C1's lookup stalls while C2's returns, C2 enters the session
     * first and C1 arrives afterwards holding older bytes -- which the queue
     * happily accepts as "the newest payload". The next drain then moves the
     * visible diff backwards onto content disk no longer has.
     */
    it('never lets a stalled older change replace or queue behind a newer one', async () => {
      harness = createLifecycleHarness();
      const gate = harness.gateTagLookup(0);
      const { diffCb } = harness.attachPresenter();

      harness.emit('C1');
      await settle();
      expect(diffCb).not.toHaveBeenCalled();

      harness.emit('C2');
      await settle();
      expect(contentsOf(diffCb)).toEqual(['C2']);

      gate.resolve();
      await settle();

      expect(contentsOf(diffCb)).toEqual(['C2']);
      const snapshot = harness.model.getDiffSessionSnapshot()!;
      expect(snapshot.appliedContent).toBe('C2');
      // C1 is older than what the session already presents. Queuing it means the
      // next drain shows the user content that is not on disk.
      expect(snapshot.pendingContent).toBeNull();
    });

    /**
     * The same reordering through the other awaited lookup: baseline resolution
     * is a second, independent stall point.
     */
    it('orders changes even when the baseline lookup is the slow half', async () => {
      harness = createLifecycleHarness();
      const gate = harness.gateBaselineLookup(0);
      const { diffCb } = harness.attachPresenter();

      harness.emit('C1');
      await settle();
      harness.emit('C2');
      await settle();
      gate.resolve();
      await settle();

      expect(contentsOf(diffCb)).toEqual(['C2']);
      expect(harness.model.getDiffSessionSnapshot()!.appliedContent).toBe('C2');
      expect(harness.model.getDiffSessionSnapshot()!.pendingContent).toBeNull();
    });

    /**
     * A serial executor built as `previous.then(next)` stops forever the first
     * time an operation rejects. A failed tag lookup is an ordinary transient
     * (the history DB is busy), so the queue must survive it -- and the failure
     * must be contained by the model rather than escaping the un-awaited
     * callback as an unhandled rejection.
     */
    it('keeps processing later events after one operation rejects', async () => {
      harness = createLifecycleHarness();
      harness.gateTagLookup(0).reject(new Error('history db busy'));
      const { handle, diffCb } = harness.attachPresenter();

      harness.emit('C1');
      await settle();
      expect(diffCb).not.toHaveBeenCalled();
      expect(harness.escapedErrors).toEqual([]);

      harness.emit('C2');
      await settle();
      expect(contentsOf(diffCb)).toEqual(['C2']);

      // A rejection from *inside* a queued operation. The lookup failure above
      // rejects before anything reaches the queue, so on its own it would pass
      // against a queue that wedges on the first rejected task; the resolution
      // write is a task that genuinely runs there and can be refused.
      handle.completeDiffApply({ generation: lastGeneration(diffCb), outcome: 'applied' });
      await settle();
      harness.failNextSave(new Error('conflict: disk changed'));
      await expect(handle.resolveDiff(true)).rejects.toThrow();
      await settle();

      // The refused write recovered the current disk bytes under a new
      // generation; acknowledge it, then prove the queue still moves.
      handle.completeDiffApply({ generation: lastGeneration(diffCb), outcome: 'applied' });
      await settle();
      harness.emit('C3');
      await settle();
      expect(contentsOf(diffCb).at(-1)).toBe('C3');
    });

    /**
     * A baseline lookup that *fails* is not the same fact as "no baseline
     * recorded". Substituting the editor's own bytes builds a session whose old
     * side is the agent's write: the user sees C1->C2 instead of C0->C2, and
     * rejecting restores C1 -- the agent's edit -- rather than the pre-edit
     * content. Nothing ever asks again, so the wrong baseline is permanent
     * (NIM-5359, defect I).
     */
    it('never manufactures a diff baseline from editor state when the lookup fails', async () => {
      harness = createLifecycleHarness({
        baseline: 'C0',
        diskContent: 'C1',
        // What a reopened tab seeds the model with: the agent's content.
        seedPersistedContent: 'C1',
      });
      harness.gateBaselineLookup(0).reject(new Error('history db busy'));
      const { diffCb } = harness.attachPresenter();

      harness.emit('C2');
      await settle();
      expect(diffCb).not.toHaveBeenCalled();
      expect(harness.escapedErrors).toEqual([]);

      // The bounded retry re-reads disk rather than replaying the stale payload.
      await vi.advanceTimersByTimeAsync(600);
      expect(contentsOf(diffCb)).toEqual(['C2']);
      expect((diffCb.mock.calls[0][0] as DiffState).oldContent).toBe('C0');
      expect(harness.model.getDiffSessionSnapshot()!.baselineContent).toBe('C0');
    });
  });

  // -- 1c. Generation-scoped acknowledgement (defect F) ----------------------

  describe('generation-scoped apply completion', () => {
    /**
     * One DocumentModel is shared by Files mode, Agent mode and hidden editors.
     * With A and B both presenting C1, A finishing first must not settle the
     * generation on B's behalf: B is still mid-replay, and draining now starts
     * C2 on top of a render that has not finished.
     */
    it('holds a generation until every recipient has completed it', async () => {
      harness = createLifecycleHarness();
      const a = harness.attachPresenter();
      const b = harness.attachPresenter();

      harness.emit('C1');
      await settle();
      expect(contentsOf(a.diffCb)).toEqual(['C1']);
      expect(contentsOf(b.diffCb)).toEqual(['C1']);
      const g1 = lastGeneration(a.diffCb);
      expect(lastGeneration(b.diffCb)).toBe(g1);

      harness.emit('C2');
      await settle();
      expect(contentsOf(a.diffCb)).toEqual(['C1']);

      a.handle.completeDiffApply({ generation: g1, outcome: 'applied' });
      await settle();

      // B still owes an outcome for C1, so C2 stays queued.
      expect(contentsOf(a.diffCb)).toEqual(['C1']);
      expect(contentsOf(b.diffCb)).toEqual(['C1']);
      expect(harness.model.getPendingDiffRecipients()).toContain(b.handle.id);

      b.handle.completeDiffApply({ generation: g1, outcome: 'applied' });
      await settle();

      expect(contentsOf(a.diffCb)).toEqual(['C1', 'C2']);
      expect(contentsOf(b.diffCb)).toEqual(['C1', 'C2']);
    });

    /**
     * The parameterless acknowledgement carries no identity, so a late
     * completion for C1 lands on whatever the model currently has in flight.
     * That is how C3 gets published on top of a C2 render nobody finished.
     */
    it('ignores a completion that names a superseded generation', async () => {
      harness = createLifecycleHarness();
      const a = harness.attachPresenter();
      const b = harness.attachPresenter();

      harness.emit('C1');
      await settle();
      const g1 = lastGeneration(a.diffCb);
      a.handle.completeDiffApply({ generation: g1, outcome: 'applied' });
      b.handle.completeDiffApply({ generation: g1, outcome: 'applied' });
      await settle();

      harness.emit('C2');
      await settle();
      expect(contentsOf(a.diffCb)).toEqual(['C1', 'C2']);

      harness.emit('C3');
      await settle();

      // B's duplicate, late acknowledgement of C1 arrives while C2 is still
      // rendering. It must not settle C2 and release C3.
      b.handle.completeDiffApply({ generation: g1, outcome: 'applied' });
      await settle();

      expect(contentsOf(a.diffCb)).toEqual(['C1', 'C2']);
      expect(contentsOf(b.diffCb)).toEqual(['C1', 'C2']);
    });
  });

  // -- 1d. Missing and failed acknowledgements (defect G) --------------------

  describe('failed, detached and missing apply completions', () => {
    /**
     * `applyDiffState` catches its own errors and acknowledges success in
     * `finally`. A failed apply that reports success advances the model past a
     * generation no editor is showing; the honest outcome is to recover it by
     * re-reading disk and re-publishing, with the tag still pending.
     */
    it('recovers a failed apply from disk instead of marking it applied', async () => {
      harness = createLifecycleHarness();
      const a = harness.attachPresenter();

      harness.emit('C1');
      await settle();
      const g1 = lastGeneration(a.diffCb);

      a.handle.completeDiffApply({ generation: g1, outcome: 'failed' });
      await settle();

      expect(harness.loadCalls()).toBeGreaterThan(0);
      expect(harness.tagUpdates).toEqual([]);
      expect(contentsOf(a.diffCb)).toEqual(['C1', 'C1']);
      expect(lastGeneration(a.diffCb)).toBeGreaterThan(g1);
    });

    /**
     * A detached attachment stops being a recipient; its handle must not be able
     * to acknowledge anything, least of all a generation published after it left.
     */
    it('does not let a detached attachment acknowledge a later generation', async () => {
      harness = createLifecycleHarness();
      const a = harness.attachPresenter();
      const b = harness.attachPresenter();

      harness.emit('C1');
      await settle();
      const g1 = lastGeneration(a.diffCb);

      b.handle.detach();
      a.handle.completeDiffApply({ generation: g1, outcome: 'applied' });
      await settle();

      harness.emit('C2');
      await settle();
      expect(contentsOf(a.diffCb)).toEqual(['C1', 'C2']);

      harness.emit('C3');
      await settle();

      b.handle.completeDiffApply({ generation: g1, outcome: 'applied' });
      await settle();

      expect(contentsOf(a.diffCb)).toEqual(['C1', 'C2']);
    });

    /**
     * Entering source mode unsubscribes the diff callback without detaching the
     * attachment -- the tab is still there, it just cannot present. Only
     * `detach` used to release the generation, so the model went on waiting for
     * an outcome from an editor showing raw text, and every queued agent write
     * sat behind it until the watchdog fired (NIM-5359 Phase 6).
     */
    it('releases the generation when a presenter unsubscribes without detaching', async () => {
      harness = createLifecycleHarness({ watchdogMs: 0 });
      const a = harness.attachPresenter();
      const bHandle = harness.model.attach();
      const bDiffCb = vi.fn();
      const unsubscribeB = bHandle.onDiffRequested(bDiffCb);

      harness.emit('C1');
      await settle();
      const g1 = lastGeneration(a.diffCb);
      expect(contentsOf(bDiffCb)).toEqual(['C1']);

      harness.emit('C2');
      await settle();

      unsubscribeB();
      a.handle.completeDiffApply({ generation: g1, outcome: 'applied' });
      await settle();

      // C2 drained to the one presenter left; the unsubscribed attachment is
      // neither waited on nor delivered to.
      expect(contentsOf(a.diffCb)).toEqual(['C1', 'C2']);
      expect(contentsOf(bDiffCb)).toEqual(['C1']);
      expect(harness.model.getPendingDiffRecipients()).not.toContain(bHandle.id);
    });

    /**
     * A presenter that unmounts, hangs, or silently skips leaves the session in
     * `applying` forever -- every subsequent agent write queues and the queue
     * never drains. The watchdog is failure recovery, not ordering: it re-reads
     * disk, keeps the tag pending, and re-publishes the latest content.
     */
    it('recovers a generation nobody ever acknowledges', async () => {
      harness = createLifecycleHarness({ watchdogMs: 1000 });
      const a = harness.attachPresenter();

      harness.emit('C1');
      await settle();
      expect(contentsOf(a.diffCb)).toEqual(['C1']);

      harness.emit('C2');
      await vi.advanceTimersByTimeAsync(2000);

      expect(harness.loadCalls()).toBeGreaterThan(0);
      expect(harness.tagUpdates).toEqual([]);
      expect(contentsOf(a.diffCb).at(-1)).toBe('C2');
    });

    /**
     * The recovery budget bounds how many times the model re-reads disk for a
     * presenter that never acknowledges anything. Spending the last one on a
     * generation it then declines to watch is the worst of both: the session sits
     * in `applying` with a recipient that owes an outcome forever, so every later
     * write queues behind it and no decision can ever be written. When the budget
     * is gone the generation has to park (NIM-5359, finding 6).
     */
    it('parks rather than publishing a generation it will not watch', async () => {
      harness = createLifecycleHarness({ watchdogMs: 1000 });
      // A presenter that receives every generation and acknowledges none.
      harness.attachPresenter();

      harness.emit('C1');
      await settle();

      await vi.advanceTimersByTimeAsync(10_000);

      expect(harness.model.getDiffSessionSnapshot()!.phase).toBe('awaiting-presenter');
      expect(harness.model.getPendingDiffRecipients()).toEqual([]);
      // The edit is still unreviewed -- parking is not resolution.
      expect(harness.tagUpdates).toEqual([]);
    });

    /**
     * Recovery re-reads disk, and that read can fail. Returning from there left
     * the session parked but any decision waiting on the dead generation unsettled
     * forever -- the user's click on Approve simply never returns.
     */
    it('settles a parked decision when the recovery read fails', async () => {
      harness = createLifecycleHarness({ watchdogMs: 1000 });
      const a = harness.attachPresenter();

      harness.emit('C1');
      await settle();
      a.handle.completeDiffApply({ generation: lastGeneration(a.diffCb), outcome: 'applied' });
      await settle();

      // A newer generation nobody acknowledges, with a third write queued behind
      // it -- content the user has not seen, so the decision parks rather than
      // superseding the presentation.
      harness.emit('C2');
      await settle();
      harness.emit('C3');
      await settle();
      let settled: 'pending' | 'resolved' | 'rejected' = 'pending';
      const decision = a.handle.resolveDiff(true).then(
        () => { settled = 'resolved'; },
        () => { settled = 'rejected'; },
      );
      await settle();
      expect(settled).toBe('pending');

      harness.failNextLoad(new Error('EIO'));
      await vi.advanceTimersByTimeAsync(2000);
      await decision;

      expect(settled).not.toBe('pending');
    });

    /**
     * With no capable presenter (source mode, a custom editor whose diff
     * callback has not registered), a generation has nobody to acknowledge it.
     * It must absorb newer disk content as its target rather than build a queue
     * that can only drain through an acknowledgement that will never come -- and
     * the presenter that shows up later gets the latest content, not the first.
     */
    it('absorbs newer content while awaiting a presenter and replays the latest to a late one', async () => {
      harness = createLifecycleHarness();
      // Attached, but never subscribes to diff requests -- not a presenter.
      harness.model.attach();

      harness.emit('C1');
      await settle();
      harness.emit('C2');
      await settle();

      const snapshot = harness.model.getDiffSessionSnapshot()!;
      expect(snapshot.phase).toBe('awaiting-presenter');
      expect(snapshot.appliedContent).toBe('C2');
      expect(snapshot.pendingContent).toBeNull();

      const late = harness.attachPresenter();
      expect(contentsOf(late.diffCb)).toEqual(['C2']);
    });
  });

  // -- 1e. Hydration from production bytes (defect H) ------------------------

  describe('ensureInitialized', () => {
    /**
     * Reopening a file whose agent write is still under review. The editor has
     * already read disk, so hydration must work from those bytes rather than
     * issuing its own load -- and it must reach the ordinary diff subscription,
     * because that subscription is about to become the only presentation path.
     */
    it('hydrates a pending diff from the bytes the editor loaded, with no second disk read', async () => {
      harness = createLifecycleHarness({
        baseline: 'C0',
        diskContent: 'C1',
        seedPersistedContent: null,
      });
      const { diffCb } = harness.attachPresenter();

      await harness.model.ensureInitialized('C1');
      await settle();

      expect(contentsOf(diffCb)).toEqual(['C1']);
      expect((diffCb.mock.calls[0][0] as DiffState).oldContent).toBe('C0');
      expect(harness.loadCalls()).toBe(0);
    });

    /**
     * A tag lookup that fails is not the same fact as "this file has no pending
     * tags", and memoizing the two together leaves the tab permanently
     * un-hydrated over an unreviewed agent write.
     */
    it('stays retryable when the first tag lookup fails', async () => {
      harness = createLifecycleHarness({
        baseline: 'C0',
        diskContent: 'C1',
        seedPersistedContent: null,
      });
      const { diffCb } = harness.attachPresenter();
      harness.gateTagLookup(0).reject(new Error('history db busy'));

      await harness.model.ensureInitialized('C1').catch(() => {});
      await settle();
      expect(diffCb).not.toHaveBeenCalled();

      await harness.model.ensureInitialized('C1');
      await settle();
      expect(contentsOf(diffCb)).toEqual(['C1']);
    });

    /**
     * Reopening a file under review and then letting the agent write again --
     * the everyday case this whole plan is about.
     *
     * `DiskBackedStore` stamps each watcher signal from its own counter starting
     * at 1, so hydration must not spend a number out of that same space: doing so
     * made the model's ordering watermark treat the very next real write as an
     * observation it had already committed, and the agent's edit never reached
     * any editor. Only a second write got through.
     */
    it('delivers the first watcher event after hydration created the session', async () => {
      harness = createLifecycleHarness({
        baseline: 'C0',
        diskContent: 'C1',
        seedPersistedContent: null,
      });
      const { handle, diffCb } = harness.attachPresenter();

      await harness.model.ensureInitialized('C1');
      await settle();
      expect(contentsOf(diffCb)).toEqual(['C1']);
      handle.completeDiffApply({ generation: lastGeneration(diffCb), outcome: 'applied' });
      await settle();

      // The agent's next write, carrying the store's first signal sequence.
      harness.emit('C2', { sequence: 1 });
      await settle();

      expect(contentsOf(diffCb)).toEqual(['C1', 'C2']);
      expect(harness.model.getDiffState()?.newContent).toBe('C2');
    });
  });

  // -- 1f. Resolution as a two-store transaction (defects C and I) -----------

  describe('diff resolution', () => {
    async function reachAppliedState(h: LifecycleHarness) {
      const a = h.attachPresenter();
      h.emit('C1');
      await settle();
      a.handle.completeDiffApply({ generation: lastGeneration(a.diffCb), outcome: 'applied' });
      await settle();
      return a;
    }

    /**
     * The tag is marked reviewed before the write is attempted, so a refused
     * write leaves a reviewed tag over un-accepted content: the diff is gone
     * from every future lookup and the model is wedged mid-resolution.
     */
    it('leaves the tag pending and stays recoverable when the write fails', async () => {
      harness = createLifecycleHarness();
      const a = await reachAppliedState(harness);

      harness.failNextSave(new Error('conflict: disk changed'));
      await expect(a.handle.resolveDiff(true)).rejects.toThrow();

      expect(harness.tagUpdates).toEqual([]);
      expect(harness.model.getResolutionSnapshot()).toMatchObject({
        decision: 'accept',
        diskCommitted: false,
        tagCommitted: false,
      });
      // Recovery re-reads disk and puts the current bytes back through the model.
      expect(harness.loadCalls()).toBeGreaterThan(0);
      expect(harness.model.getDiffSessionSnapshot()?.phase).not.toBe('resolving-all');
    });

    /**
     * The write is the irreversible half, so it goes first. When the tag update
     * then fails, the bytes are on disk and only the idempotent tag retry is
     * outstanding -- the session may not be torn down and saves stay blocked
     * until it lands.
     */
    it('retains the committed disk half when the tag update fails after an accept', async () => {
      harness = createLifecycleHarness();
      const a = await reachAppliedState(harness);

      harness.failNextTagUpdate(new Error('history db down'));
      await a.handle.resolveDiff(true).catch(() => {});

      expect(harness.saved).toEqual(['C1']);
      expect(harness.model.getResolutionSnapshot()).toMatchObject({
        decision: 'accept',
        diskCommitted: true,
        tagCommitted: false,
      });
      expect(harness.model.getDiffState()).not.toBeNull();
    });

    it('retains the committed disk half when the tag update fails after a reject', async () => {
      harness = createLifecycleHarness();
      const a = await reachAppliedState(harness);

      harness.failNextTagUpdate(new Error('history db down'));
      await a.handle.resolveDiff(false).catch(() => {});

      expect(harness.saved).toEqual(['C0']);
      expect(harness.model.getResolutionSnapshot()).toMatchObject({
        decision: 'reject',
        diskCommitted: true,
        tagCommitted: false,
      });
    });

    /**
     * Two attachments show the same approval bar. Clicking Approve in both (or
     * one twice) must produce one decision, not two writes.
     */
    it('joins concurrent callers that ask for the same decision', async () => {
      harness = createLifecycleHarness();
      const a = await reachAppliedState(harness);
      const b = harness.attachPresenter();

      await Promise.allSettled([a.handle.resolveDiff(true), b.handle.resolveDiff(true)]);

      expect(harness.saved).toEqual(['C1']);
      expect(harness.tagUpdates.filter((u) => u.status === 'reviewed')).toHaveLength(1);
    });

    /**
     * Approve in Files mode, Reject in Agent mode. The loser must be refused
     * without writing -- today the second write simply lands last, so a reject
     * that arrives a millisecond late silently reverts an accepted change.
     */
    it('refuses an opposite decision while one is in flight, without writing', async () => {
      harness = createLifecycleHarness();
      const a = await reachAppliedState(harness);
      const b = harness.attachPresenter();

      const results = await Promise.allSettled([
        a.handle.resolveDiff(true),
        b.handle.resolveDiff(false),
      ]);

      expect(harness.saved).toEqual(['C1']);
      expect(harness.disk()).toBe('C1');
      expect(results[1].status).toBe('rejected');
    });

    /**
     * Resolving against a generation that is still being applied writes the
     * content the model last drained, not what disk holds. With C3 already on
     * disk, that write silently drops it.
     */
    it('waits for in-flight and queued generations before writing a decision', async () => {
      harness = createLifecycleHarness();
      const a = await reachAppliedState(harness);

      harness.emit('C2');
      await settle();
      harness.emit('C3');
      await settle();

      const resolution = a.handle.resolveDiff(true);
      await settle();
      expect(harness.saved).toEqual([]);

      a.handle.completeDiffApply({ generation: lastGeneration(a.diffCb), outcome: 'applied' });
      await settle();
      a.handle.completeDiffApply({ generation: lastGeneration(a.diffCb), outcome: 'applied' });
      await settle();
      await resolution.catch(() => {});

      expect(harness.saved).toEqual(['C3']);
      expect(harness.saveBaselines).toEqual(['C3']);
    });

    /**
     * A Lexical accept-all does not write "the session's applied content" -- the
     * user may have kept some groups and dropped others, so the editor serializes
     * its buffer and hands those bytes over. The editor used to write them itself
     * and mark the tag reviewed in two separate steps, which reads the conflict
     * baseline outside the model's serial queue. Through the model both halves are
     * one ordered transaction (NIM-5359, defect I).
     */
    it('writes an editor-serialized buffer as one transaction against the agent content', async () => {
      harness = createLifecycleHarness();
      const a = await reachAppliedState(harness);

      await a.handle.resolveDiff(true, {
        finalContent: 'C1-with-one-group-dropped',
        generation: harness.model.getCurrentDiffGeneration()!,
      });

      expect(harness.saved).toEqual(['C1-with-one-group-dropped']);
      // The honest baseline is what the agent last wrote, not the pre-edit content.
      expect(harness.saveBaselines).toEqual(['C1']);
      expect(harness.tagUpdates).toEqual([{ tagId: 'tag-1', status: 'reviewed' }]);
      expect(harness.model.getDiffState()).toBeNull();
    });

    /**
     * The incident shape. The user clicks Approve; between the buffer being
     * serialized and the write reaching disk, the agent writes C2. The editor's
     * own write path read `DiffState.newContent` at write time, so it handed the
     * store C2 as the expected baseline and its C1 buffer sailed through the
     * conflict check straight over C2. The decision names the generation it was
     * made against, so the model refuses it instead.
     */
    it('refuses a decision whose generation the agent has already superseded', async () => {
      harness = createLifecycleHarness();
      const a = await reachAppliedState(harness);
      const decidedGeneration = harness.model.getCurrentDiffGeneration()!;

      harness.emit('C2');
      await settle();

      await expect(
        a.handle.resolveDiff(true, { finalContent: 'C1-approved', generation: decidedGeneration }),
      ).rejects.toThrow(/generation/i);

      expect(harness.saved).toEqual([]);
      expect(harness.disk()).toBe('C2');
      // The review stays open over the content the user has not seen yet.
      expect(harness.tagUpdates).toEqual([]);
      expect(harness.model.getDiffState()).not.toBeNull();
    });

    /**
     * A serialized buffer must not park either: parking waits for the newer
     * generation to reach the screen and then writes bytes that predate it.
     */
    it('refuses a serialized buffer rather than parking it behind queued content', async () => {
      harness = createLifecycleHarness();
      const a = await reachAppliedState(harness);

      harness.emit('C2');
      await settle();
      const presented = harness.model.getCurrentDiffGeneration()!;
      harness.emit('C3');
      await settle();

      await expect(
        a.handle.resolveDiff(true, { finalContent: 'C2-approved', generation: presented }),
      ).rejects.toThrow();
      expect(harness.saved).toEqual([]);
    });

    /**
     * After the write lands and the tag update fails, saves are blocked but typing
     * is not. The retry used to clear every attachment's dirty flag and replay the
     * old resolved content over it, destroying edits made while recovery was
     * pending (NIM-5359, finding 4).
     */
    it('preserves a buffer that went dirty while the tag retry was outstanding', async () => {
      harness = createLifecycleHarness();
      const a = await reachAppliedState(harness);
      const sibling = harness.model.attach();
      const siblingContent = vi.fn();
      sibling.onFileChanged(siblingContent);

      harness.failNextTagUpdate(new Error('history db down'));
      await a.handle.resolveDiff(true).catch(() => {});
      expect(harness.model.isSaveBlockedByPendingResolution()).toBe(true);
      siblingContent.mockClear();

      // The user types in the other attachment while the retry is outstanding.
      sibling.setDirty(true);

      await harness.model.retryPendingResolution();

      expect(harness.tagUpdates).toEqual([{ tagId: 'tag-1', status: 'reviewed' }]);
      expect(siblingContent).not.toHaveBeenCalled();
      expect(harness.model.isDirty()).toBe(true);
    });

    /**
     * The retry used to read the tag id off the live session. A second agent
     * session writing while the history DB is down replaces that session, so the
     * retry marked *its* tag reviewed -- ending a review the user never saw, and
     * leaving the original one pending forever.
     */
    it('retries the tag the decision was made against, not whatever the session now holds', async () => {
      harness = createLifecycleHarness();
      const a = await reachAppliedState(harness);

      harness.failNextTagUpdate(new Error('history db down'));
      await a.handle.resolveDiff(true).catch(() => {});

      // A different agent session starts its own edit on the same file.
      harness.setTag({ id: 'tag-2', sessionId: 'sess-2', createdAt: '2026-09-01T01:00:00Z' });
      harness.emit('C4');
      await settle();
      expect(harness.model.getDiffState()?.tagId).toBe('tag-2');

      await harness.model.retryPendingResolution();

      expect(harness.tagUpdates).toEqual([{ tagId: 'tag-1', status: 'reviewed' }]);
    });
  });
});
