import { describe, expect, it } from 'vitest';
import { isTrackerReferenceKey } from '../trackerReferenceHref';

describe('isTrackerReferenceKey', () => {
  it('accepts real tracker key shapes', () => {
    for (const k of [
      'NIM-123', 'ABC-1',
      'bug_01JBKZ8XRTPQ9M7NVWFS2C3H4E',
      'bug_1778873790979_ux2559',
      'github-pr_123', 'decision-exploration_abc', 'tsk_9',
      'fm:plan:planning/x.md'.replace('/', '-'),
    ]) {
      expect(isTrackerReferenceKey(k), k).toBe(true);
    }
  });
  it('rejects reserved deep-link hosts', () => {
    for (const k of ['action', 'doc', 'folder', 'tracker', 'install', 'auth']) {
      expect(isTrackerReferenceKey(k), k).toBe(false);
    }
  });
  it('rejects namespaced paths', () => {
    for (const k of ['action/open-project-manager', 'doc/abc', 'folder/x', 'tracker/9']) {
      expect(isTrackerReferenceKey(k), k).toBe(false);
    }
  });
});
