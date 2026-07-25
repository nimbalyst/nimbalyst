import { createStore } from 'jotai';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { trackerPersonalStateService } from '../../../services/RendererTrackerPersonalStateService';
import {
  applyTrackerPersonalStateRowAtom,
  hydrateTrackerPersonalStateAtom,
  trackerPersonalStateAtom,
} from '../trackerPersonalState';

vi.mock('../../../services/RendererTrackerPersonalStateService', () => ({
  trackerPersonalStateService: {
    getForScope: vi.fn(),
    setFavorite: vi.fn(),
    recordOpened: vi.fn(),
  },
}));

const getForScope = vi.mocked(trackerPersonalStateService.getForScope);

describe('tracker personal state atoms', () => {
  beforeEach(() => vi.clearAllMocks());

  it('accepts inbound state for the stable project scope across workspace paths and rejects another project', async () => {
    getForScope.mockResolvedValue({ scope: 'org:org-1:tracker:project-1', rows: [] });
    const state = createStore();

    await state.set(hydrateTrackerPersonalStateAtom, {
      workspacePath: '/machine-a/repo',
      identityEmail: 'me@example.com',
    });
    await state.set(hydrateTrackerPersonalStateAtom, {
      workspacePath: '/machine-b/repo-worktree',
      identityEmail: 'me@example.com',
    });

    state.set(applyTrackerPersonalStateRowAtom, {
      userEmail: 'me@example.com', scope: 'org:org-1:tracker:project-1', itemId: 'NIM-1',
      isFavorite: true, favoriteUpdatedAt: 10, lastOpenedAt: null, snoozedUntil: null, updatedAt: 10,
    });
    state.set(applyTrackerPersonalStateRowAtom, {
      userEmail: 'me@example.com', scope: 'org:org-1:tracker:project-2', itemId: 'NIM-2',
      isFavorite: true, favoriteUpdatedAt: 20, lastOpenedAt: null, snoozedUntil: null, updatedAt: 20,
    });

    expect(state.get(trackerPersonalStateAtom).rowsByItemId.has('NIM-1')).toBe(true);
    expect(state.get(trackerPersonalStateAtom).rowsByItemId.has('NIM-2')).toBe(false);
  });

  it('merges favorite and last-opened timestamps independently', async () => {
    getForScope.mockResolvedValue({ scope: 'org:org-1:tracker:project-1', rows: [{
      userEmail: 'me@example.com', scope: 'org:org-1:tracker:project-1', itemId: 'NIM-1',
      isFavorite: true, favoriteUpdatedAt: 100, lastOpenedAt: 50, snoozedUntil: null, updatedAt: 100,
    }] });
    const state = createStore();
    await state.set(hydrateTrackerPersonalStateAtom, {
      workspacePath: '/machine-a/repo', identityEmail: 'me@example.com',
    });

    state.set(applyTrackerPersonalStateRowAtom, {
      userEmail: 'me@example.com', scope: 'org:org-1:tracker:project-1', itemId: 'NIM-1',
      isFavorite: false, favoriteUpdatedAt: 90, lastOpenedAt: 200, snoozedUntil: null, updatedAt: 200,
    });

    expect(state.get(trackerPersonalStateAtom).rowsByItemId.get('NIM-1')).toMatchObject({
      isFavorite: true,
      favoriteUpdatedAt: 100,
      lastOpenedAt: 200,
      updatedAt: 200,
    });
  });
});
