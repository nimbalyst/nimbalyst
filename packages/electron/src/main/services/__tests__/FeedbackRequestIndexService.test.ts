// @vitest-environment node
import { asTeamJwt, asTeamMemberId } from '@nimbalyst/runtime/auth/jwtScopes';
import type { FeedbackRequestIndexEntry } from '@nimbalyst/collab-protocol';
import { describe, expect, it, vi } from 'vitest';

import {
  FeedbackRequestIndexService,
  runFeedbackRequestIndexBackfill,
} from '../FeedbackRequestIndexService';
import type { FeedbackRequestIndexPersistence } from '../FeedbackRequestIndexPersistence';

const target = {
  workspacePath: '/workspace/a',
  orgId: 'org-a',
  teamMemberId: asTeamMemberId('member-a'),
};

describe('feedback request index backfill', () => {
  it('resumes after interruption and stays complete on later launches', async () => {
    let cursorRequestId: string | undefined;
    let completedAt: number | undefined;
    const requestIds = ['request-a', 'request-b', 'request-c'];
    const persistence = {
      getOrCreateBackfillState: vi.fn(async () => ({
        cutoffAt: 100,
        ...(cursorRequestId ? { cursorRequestId } : {}),
        ...(completedAt ? { completedAt } : {}),
      })),
      getBackfillBatch: vi.fn(async () => requestIds.filter(
        (requestId) => requestId > (cursorRequestId ?? ''),
      )),
      advanceBackfillCursor: vi.fn(async (_target, requestId: string) => {
        cursorRequestId = requestId;
      }),
      completeBackfill: vi.fn(async () => {
        completedAt = 200;
      }),
    } as unknown as FeedbackRequestIndexPersistence;
    const pinged: string[] = [];
    let interruptOnce = true;
    const dependencies = {
      getTeamJwt: vi.fn(async () => asTeamJwt('team-jwt')),
      getTeamMemberId: vi.fn(() => asTeamMemberId('member-a')),
      persistence,
      pingRequestRoom: vi.fn(async (request, getTeamJwt) => {
        await getTeamJwt();
        pinged.push(request.requestId);
        if (request.requestId === 'request-b' && interruptOnce) {
          interruptOnce = false;
          throw new Error('interrupted');
        }
      }),
      yieldBetweenBackfillBatches: vi.fn(async () => undefined),
    };

    await expect(runFeedbackRequestIndexBackfill(target, dependencies))
      .rejects.toThrow('interrupted');
    expect(cursorRequestId).toBe('request-a');

    await runFeedbackRequestIndexBackfill(target, dependencies);
    expect(pinged).toEqual([
      'request-a',
      'request-b',
      'request-b',
      'request-c',
    ]);
    expect(completedAt).toBe(200);

    await runFeedbackRequestIndexBackfill(target, dependencies);
    expect(pinged).toHaveLength(4);
    expect(persistence.completeBackfill).toHaveBeenCalledTimes(1);
  });

  it('coalesces broadcast writes and keeps only the newest request version', async () => {
    let flush: (() => void) | undefined;
    const upsertEntries = vi.fn(async (
      _target: typeof target,
      _entries: FeedbackRequestIndexEntry[],
    ) => undefined);
    const persistence = {
      upsertEntries,
      list: vi.fn(async () => []),
    } as unknown as FeedbackRequestIndexPersistence;
    const service = new FeedbackRequestIndexService({
      getTeamJwt: vi.fn(async () => asTeamJwt('team-jwt')),
      getTeamMemberId: vi.fn(() => asTeamMemberId('member-a')),
      persistence,
      pingRequestRoom: vi.fn(async () => undefined),
      scheduleMaintenance: vi.fn(),
      setTimer: vi.fn((callback) => {
        flush = callback;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      }),
      clearTimer: vi.fn(),
    });
    const base = {
      urn: 'nimbalyst://feedback-request/request-a' as const,
      orgId: 'org-a',
      author: { kind: 'user' as const, onBehalfOfUserId: 'author-a' },
      recipients: [],
      lifecycle: { status: 'open' as const, changedAt: 1 },
      progress: {
        answeredAskCount: 0,
        totalAssignedAskCount: 0,
        answeredRecipientCount: 0,
        totalRecipientCount: 0,
        quorumReached: false,
      },
      subjects: [],
      createdAt: 1,
    };
    const input = (updatedAt: number, title: string) => ({
      target: { workspacePath: '/workspace/a', orgId: 'org-a' },
      teamMemberId: asTeamMemberId('member-a'),
      entry: {
        ...base,
        requestId: 'request-a',
        title,
        updatedAt,
      },
    });

    await service.enqueueUpsert(input(20, 'newest'));
    await service.enqueueUpsert(input(10, 'stale'));
    flush?.();
    await vi.waitFor(() => expect(upsertEntries).toHaveBeenCalledOnce());

    expect(upsertEntries.mock.calls[0]?.[1]).toEqual([
      expect.objectContaining({ title: 'newest', updatedAt: 20 }),
    ]);
    service.destroy();
  });

  it('does not emit an old viewer snapshot when identity changes during the read', async () => {
    let teamMemberId = asTeamMemberId('member-a');
    let resolveList: (() => void) | undefined;
    const persistence = {
      list: vi.fn(() => new Promise<FeedbackRequestIndexEntry[]>((resolve) => {
        resolveList = () => resolve([]);
      })),
    } as unknown as FeedbackRequestIndexPersistence;
    const service = new FeedbackRequestIndexService({
      getTeamJwt: vi.fn(async () => asTeamJwt('team-jwt')),
      getTeamMemberId: vi.fn(() => teamMemberId),
      persistence,
      pingRequestRoom: vi.fn(async () => undefined),
      scheduleMaintenance: vi.fn(),
    });
    const listener = vi.fn();
    service.subscribe(listener);

    const listing = service.list({ workspacePath: target.workspacePath, orgId: target.orgId });
    await vi.waitFor(() => expect(persistence.list).toHaveBeenCalledOnce());
    teamMemberId = asTeamMemberId('member-b');
    resolveList?.();

    await expect(listing).rejects.toThrow('team identity changed');
    expect(listener).not.toHaveBeenCalled();
    service.destroy();
  });

  it('retains a coalesced update after a transient persistence failure', async () => {
    const timers: Array<() => void> = [];
    const upsertEntries = vi.fn()
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValue(undefined);
    const persistence = {
      upsertEntries,
      list: vi.fn(async () => []),
    } as unknown as FeedbackRequestIndexPersistence;
    const service = new FeedbackRequestIndexService({
      getTeamJwt: vi.fn(async () => asTeamJwt('team-jwt')),
      getTeamMemberId: vi.fn(() => asTeamMemberId('member-a')),
      persistence,
      pingRequestRoom: vi.fn(async () => undefined),
      scheduleMaintenance: vi.fn(),
      setTimer: vi.fn((callback) => {
        timers.push(callback);
        return timers.length as unknown as ReturnType<typeof setTimeout>;
      }),
      clearTimer: vi.fn(),
    });
    const makeInput = (requestId: string) => ({
      target: { workspacePath: target.workspacePath, orgId: target.orgId },
      teamMemberId: target.teamMemberId,
      entry: {
        requestId,
        urn: `nimbalyst://feedback-request/${requestId}` as const,
        orgId: target.orgId,
        title: requestId,
        author: { kind: 'user' as const, onBehalfOfUserId: 'author-a' },
        recipients: [],
        lifecycle: { status: 'open' as const, changedAt: 1 },
        progress: {
          answeredAskCount: 0,
          totalAssignedAskCount: 0,
          answeredRecipientCount: 0,
          totalRecipientCount: 0,
          quorumReached: false,
        },
        subjects: [],
        createdAt: 1,
        updatedAt: 1,
      },
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await service.enqueueUpsert(makeInput('request-a'));
    timers.shift()?.();
    await vi.waitFor(() => expect(upsertEntries).toHaveBeenCalledTimes(1));
    await service.enqueueUpsert(makeInput('request-b'));
    timers.shift()?.();
    await vi.waitFor(() => expect(upsertEntries).toHaveBeenCalledTimes(2));

    expect(upsertEntries.mock.calls[1]?.[1]
      .map((entry: FeedbackRequestIndexEntry) => entry.requestId).sort())
      .toEqual(['request-a', 'request-b']);
    consoleError.mockRestore();
    service.destroy();
  });
});
