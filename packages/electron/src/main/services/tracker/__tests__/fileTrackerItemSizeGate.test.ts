// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrackerItem } from '@nimbalyst/runtime';

const sharing = vi.hoisted(() => ({ value: 'team' as 'team' | 'personal' }));

vi.mock('../../TrackerSyncManager', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../TrackerSyncManager')>(),
  isTrackerSyncConfigured: () => true,
}));
vi.mock('../../TrackerPolicyService', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../TrackerPolicyService')>(),
  getEffectiveTrackerSharingPolicy: () => ({ sharing: sharing.value, draftByDefault: false }),
}));

import { fileTrackerItemUpdateRefusal } from '../fileTrackerItemSizeGate';

const plan: TrackerItem = {
  id: 'fm:plan:plans/sync.md',
  type: 'plan',
  title: 'Sync engine',
  status: 'active',
  workspace: '/w',
  created: '2026-09-01T00:00:00.000Z',
  updated: '2026-09-01T00:00:00.000Z',
  lastIndexed: new Date('2026-09-01T00:00:00.000Z'),
  module: 'plans/sync.md',
  lineNumber: 0,
} as TrackerItem;

const huge = 'x'.repeat(300 * 1024);

describe('fileTrackerItemUpdateRefusal', () => {
  beforeEach(() => { sharing.value = 'team'; });

  it('refuses a cell edit that would make a shared file-backed item too large for its room', () => {
    expect(fileTrackerItemUpdateRefusal(plan, { summary: huge }, '/w')).toMatch(/too large to share/);
  });

  it('lets an edit that fits, an unshared item, and a body change through', () => {
    expect(fileTrackerItemUpdateRefusal(plan, { summary: 'short' }, '/w')).toBeNull();
    expect(fileTrackerItemUpdateRefusal(plan, { description: huge }, '/w')).toBeNull();
    sharing.value = 'personal';
    expect(fileTrackerItemUpdateRefusal(plan, { summary: huge }, '/w')).toBeNull();
  });
});
