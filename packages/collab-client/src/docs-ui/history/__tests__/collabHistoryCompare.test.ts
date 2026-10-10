// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { DocRevisionMetadata } from '@nimbalyst/collab-protocol';
import { loadCollabHistoryCompare, planCollabHistoryCompare } from '../collabHistoryCompare';

const rev = (revisionId: string, contentFormat = 'markdown') =>
  ({ revisionId, contentFormat } as DocRevisionMetadata);

// Newest first, as the server lists them.
const revisions = [rev('r3'), rev('r2'), rev('r1')];

const loaders = {
  revision: async (id: string) => `text of ${id}`,
  current: async () => 'live page',
};

describe('collab history compare', () => {
  it('pairs the selection with the right other side for each mode', async () => {
    const run = async (selected: string | null, mode: 'previous' | 'current' | 'full', canReadCurrent = true) =>
      loadCollabHistoryCompare(planCollabHistoryCompare(revisions, selected, mode, canReadCurrent), loaders);

    // Previous is the older neighbour, and it is the old side.
    await expect(run('r2', 'previous')).resolves.toEqual({ kind: 'diff', oldText: 'text of r1', newText: 'text of r2' });
    // The oldest revision has nothing before it.
    await expect(run('r1', 'previous')).resolves.toEqual({ kind: 'single', text: 'text of r1' });
    // Against the live page the revision is the old side.
    await expect(run('r3', 'current')).resolves.toEqual({ kind: 'diff', oldText: 'text of r3', newText: 'live page' });
    // An editor that cannot export its content cannot be compared with now.
    await expect(run('r3', 'current', false)).resolves.toEqual({ kind: 'single', text: 'text of r3' });
    await expect(run('r2', 'full')).resolves.toEqual({ kind: 'single', text: 'text of r2' });
    await expect(run(null, 'previous')).resolves.toEqual({ kind: 'none' });
    await expect(run('gone', 'previous')).resolves.toEqual({ kind: 'none' });
  });

  it('falls back to the selected revision when a side has no text projection', async () => {
    const plan = planCollabHistoryCompare(revisions, 'r3', 'current', true);
    await expect(loadCollabHistoryCompare(plan, { ...loaders, current: async () => null }))
      .resolves.toEqual({ kind: 'single', text: 'text of r3' });

    const previousPlan = planCollabHistoryCompare(revisions, 'r2', 'previous', true);
    await expect(loadCollabHistoryCompare(previousPlan, {
      ...loaders,
      revision: async (id: string) => (id === 'r1' ? null : `text of ${id}`),
    })).resolves.toEqual({ kind: 'single', text: 'text of r2' });
  });
});
