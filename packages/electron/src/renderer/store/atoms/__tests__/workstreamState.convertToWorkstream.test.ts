import { describe, it, expect, beforeEach } from 'vitest';
import { createStore } from 'jotai';
import {
  convertToWorkstreamAtom,
  initWorkstreamState,
  workstreamStateAtom,
} from '../workstreamState';

/**
 * Unit tests for convertToWorkstreamAtom covering both:
 *   - the sibling-creation path (existing behavior)
 *   - the drag-drop path (new: siblingId omitted)
 *
 * The drag-drop path was previously gated out at the call site in sessions.ts,
 * so workstreamStateAtom(parentId) was never initialized. This test pins the
 * fully-initialized behavior so future refactors can't silently regress it.
 */

describe('convertToWorkstreamAtom', () => {
  let store: ReturnType<typeof createStore>;
  const sessionId = 'session-original';
  const parentId = 'parent-workstream';
  const siblingId = 'session-sibling';

  beforeEach(() => {
    store = createStore();
    // Required by workstreamStateAtom's writer (schedulePersist asserts a workspace path is set).
    initWorkstreamState('/test-workspace');
  });

  describe('with siblingId (normal conversion)', () => {
    it('initializes parent state with both children and sibling as active', () => {
      store.set(convertToWorkstreamAtom, { sessionId, parentId, siblingId });

      const parent = store.get(workstreamStateAtom(parentId));
      expect(parent.type).toBe('workstream');
      expect(parent.childSessionIds).toEqual([sessionId, siblingId]);
      expect(parent.activeChildId).toBe(siblingId);
    });

    it('clears the original session state to type=single', () => {
      store.set(convertToWorkstreamAtom, { sessionId, parentId, siblingId });

      const original = store.get(workstreamStateAtom(sessionId));
      expect(original.type).toBe('single');
      expect(original.childSessionIds).toEqual([]);
      expect(original.activeChildId).toBeNull();
    });

    it('initializes sibling state to defaults', () => {
      store.set(convertToWorkstreamAtom, { sessionId, parentId, siblingId });

      const sibling = store.get(workstreamStateAtom(siblingId));
      expect(sibling.type).toBe('single');
      expect(sibling.childSessionIds).toEqual([]);
    });

    it('inherits UI settings from the original session onto the parent', () => {
      // Pre-set non-default UI state on the original session
      store.set(workstreamStateAtom(sessionId), {
        layoutMode: 'editor',
        splitRatio: 0.7,
        filesSidebarVisible: false,
      });

      store.set(convertToWorkstreamAtom, { sessionId, parentId, siblingId });

      const parent = store.get(workstreamStateAtom(parentId));
      expect(parent.layoutMode).toBe('editor');
      expect(parent.splitRatio).toBe(0.7);
      expect(parent.filesSidebarVisible).toBe(false);
    });
  });

  describe('without siblingId (drag-drop conversion)', () => {
    it('initializes parent with the original session as the only child', () => {
      store.set(convertToWorkstreamAtom, { sessionId, parentId });

      const parent = store.get(workstreamStateAtom(parentId));
      expect(parent.type).toBe('workstream');
      expect(parent.childSessionIds).toEqual([sessionId]);
      expect(parent.activeChildId).toBe(sessionId);
    });

    it('still clears the original session state to type=single', () => {
      store.set(convertToWorkstreamAtom, { sessionId, parentId });

      const original = store.get(workstreamStateAtom(sessionId));
      expect(original.type).toBe('single');
      expect(original.childSessionIds).toEqual([]);
      expect(original.activeChildId).toBeNull();
    });

    it('inherits UI settings from the original session', () => {
      store.set(workstreamStateAtom(sessionId), {
        layoutMode: 'split',
        splitRatio: 0.3,
        filesSidebarVisible: true,
      });

      store.set(convertToWorkstreamAtom, { sessionId, parentId });

      const parent = store.get(workstreamStateAtom(parentId));
      expect(parent.layoutMode).toBe('split');
      expect(parent.splitRatio).toBe(0.3);
      expect(parent.filesSidebarVisible).toBe(true);
    });
  });
});
