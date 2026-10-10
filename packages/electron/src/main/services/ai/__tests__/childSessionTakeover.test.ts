// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({
  AISessionsRepository: {
    updateMetadata: vi.fn(),
  },
}));

vi.mock('../../../database/PGLiteDatabaseWorker', () => ({
  database: {
    query: vi.fn(),
  },
}));

import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import { database } from '../../../database/PGLiteDatabaseWorker';
import { disableParentNotificationsAfterDirectTakeover } from '../childSessionTakeover';
import { deletePendingChildUpdates } from '../pendingChildUpdates';

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

  it('leaves a child whose owner routes its settles to itself alone', async () => {
    await disableParentNotificationsAfterDirectTakeover({
      id: 'child-owned',
      createdBySessionId: 'parent-owned',
      metadata: { sessionOwner: { extensionId: 'com.example.owner', key: 'ada', routeChildUpdatesToOwner: true } },
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
      expect.stringContaining('DELETE FROM queued_prompts'),
      ['parent-3', '%(child-3)%']
    );
  });
});

describe('deletePendingChildUpdates', () => {
  beforeEach(() => {
    vi.mocked(database.query).mockReset();
  });

  // Superseding must not reach past its own child or past rows already handed
  // to the agent: deleting an `executing` row would strand a turn in flight,
  // and an unscoped delete would silently drop sibling children's updates.
  it('deletes only pending child-update rows for the named child on the named parent', async () => {
    await deletePendingChildUpdates('parent-9', 'child-9');

    expect(database.query).toHaveBeenCalledTimes(1);
    const [sql, params] = vi.mocked(database.query).mock.calls[0];

    expect(sql).toContain("status = 'pending'");
    expect(sql).toContain("prompt LIKE '[Child Session Update]%'");
    expect(sql).not.toContain('executing');
    expect(params).toEqual(['parent-9', '%(child-9)%']);
  });
});
