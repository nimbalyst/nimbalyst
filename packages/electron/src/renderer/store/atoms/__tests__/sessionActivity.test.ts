import { describe, it, expect, beforeEach } from 'vitest';
import { createStore } from 'jotai';
import {
  globalSessionActivityAtom,
  sessionActivityIndexAtom,
  markSessionStreamingAtom,
  clearSessionStreamingAtom,
  markSessionUnreadAtom,
  clearSessionUnreadAtom,
  clearWorkspaceActivityAtom,
  projectActivitySummaryAtom,
} from '../sessionActivity';

const PATH_A = '/ws/a';
const PATH_B = '/ws/b';

describe('sessionActivity atoms', () => {
  let jotaiStore: ReturnType<typeof createStore>;

  beforeEach(() => {
    jotaiStore = createStore();
  });

  describe('streaming', () => {
    it('records a streaming session for its workspace', () => {
      jotaiStore.set(markSessionStreamingAtom, { sessionId: 's1', workspacePath: PATH_A });

      const map = jotaiStore.get(globalSessionActivityAtom);
      expect(map.get(PATH_A)?.streaming.has('s1')).toBe(true);

      const index = jotaiStore.get(sessionActivityIndexAtom);
      expect(index.get('s1')).toBe(PATH_A);
    });

    it('clears a streaming session and removes the workspace entry when empty', () => {
      jotaiStore.set(markSessionStreamingAtom, { sessionId: 's1', workspacePath: PATH_A });
      jotaiStore.set(clearSessionStreamingAtom, { sessionId: 's1' });

      const map = jotaiStore.get(globalSessionActivityAtom);
      expect(map.has(PATH_A)).toBe(false);
    });

    it('keeps the workspace entry when other activity remains', () => {
      jotaiStore.set(markSessionStreamingAtom, { sessionId: 's1', workspacePath: PATH_A });
      jotaiStore.set(markSessionUnreadAtom, { sessionId: 's2', workspacePath: PATH_A });

      jotaiStore.set(clearSessionStreamingAtom, { sessionId: 's1' });

      const map = jotaiStore.get(globalSessionActivityAtom);
      expect(map.get(PATH_A)?.streaming.size).toBe(0);
      expect(map.get(PATH_A)?.unread.size).toBe(1);
    });

    it('looks up the path from the index when not provided', () => {
      jotaiStore.set(markSessionStreamingAtom, { sessionId: 's1', workspacePath: PATH_A });

      jotaiStore.set(clearSessionStreamingAtom, { sessionId: 's1' });

      expect(jotaiStore.get(globalSessionActivityAtom).has(PATH_A)).toBe(false);
    });
  });

  describe('unread', () => {
    it('records an unread session for its workspace', () => {
      jotaiStore.set(markSessionUnreadAtom, { sessionId: 's1', workspacePath: PATH_B });

      expect(jotaiStore.get(globalSessionActivityAtom).get(PATH_B)?.unread.has('s1')).toBe(true);
    });

    it('clears an unread session', () => {
      jotaiStore.set(markSessionUnreadAtom, { sessionId: 's1', workspacePath: PATH_B });
      jotaiStore.set(clearSessionUnreadAtom, { sessionId: 's1' });

      expect(jotaiStore.get(globalSessionActivityAtom).has(PATH_B)).toBe(false);
    });
  });

  describe('clearWorkspaceActivityAtom', () => {
    it('removes every entry for a workspace path and prunes the index', () => {
      jotaiStore.set(markSessionStreamingAtom, { sessionId: 's1', workspacePath: PATH_A });
      jotaiStore.set(markSessionUnreadAtom, { sessionId: 's2', workspacePath: PATH_A });
      jotaiStore.set(markSessionStreamingAtom, { sessionId: 's3', workspacePath: PATH_B });

      jotaiStore.set(clearWorkspaceActivityAtom, PATH_A);

      const map = jotaiStore.get(globalSessionActivityAtom);
      expect(map.has(PATH_A)).toBe(false);
      expect(map.get(PATH_B)?.streaming.has('s3')).toBe(true);

      const index = jotaiStore.get(sessionActivityIndexAtom);
      expect(index.has('s1')).toBe(false);
      expect(index.has('s2')).toBe(false);
      expect(index.get('s3')).toBe(PATH_B);
    });

    it('is a no-op when the workspace was never tracked', () => {
      jotaiStore.set(clearWorkspaceActivityAtom, '/never/seen');
      expect(jotaiStore.get(globalSessionActivityAtom).size).toBe(0);
    });
  });

  describe('projectActivitySummaryAtom', () => {
    it('summarizes streaming + unread counts per workspace', () => {
      jotaiStore.set(markSessionStreamingAtom, { sessionId: 's1', workspacePath: PATH_A });
      jotaiStore.set(markSessionStreamingAtom, { sessionId: 's2', workspacePath: PATH_A });
      jotaiStore.set(markSessionUnreadAtom, { sessionId: 's3', workspacePath: PATH_A });
      jotaiStore.set(markSessionUnreadAtom, { sessionId: 's4', workspacePath: PATH_B });

      const summary = jotaiStore.get(projectActivitySummaryAtom);
      expect(summary.get(PATH_A)).toEqual({ processing: 2, unread: 1 });
      expect(summary.get(PATH_B)).toEqual({ processing: 0, unread: 1 });
    });

    it('omits workspaces with no activity', () => {
      const summary = jotaiStore.get(projectActivitySummaryAtom);
      expect(summary.size).toBe(0);
    });
  });
});
