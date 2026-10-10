// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { DraftStore, prepareToLeave, resolveLeave, type OpenEditor, type PageDraft, type SaveOutcome } from '../drafts';

/** An open editor whose save answers with the queued outcomes, in order. */
function editor(pageId: string, state: { dirty: boolean; conflicted: boolean }, outcomes: SaveOutcome[] = []) {
  const calls: Array<{ overwrite: boolean }> = [];
  let discarded = false;
  const open: OpenEditor = {
    pageId,
    dirty: () => state.dirty && !discarded,
    conflicted: () => state.conflicted && !discarded,
    save: async (overwrite = false) => {
      calls.push({ overwrite });
      const outcome = outcomes.shift() ?? 'saved';
      if (outcome === 'saved') Object.assign(state, { dirty: false, conflicted: false });
      if (outcome === 'conflict') state.conflicted = true;
      return outcome;
    },
    discard: () => {
      discarded = true;
    },
  };
  return { open, calls, wasDiscarded: () => discarded };
}

const conflictedDraft: PageDraft = {
  pageId: 'a',
  markdown: 'my edits',
  baseline: 'original',
  baseVersion: 'v1',
  conflict: { diskMarkdown: 'their edits', diskVersion: 'v2' },
};

describe('leaving a page with unsaved edits', () => {
  it('leaves at once when the open page is clean, and finishes a pending save before leaving', async () => {
    const store = new DraftStore();
    expect(await prepareToLeave(store)).toEqual({ kind: 'leave' });

    const clean = editor('a', { dirty: false, conflicted: false });
    const detach = store.attach(clean.open);
    expect(await prepareToLeave(store)).toEqual({ kind: 'leave' });
    expect(clean.calls).toEqual([]);
    detach();

    const pending = editor('a', { dirty: true, conflicted: false }, ['saved']);
    store.attach(pending.open);
    expect(store.hasUnsaved()).toBe(true);
    expect(await prepareToLeave(store)).toEqual({ kind: 'leave' });
    expect(pending.calls).toEqual([{ overwrite: false }]);
    expect(store.hasUnsaved()).toBe(false);
  });

  it('asks instead of leaving when the save conflicts, and each answer does what it says', async () => {
    const store = new DraftStore();
    const a = editor('a', { dirty: true, conflicted: false }, ['conflict', 'saved']);
    store.attach(a.open);

    const asked = await prepareToLeave(store);
    expect(asked).toEqual({ kind: 'ask', pageId: 'a', reason: 'conflict' });
    // A conflicted page is asked about again without another write.
    expect(await prepareToLeave(store)).toEqual(asked);
    expect(a.calls).toEqual([{ overwrite: false }]);

    expect(await resolveLeave(store, 'keep')).toEqual({ kind: 'stay' });
    expect(a.wasDiscarded()).toBe(false);

    expect(await resolveLeave(store, 'overwrite')).toEqual({ kind: 'leave' });
    expect(a.calls.at(-1)).toEqual({ overwrite: true });
  });

  it('asks again when an overwrite is itself rejected, and discarding drops the held draft too', async () => {
    const store = new DraftStore();
    const a = editor('a', { dirty: true, conflicted: true }, ['conflict']);
    store.attach(a.open);
    store.hold(conflictedDraft);

    expect(await resolveLeave(store, 'overwrite')).toEqual({ kind: 'ask', pageId: 'a', reason: 'conflict' });
    expect(await resolveLeave(store, 'discard')).toEqual({ kind: 'leave' });
    expect(a.wasDiscarded()).toBe(true);
    expect(store.held('a')).toBeNull();
    expect(store.hasUnsaved()).toBe(false);
  });

  it('asks when the save fails outright rather than dropping the edits', async () => {
    const store = new DraftStore();
    store.attach(editor('a', { dirty: true, conflicted: false }, ['error']).open);
    expect(await prepareToLeave(store)).toEqual({ kind: 'ask', pageId: 'a', reason: 'error' });
  });
});

describe('DraftStore', () => {
  it('holds a draft after its editor is gone, so reopening the page restores it with its conflict', () => {
    const store = new DraftStore();
    const detach = store.attach(editor('a', { dirty: true, conflicted: true }).open);
    store.hold(conflictedDraft);
    detach();

    expect(store.held('a')).toEqual(conflictedDraft);
    expect(store.held('b')).toBeNull();
    // Closing or reloading the tab is guarded while any draft is held.
    expect(store.hasUnsaved()).toBe(true);

    store.drop('a');
    expect(store.hasUnsaved()).toBe(false);
  });

  it('ignores a stale detach from an editor that was already replaced', () => {
    const store = new DraftStore();
    const detachA = store.attach(editor('a', { dirty: false, conflicted: false }).open);
    store.attach(editor('b', { dirty: true, conflicted: false }).open);
    detachA();
    expect(store.hasUnsaved()).toBe(true);
  });
});
