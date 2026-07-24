import { describe, expect, it } from 'vitest';
import { DiffSession } from '../DiffSession';
import { hashContent } from '../contentHash';

const baseInput = {
  tagId: 'tag-1',
  sessionId: 'session-1',
  baselineContent: 'baseline\n',
  initialContent: 'baseline\nai-edit\n',
};

describe('DiffSession', () => {
  describe('create', () => {
    it('starts in the applying phase with the provided initial content', () => {
      const s = DiffSession.create(baseInput);
      expect(s.phase).toBe('applying');
      expect(s.tagId).toBe('tag-1');
      expect(s.sessionId).toBe('session-1');
      expect(s.baselineContent).toBe('baseline\n');
      expect(s.appliedContent).toBe('baseline\nai-edit\n');
      expect(s.appliedContentHash).toBe(hashContent('baseline\nai-edit\n'));
      expect(s.pendingContent).toBeNull();
    });
  });

  describe('markApplied', () => {
    it('transitions applying -> applied', () => {
      const s = DiffSession.create(baseInput);
      s.markApplied();
      expect(s.phase).toBe('applied');
    });

    it('throws if called outside applying phase', () => {
      const s = DiffSession.create(baseInput);
      s.markApplied();
      expect(() => s.markApplied()).toThrow();
    });
  });

  describe('ingest -- duplicate detection', () => {
    it('returns duplicate when applied content matches incoming hash', () => {
      const s = DiffSession.create(baseInput);
      s.markApplied();
      const result = s.ingest('baseline\nai-edit\n');
      expect(result.kind).toBe('duplicate');
      // No state change.
      expect(s.phase).toBe('applied');
      expect(s.pendingContent).toBeNull();
    });

    it('returns duplicate when in-flight content matches incoming hash', () => {
      const s = DiffSession.create(baseInput);
      // Still in 'applying'; the second IPC event of the same payload arrives.
      const result = s.ingest('baseline\nai-edit\n');
      expect(result.kind).toBe('duplicate');
      expect(s.phase).toBe('applying');
    });
  });

  describe('ingest -- queueing while in flight', () => {
    it('queues a different payload while applying', () => {
      const s = DiffSession.create(baseInput);
      const result = s.ingest('baseline\nsecond-edit\n');
      expect(result.kind).toBe('queued');
      expect(s.pendingContent).toBe('baseline\nsecond-edit\n');
      // appliedContent should NOT change yet -- it's still the in-flight payload.
      expect(s.appliedContent).toBe('baseline\nai-edit\n');
    });

    it('overwrites a stale queued payload (last-write-wins)', () => {
      const s = DiffSession.create(baseInput);
      s.ingest('baseline\nsecond-edit\n');
      s.ingest('baseline\nthird-edit\n');
      expect(s.pendingContent).toBe('baseline\nthird-edit\n');
    });
  });

  describe('ingest -- fresh apply when applied with new payload', () => {
    it('begins a new apply when a fresh payload arrives in applied phase', () => {
      const s = DiffSession.create(baseInput);
      s.markApplied();
      const result = s.ingest('baseline\nsecond-edit\n');
      expect(result.kind).toBe('apply');
      expect(s.phase).toBe('applying');
      expect(s.appliedContent).toBe('baseline\nsecond-edit\n');
      expect(s.appliedContentHash).toBe(hashContent('baseline\nsecond-edit\n'));
    });
  });

  describe('drainPending', () => {
    it('returns null when nothing is queued', () => {
      const s = DiffSession.create(baseInput);
      expect(s.drainPending()).toBeNull();
    });

    it('drains the queued payload, transitions to applying, and updates applied hash', () => {
      const s = DiffSession.create(baseInput);
      // queue while applying
      s.ingest('baseline\nsecond-edit\n');
      // editor finishes the first apply
      s.markApplied();
      // Now drain
      const drained = s.drainPending();
      expect(drained).toBe('baseline\nsecond-edit\n');
      expect(s.phase).toBe('applying');
      expect(s.appliedContent).toBe('baseline\nsecond-edit\n');
      expect(s.appliedContentHash).toBe(hashContent('baseline\nsecond-edit\n'));
      expect(s.pendingContent).toBeNull();
    });
  });

  describe('partial resolve', () => {
    it('rotates tag and re-baselines, returning to applied', () => {
      const s = DiffSession.create(baseInput);
      s.markApplied();
      s.beginPartialResolve();
      expect(s.phase).toBe('resolving-partial');

      s.completePartialResolve({
        newBaseline: 'baseline-after-partial\n',
        newTagId: 'tag-2',
      });

      expect(s.phase).toBe('applied');
      expect(s.tagId).toBe('tag-2');
      expect(s.baselineContent).toBe('baseline-after-partial\n');
      // appliedContent should NOT change -- the un-resolved groups remain on screen.
      expect(s.appliedContent).toBe('baseline\nai-edit\n');
    });

    it('beginPartialResolve is illegal outside applied phase', () => {
      const s = DiffSession.create(baseInput);
      // Still in 'applying'
      expect(() => s.beginPartialResolve()).toThrow();
    });

    it('completePartialResolve is illegal outside resolving-partial', () => {
      const s = DiffSession.create(baseInput);
      s.markApplied();
      expect(() => s.completePartialResolve({ newBaseline: 'x', newTagId: 't' })).toThrow();
    });

    it('queues incoming content while in resolving-partial', () => {
      const s = DiffSession.create(baseInput);
      s.markApplied();
      s.beginPartialResolve();

      const result = s.ingest('baseline\nlater-edit\n');
      expect(result.kind).toBe('queued');
      expect(s.pendingContent).toBe('baseline\nlater-edit\n');
    });
  });

  describe('resolveAll', () => {
    it('returns appliedContent as final on accept', () => {
      const s = DiffSession.create(baseInput);
      s.markApplied();
      const { finalContent } = s.beginResolveAll(true);
      expect(finalContent).toBe('baseline\nai-edit\n');
      expect(s.phase).toBe('resolving-all');
    });

    it('returns baselineContent as final on reject', () => {
      const s = DiffSession.create(baseInput);
      s.markApplied();
      const { finalContent } = s.beginResolveAll(false);
      expect(finalContent).toBe('baseline\n');
      expect(s.phase).toBe('resolving-all');
    });

    it('beginResolveAll is illegal outside applied phase', () => {
      const s = DiffSession.create(baseInput);
      // Still applying.
      expect(() => s.beginResolveAll(true)).toThrow();
    });

    it('completeResolveAll requires resolving-all phase', () => {
      const s = DiffSession.create(baseInput);
      s.markApplied();
      expect(() => s.completeResolveAll()).toThrow();
      s.beginResolveAll(true);
      expect(() => s.completeResolveAll()).not.toThrow();
    });

    it('queues incoming content while in resolving-all', () => {
      // (Edge case: a new AI edit lands while the user is mid-accept-all. The owning
      // model decides whether to drain it or drop the session entirely.)
      const s = DiffSession.create(baseInput);
      s.markApplied();
      s.beginResolveAll(true);
      const result = s.ingest('baseline\nlater-edit\n');
      expect(result.kind).toBe('queued');
      expect(s.pendingContent).toBe('baseline\nlater-edit\n');
    });
  });

  describe('snapshot', () => {
    it('returns a plain object reflecting current state', () => {
      const s = DiffSession.create({ ...baseInput, createdAt: 1234 });
      const snap = s.snapshot();
      expect(snap).toEqual({
        tagId: 'tag-1',
        sessionId: 'session-1',
        phase: 'applying',
        baselineContent: 'baseline\n',
        appliedContent: 'baseline\nai-edit\n',
        appliedContentHash: hashContent('baseline\nai-edit\n'),
        pendingContent: null,
        createdAt: 1234,
      });
    });
  });
});
