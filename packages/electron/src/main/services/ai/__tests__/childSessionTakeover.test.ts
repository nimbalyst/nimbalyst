import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@nimbalyst/runtime', () => ({
  AISessionsRepository: {
    updateMetadata: vi.fn(),
  },
}));

vi.mock('../../../database/PGLiteDatabaseWorker', () => ({
  database: {
    query: vi.fn(),
  },
}));

import { AISessionsRepository } from '@nimbalyst/runtime';
import { database } from '../../../database/PGLiteDatabaseWorker';
import { disableParentNotificationsAfterDirectTakeover } from '../childSessionTakeover';

describe('disableParentNotificationsAfterDirectTakeover', () => {
  beforeEach(() => {
    vi.mocked(AISessionsRepository.updateMetadata).mockReset();
    vi.mocked(database.query).mockReset();
  });

  it('does nothing when the session has no parent', async () => {
    await disableParentNotificationsAfterDirectTakeover({
      id: 'child-1',
      createdBySessionId: null,
      metadata: {},
    } as any);

    expect(AISessionsRepository.updateMetadata).not.toHaveBeenCalled();
    expect(database.query).not.toHaveBeenCalled();
  });

  it('does nothing when parent notifications are already disabled', async () => {
    await disableParentNotificationsAfterDirectTakeover({
      id: 'child-2',
      createdBySessionId: 'parent-2',
      metadata: { notifyParent: false },
    } as any);

    expect(AISessionsRepository.updateMetadata).not.toHaveBeenCalled();
    expect(database.query).not.toHaveBeenCalled();
  });

  it('disables parent notifications and clears pending child updates', async () => {
    await disableParentNotificationsAfterDirectTakeover({
      id: 'child-3',
      createdBySessionId: 'parent-3',
      metadata: { notifyParent: true },
    } as any);

    expect(AISessionsRepository.updateMetadata).toHaveBeenCalledWith('child-3', {
      metadata: {
        notifyParent: false,
        notifyParentDisabledBy: 'child-user-takeover',
      },
    });
    expect(database.query).toHaveBeenCalledWith(
      `DELETE FROM queued_prompts
     WHERE session_id = $1
       AND status = 'pending'
       AND prompt LIKE '[Child Session Update]%'
       AND prompt LIKE $2`,
      ['parent-3', '%(child-3)%']
    );
  });
});
