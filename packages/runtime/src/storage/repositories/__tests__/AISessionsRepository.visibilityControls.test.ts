import { afterEach, describe, expect, it, vi } from 'vitest';

import { AISessionsRepository } from '../AISessionsRepository';

describe('AISessionsRepository visibility-control primitives', () => {
  afterEach(() => {
    AISessionsRepository.configureVisibilityStorageFence(null);
    AISessionsRepository.clearStore();
  });

  it('passes only the exact pin payload plus host operation identity to the atomic store seam', async () => {
    const applyVisibilityMutation = vi.fn().mockResolvedValue(true);
    AISessionsRepository.setStore({ applyVisibilityMutation } as any);

    await AISessionsRepository.setPinnedVisibility(
      'target', true, 'audit-pin', false, 'C:\\Repo', 'c:/repo',
    );

    expect(applyVisibilityMutation).toHaveBeenCalledWith('target', {
      mutationId: 'audit-pin',
      workspacePath: 'C:\\Repo',
      workspaceComparisonPath: 'c:/repo',
      operation: 'session_set_pinned',
      expected: { isPinned: false },
      after: { isPinned: true },
    });
  });

  it('puts workstream destination validation in the same store mutation', async () => {
    const applyVisibilityMutation = vi.fn().mockResolvedValue(true);
    AISessionsRepository.setStore({ applyVisibilityMutation } as any);

    await AISessionsRepository.setWorkstreamMembershipIfDestinationValid(
      'target', 'workstream', 'audit-parent', null, 'C:\\Repo', 'c:/repo',
    );

    expect(applyVisibilityMutation).toHaveBeenCalledWith('target', {
      mutationId: 'audit-parent',
      workspacePath: 'C:\\Repo',
      workspaceComparisonPath: 'c:/repo',
      operation: 'session_set_workstream',
      expected: { parentSessionId: null },
      after: { parentSessionId: 'workstream' },
      destinationSessionId: 'workstream',
    });
  });

  it('fails closed when the storage CAS rejects an intervening writer', async () => {
    AISessionsRepository.setStore({
      applyVisibilityMutation: vi.fn().mockResolvedValue(false),
    } as any);

    await expect(AISessionsRepository.renameExactSession(
      'target', 'Exact name', 'audit-rename',
      { title: 'Before', hasBeenNamed: false }, 'C:\\Repo', 'c:/repo',
    )).rejects.toThrow('SESSION_VISIBILITY_CAS_CONFLICT');
  });

  it('carries the canonical database fence non-enumerably to the store CAS seam', async () => {
    AISessionsRepository.configureVisibilityStorageFence({
      rootIdentity: 'physical-dev:inode',
      ownerId: 'owner-a',
    });
    const applyVisibilityMutation = vi.fn(async (_sessionId, mutation) => {
      expect(Object.keys(mutation)).not.toContain('visibilityStorageFence');
      const fence = (mutation as any)[Symbol.for('nimbalyst.visibility-storage-fence')];
      expect(fence).toMatchObject({
        rootIdentity: 'physical-dev:inode',
        ownerId: 'owner-a',
      });
      return true;
    });
    AISessionsRepository.setStore({ applyVisibilityMutation } as any);

    await AISessionsRepository.setPinnedVisibility(
      'target', true, 'audit-fenced', false, 'C:\\Repo', 'c:/repo',
    );

    expect(JSON.stringify(applyVisibilityMutation.mock.calls[0][1]))
      .not.toContain('visibility-storage-fence');
  });

  it('delegates recovery attribution to the durable store identity', async () => {
    const hasVisibilityMutation = vi.fn().mockResolvedValue(true);
    AISessionsRepository.setStore({ hasVisibilityMutation } as any);

    await expect(AISessionsRepository.hasVisibilityMutation(
      'target', 'audit-1', 'exact-mutation-fingerprint',
    )).resolves.toBe(true);
    expect(hasVisibilityMutation).toHaveBeenCalledWith(
      'target', 'audit-1', 'exact-mutation-fingerprint',
    );
  });

  it('serializes an existing-ID create with the same visibility writer protocol', async () => {
    let releaseCreate!: () => void;
    const createGate = new Promise<void>((resolve) => { releaseCreate = resolve; });
    let createReached!: () => void;
    const atCreate = new Promise<void>((resolve) => { createReached = resolve; });
    const create = vi.fn(async () => { createReached(); await createGate; });
    const applyVisibilityMutation = vi.fn().mockResolvedValue(true);
    AISessionsRepository.setStore({ create, applyVisibilityMutation } as any);

    const staleUpsert = AISessionsRepository.create({
      id: 'target', provider: 'claude-code', workspaceId: 'C:\\Repo',
    });
    await atCreate;
    const visibilityWrite = AISessionsRepository.setPinnedVisibility(
      'target', true, 'audit-after-create', false, 'C:\\Repo', 'c:/repo',
    );
    await Promise.resolve();
    expect(applyVisibilityMutation).not.toHaveBeenCalled();

    releaseCreate();
    await staleUpsert;
    await visibilityWrite;
    expect(applyVisibilityMutation).toHaveBeenCalledTimes(1);
  });
});
