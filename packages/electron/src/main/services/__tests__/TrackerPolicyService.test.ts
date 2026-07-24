import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetWorkspaceState, mockGlobalRegistryGet } = vi.hoisted(() => ({
  mockGetWorkspaceState: vi.fn((..._args: any[]) => ({})),
  mockGlobalRegistryGet: vi.fn((..._args: any[]) => undefined as any),
}));

vi.mock('../../utils/store', () => ({
  getWorkspaceState: mockGetWorkspaceState,
}));

vi.mock('@nimbalyst/runtime/plugins/TrackerPlugin/models/TrackerDataModel', () => ({
  globalRegistry: {
    get: mockGlobalRegistryGet,
  },
}));

import {
  decideBackfillAction,
  getEffectiveTrackerSyncPolicy,
  getInitialTrackerSyncStatus,
  isTrackerItemShared,
  shouldSyncTrackerItem,
} from '../TrackerPolicyService';

describe('TrackerPolicyService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetWorkspaceState.mockReturnValue({});
    mockGlobalRegistryGet.mockReturnValue(undefined);
  });

  it('falls back to the model policy when no workspace override exists', () => {
    mockGlobalRegistryGet.mockReturnValue({
      sync: { mode: 'shared', scope: 'workspace' },
    });

    expect(getEffectiveTrackerSyncPolicy('/tmp/ws', 'bug')).toEqual({
      mode: 'shared',
      scope: 'workspace',
    });
  });

  it('applies a string workspace override while preserving default scope', () => {
    mockGlobalRegistryGet.mockReturnValue({
      sync: { mode: 'shared', scope: 'project' },
    });
    mockGetWorkspaceState.mockReturnValue({
      trackerSyncPolicies: {
        bug: 'local',
      },
    });

    expect(getEffectiveTrackerSyncPolicy('/tmp/ws', 'bug')).toEqual({
      mode: 'local',
      scope: 'project',
    });
  });

  it('applies an object workspace override for mode and scope', () => {
    mockGlobalRegistryGet.mockReturnValue({
      sync: { mode: 'local', scope: 'project' },
    });
    mockGetWorkspaceState.mockReturnValue({
      trackerSyncPolicies: {
        bug: { mode: 'shared', scope: 'workspace' },
      },
    });

    expect(getEffectiveTrackerSyncPolicy('/tmp/ws', 'bug')).toEqual({
      mode: 'shared',
      scope: 'workspace',
    });
  });

  it('maps local policy to local sync status and shared policy to pending', () => {
    expect(getInitialTrackerSyncStatus({ mode: 'local', scope: 'project' })).toBe('local');
    expect(getInitialTrackerSyncStatus({ mode: 'shared', scope: 'project' })).toBe('pending');
  });

  it('treats an unflagged hybrid item as local and a flagged one as pending', () => {
    const hybrid = { mode: 'hybrid' as const, scope: 'workspace' as const };
    // No data / unflagged -> local (no leak)
    expect(getInitialTrackerSyncStatus(hybrid)).toBe('local');
    expect(getInitialTrackerSyncStatus(hybrid, {})).toBe('local');
    // Flagged -> pending
    expect(getInitialTrackerSyncStatus(hybrid, { shared: true })).toBe('pending');
    expect(getInitialTrackerSyncStatus(hybrid, { share: { status: 'team' } })).toBe('pending');
  });

  describe('isTrackerItemShared', () => {
    it('returns false for empty/null/unflagged data', () => {
      expect(isTrackerItemShared(null)).toBe(false);
      expect(isTrackerItemShared(undefined)).toBe(false);
      expect(isTrackerItemShared({})).toBe(false);
      expect(isTrackerItemShared({ share: { status: 'private' } })).toBe(false);
      expect(isTrackerItemShared({ shared: false })).toBe(false);
    });

    it('recognizes the generic shared boolean', () => {
      expect(isTrackerItemShared({ shared: true })).toBe(true);
    });

    it('recognizes the frontmatter share.status flag', () => {
      expect(isTrackerItemShared({ share: { status: 'team', body: 'team' } })).toBe(true);
    });

    it('recognizes the body-share flag alone (body shares the item too)', () => {
      expect(isTrackerItemShared({ share: { body: 'team' } })).toBe(true);
      expect(isTrackerItemShared({ share: { body: 'private' } })).toBe(false);
    });

    it('recognizes flags nested under customFields (TrackerItem shape)', () => {
      expect(isTrackerItemShared({ customFields: { shared: true } })).toBe(true);
      expect(isTrackerItemShared({ customFields: { share: { status: 'team' } } })).toBe(true);
      expect(isTrackerItemShared({ customFields: { share: { status: 'private' } } })).toBe(false);
    });
  });

  describe('shouldSyncTrackerItem', () => {
    const data = { share: { status: 'team' } };
    it('always syncs shared, never syncs local, regardless of flag', () => {
      expect(shouldSyncTrackerItem({ mode: 'shared', scope: 'project' }, null)).toBe(true);
      expect(shouldSyncTrackerItem({ mode: 'shared', scope: 'project' }, data)).toBe(true);
      expect(shouldSyncTrackerItem({ mode: 'local', scope: 'project' }, data)).toBe(false);
    });
    it('syncs hybrid only when the item is flagged', () => {
      expect(shouldSyncTrackerItem({ mode: 'hybrid', scope: 'project' }, null)).toBe(false);
      expect(shouldSyncTrackerItem({ mode: 'hybrid', scope: 'project' }, {})).toBe(false);
      expect(shouldSyncTrackerItem({ mode: 'hybrid', scope: 'project' }, data)).toBe(true);
      expect(shouldSyncTrackerItem({ mode: 'hybrid', scope: 'project' }, { shared: true })).toBe(true);
    });
  });

  describe('decideBackfillAction (NIM-880)', () => {
    const hybrid = { mode: 'hybrid' as const, scope: 'project' as const };
    const flagged = { share: { status: 'team' } };
    const unflagged = {};

    it('upserts a flagged hybrid item regardless of prior share state', () => {
      expect(decideBackfillAction(hybrid, flagged, false)).toBe('upsert');
      expect(decideBackfillAction(hybrid, flagged, true)).toBe('upsert');
    });

    it('always upserts a shared-mode item', () => {
      expect(decideBackfillAction({ mode: 'shared', scope: 'project' }, unflagged, false)).toBe('upsert');
    });

    it('deletes an unflagged item that was previously shared (offline unshare)', () => {
      expect(decideBackfillAction(hybrid, unflagged, true)).toBe('delete');
    });

    it('skips an unflagged item that was never shared (local-only, no leak)', () => {
      expect(decideBackfillAction(hybrid, unflagged, false)).toBe('skip');
    });

    it('never leaks a local-mode item even if previously shared', () => {
      // A type flipped to local should be removed from the room, not re-pushed.
      expect(decideBackfillAction({ mode: 'local', scope: 'project' }, flagged, true)).toBe('delete');
      expect(decideBackfillAction({ mode: 'local', scope: 'project' }, flagged, false)).toBe('skip');
    });
  });
});
