import { describe, it, expect, beforeEach, vi } from 'vitest';

const updateMetadata = vi.fn();

vi.mock('@nimbalyst/runtime', () => ({
  AISessionsRepository: {
    updateMetadata: (...args: unknown[]) => updateMetadata(...args),
  },
}));
vi.mock('../../SyncManager', () => ({ getSyncProvider: () => null }));
vi.mock('../../../utils/logger', () => ({
  logger: { main: { warn: vi.fn(), info: vi.fn() } },
}));

import {
  getSessionsWithPendingPrompt,
  resetPendingPromptTracking,
  setSessionPendingPrompt,
} from '../pendingPromptPersistence';

describe('pending-prompt in-memory mirror (NIM-2208)', () => {
  beforeEach(() => {
    resetPendingPromptTracking();
    updateMetadata.mockReset().mockResolvedValue(undefined);
  });

  it('tracks sessions as the bit is set and cleared', async () => {
    expect(getSessionsWithPendingPrompt()).toEqual([]);

    await setSessionPendingPrompt('s1', true);
    await setSessionPendingPrompt('s2', true);
    expect(getSessionsWithPendingPrompt().sort()).toEqual(['s1', 's2']);

    await setSessionPendingPrompt('s1', false);
    expect(getSessionsWithPendingPrompt()).toEqual(['s2']);
  });

  it('does not double-count a session whose bit is set twice', async () => {
    await setSessionPendingPrompt('s1', true);
    await setSessionPendingPrompt('s1', true);
    expect(getSessionsWithPendingPrompt()).toEqual(['s1']);
  });

  it('does not track a session whose write failed', async () => {
    // The mirror stands in for the DB during the reconcile, so it must not claim
    // a bit that was never persisted.
    updateMetadata.mockRejectedValueOnce(new Error('db down'));
    await setSessionPendingPrompt('s1', true);
    expect(getSessionsWithPendingPrompt()).toEqual([]);
  });

  it('ignores an empty session id', async () => {
    await setSessionPendingPrompt('', true);
    expect(getSessionsWithPendingPrompt()).toEqual([]);
    expect(updateMetadata).not.toHaveBeenCalled();
  });
});
