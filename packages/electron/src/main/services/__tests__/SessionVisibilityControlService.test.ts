import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../../utils/logger', () => ({
  logger: { store: { info: vi.fn() } },
}));

import {
  SessionVisibilityControlError,
  SessionVisibilityControlService,
  captureSessionAuthoritySnapshot,
  createSessionVisibilityAuditSink,
  type SessionVisibilityAuditEvent,
  type SessionVisibilityContext,
} from '../SessionVisibilityControlService';
import { SessionVisibilityConvergenceOutbox } from '../SessionVisibilityConvergenceOutbox';

const WORKSPACE = 'C:\\repo';
const OTHER_WORKSPACE = 'C:\\other';

function session(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    provider: 'claude-code',
    model: 'claude-code:opus',
    sessionType: 'session',
    agentRole: 'standard',
    createdBySessionId: 'owner',
    messages: [{ id: 1, text: 'secret prompt' }],
    workspacePath: WORKSPACE,
    worktreeId: undefined,
    worktreePath: undefined,
    worktreeProjectPath: undefined,
    parentSessionId: null,
    title: `${id} title`,
    hasBeenNamed: false,
    isPinned: false,
    isArchived: false,
    mode: 'agent',
    metadata: {
      phase: 'validating',
      tags: ['nim-366'],
      activeTurnId: 'turn-1',
      queuedPromptIds: ['queued-1'],
    },
    providerSessionId: 'provider-session',
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  } as any;
}

function context(overrides: Partial<SessionVisibilityContext> = {}): SessionVisibilityContext {
  return {
    actorSessionId: 'actor',
    workspacePath: WORKSPACE,
    source: 'mcp-host',
    correlationId: 'correlation-1',
    ...overrides,
  };
}

function fixture(initial: any[], options: {
  rateLimitMax?: number;
  failAuditAttempts?: number;
  failBroadcastAttempts?: number;
  failCommitJournal?: boolean;
  failReloadAfterCommit?: boolean;
  hangReplayFlush?: boolean;
  assertStorageRootOwnership?: () => void;
  withStorageRootWriteFence?: <T>(work: () => Promise<T>) => Promise<T>;
  reserveMutation?: (intent: any) => Promise<void>;
} = {}) {
  const rows = new Map(initial.map((item) => [item.id, structuredClone(item)]));
  const writes: Array<{ operation: string; sessionId: string; value: unknown }> = [];
  const audits: SessionVisibilityAuditEvent[] = [];
  const broadcasts: Array<{ channel: string; args: unknown[] }> = [];
  const pendingAudits: SessionVisibilityAuditEvent[] = [];
  const pendingDeliveries: any[] = [];
  const mutationIntents: any[] = [];
  const abortedMutationIds: string[] = [];
  const operationOrder: string[] = [];
  const appliedMutationIds = new Map<string, Set<string>>();
  let nextId = 0;
  let remainingAuditFailures = options.failAuditAttempts ?? 0;
  let remainingBroadcastFailures = options.failBroadcastAttempts ?? 0;

  const repository = {
    get: vi.fn(async (id: string) => {
      const value = rows.get(id);
      return value ? structuredClone(value) : null;
    }),
    setPinnedVisibility: vi.fn(async (id: string, pinned: boolean, mutationId: string) => {
      operationOrder.push('repository-write');
      writes.push({ operation: 'pin', sessionId: id, value: pinned });
      rows.set(id, { ...rows.get(id), isPinned: pinned });
      const ids = appliedMutationIds.get(id) ?? new Set<string>();
      ids.add(mutationId);
      appliedMutationIds.set(id, ids);
    }),
    setWorkstreamMembership: vi.fn(async (
      id: string, parentSessionId: string | null, mutationId: string,
    ) => {
      writes.push({ operation: 'workstream', sessionId: id, value: parentSessionId });
      rows.set(id, { ...rows.get(id), parentSessionId });
      const ids = appliedMutationIds.get(id) ?? new Set<string>();
      ids.add(mutationId);
      appliedMutationIds.set(id, ids);
    }),
    setWorkstreamMembershipIfDestinationValid: vi.fn(async (
      id: string,
      parentSessionId: string,
      mutationId: string,
      _expectedParentSessionId: string | null,
      workspacePath: string,
    ) => {
      const destination = rows.get(parentSessionId);
      if (
        !destination || destination.workspacePath !== workspacePath ||
        destination.sessionType !== 'workstream' || destination.parentSessionId ||
        destination.worktreeId || destination.isArchived === true
      ) {
        throw new Error('WORKSTREAM_DESTINATION_CHANGED');
      }
      writes.push({ operation: 'workstream', sessionId: id, value: parentSessionId });
      rows.set(id, { ...rows.get(id), parentSessionId });
      const ids = appliedMutationIds.get(id) ?? new Set<string>();
      ids.add(mutationId);
      appliedMutationIds.set(id, ids);
    }),
    renameExactSession: vi.fn(async (id: string, name: string, mutationId: string) => {
      writes.push({ operation: 'rename', sessionId: id, value: name });
      rows.set(id, { ...rows.get(id), title: name, hasBeenNamed: true });
      const ids = appliedMutationIds.get(id) ?? new Set<string>();
      ids.add(mutationId);
      appliedMutationIds.set(id, ids);
    }),
    hasVisibilityMutation: vi.fn(async (id: string, mutationId: string) => (
      appliedMutationIds.get(id)?.has(mutationId) === true
    )),
  };

  const service = new SessionVisibilityControlService({
    repository,
    audit: async (event) => {
      if (remainingAuditFailures > 0) {
        remainingAuditFailures -= 1;
        throw new Error('audit unavailable');
      }
      audits.push(event);
    },
    broadcast: (_workspacePath, channel, ...args) => {
      if (remainingBroadcastFailures > 0) {
        remainingBroadcastFailures -= 1;
        throw new Error('renderer unavailable');
      }
      broadcasts.push({ channel, args });
    },
    now: () => 1_721_350_800_000,
    randomId: () => `audit-${++nextId}`,
    rateLimitMax: options.rateLimitMax,
    convergenceOutbox: {
      start: async () => undefined,
      reserveMutation: async (intent: any) => {
        operationOrder.push('reserve-intent');
        mutationIntents.push(structuredClone(intent));
        await options.reserveMutation?.(intent);
      },
      markMutationCommitted: async () => {
        operationOrder.push('mark-committed');
        if (options.failCommitJournal) throw new Error('journal unavailable after commit');
      },
      markMutationAborted: async (auditId: string) => { abortedMutationIds.push(auditId); },
      acknowledgeMutationAudit: async () => undefined,
      acknowledgeMutationDelivery: async () => undefined,
      enqueueAudit: async (event) => { pendingAudits.push(structuredClone(event)); },
      enqueueDelivery: async (descriptor) => { pendingDeliveries.push(structuredClone(descriptor)); },
      flush: options.hangReplayFlush
        ? vi.fn(() => new Promise<void>(() => undefined))
        : vi.fn(async () => undefined),
      close: async () => undefined,
    },
    assertStorageRootOwnership: options.assertStorageRootOwnership,
    withStorageRootWriteFence: options.withStorageRootWriteFence,
  });

  return {
    service, repository, rows, writes, audits, broadcasts,
    pendingAudits, pendingDeliveries, mutationIntents, operationOrder,
    abortedMutationIds,
  };
}

async function eventually(assertion: () => void, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}

describe('SessionVisibilityControlService', () => {
  it('fails closed before repository access after its storage-root fence is lost', async () => {
    let ownsRoot = true;
    const f = fixture([session('actor'), session('target')], {
      assertStorageRootOwnership: () => {
        if (!ownsRoot) throw new Error('storage root ownership lost');
      },
    });
    ownsRoot = false;

    await expect(f.service.setPinned(context(), 'target', true))
      .rejects.toThrow('storage root ownership lost');
    expect(f.repository.get).not.toHaveBeenCalled();
    expect(f.service.acknowledgeRendererDelivery('audit-1', WORKSPACE)).toBe(false);
  });

  it('reasserts the root nonce after an awaited reservation before the repository write', async () => {
    let ownsRoot = true;
    let releaseReservation!: () => void;
    const reservationGate = new Promise<void>((resolve) => { releaseReservation = resolve; });
    let reservationReached!: () => void;
    const atReservation = new Promise<void>((resolve) => { reservationReached = resolve; });
    const f = fixture([session('actor'), session('target')], {
      assertStorageRootOwnership: () => {
        if (!ownsRoot) throw new Error('storage root ownership lost');
      },
      reserveMutation: async () => {
        reservationReached();
        await reservationGate;
      },
    });

    const mutation = f.service.setPinned(context(), 'target', true);
    await atReservation;
    ownsRoot = false;
    releaseReservation();

    await expect(mutation).rejects.toThrow('storage root ownership lost');
    expect(f.repository.setPinnedVisibility).not.toHaveBeenCalled();
    expect(f.rows.get('target')?.isPinned).toBe(false);
  });

  it('aborts the durable reservation truthfully when the protected write fence rejects', async () => {
    const f = fixture([session('actor'), session('target')], {
      withStorageRootWriteFence: async () => {
        throw new Error('storage root ownership was lost before commit');
      },
    });

    await expect(f.service.setPinned(context(), 'target', true))
      .rejects.toThrow('storage root ownership was lost before commit');
    expect(f.repository.setPinnedVisibility).not.toHaveBeenCalled();
    expect(f.rows.get('target')?.isPinned).toBe(false);
    expect(f.abortedMutationIds).toEqual(['audit-1']);
  });

  it('keeps a rejected database-fence CAS as an aborted, never-committed reservation', async () => {
    const f = fixture([session('actor'), session('target')]);
    f.repository.setPinnedVisibility.mockRejectedValueOnce(
      new Error('SESSION_VISIBILITY_CAS_CONFLICT'),
    );

    await expect(f.service.setPinned(context(), 'target', true))
      .rejects.toThrow('SESSION_VISIBILITY_CAS_CONFLICT');
    expect(f.rows.get('target')?.isPinned).toBe(false);
    expect(f.abortedMutationIds).toEqual(['audit-1']);
    expect(f.operationOrder).not.toContain('mark-committed');
  });

  it('does not await a permanently hung historical replay before a foreground mutation', async () => {
    const f = fixture([session('actor'), session('target')], { hangReplayFlush: true });

    await expect(f.service.setPinned(context(), 'target', true)).resolves.toMatchObject({
      ok: true,
      changed: true,
      after: { pinned: true },
    });
    expect(f.rows.get('target')?.isPinned).toBe(true);
  });

  it('keeps marker absence nonterminal during reserve -> live flush -> foreground commit', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nim-366-live-reservation-'));
    const filePath = path.join(directory, 'convergence.jsonl');
    const f = fixture([session('actor'), session('target')]);
    const originalWrite = f.repository.setPinnedVisibility.getMockImplementation()!;
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
    let writeReached!: () => void;
    const atWrite = new Promise<void>((resolve) => { writeReached = resolve; });
    f.repository.setPinnedVisibility.mockImplementation(async (...args: any[]) => {
      writeReached();
      await writeGate;
      await (originalWrite as (...callArgs: any[]) => Promise<void>)(...args);
    });
    let service!: SessionVisibilityControlService;
    const resolveReservedMutation = vi.fn((intent: any) => (
      service as any
    ).resolveReservedMutation(intent));
    const outbox = new SessionVisibilityConvergenceOutbox({
      filePath,
      retryIntervalMs: 60_000,
      audit: async () => undefined,
      deliver: async () => undefined,
      resolveReservedMutation,
    });
    service = new SessionVisibilityControlService({
      repository: f.repository,
      audit: async () => undefined,
      broadcast: () => undefined,
      convergenceOutbox: outbox,
      reservationOwnerId: 'live-owner',
      randomId: () => 'audit-live-race',
    });

    try {
      const foreground = service.setPinned(context(), 'target', true);
      await atWrite;
      await ((outbox as any).flushInFlight ?? Promise.resolve());
      await outbox.flush();
      expect(await outbox.pendingCount()).toBe(1);
      expect(await readFile(filePath, 'utf8')).not.toContain('"action":"abort"');
      expect(resolveReservedMutation).toHaveBeenCalledTimes(1);
      expect(f.repository.hasVisibilityMutation).not.toHaveBeenCalled();

      releaseWrite();
      await expect(foreground).resolves.toMatchObject({
        ok: true,
        after: { pinned: true },
      });
      expect(f.rows.get('target')?.isPinned).toBe(true);
    } finally {
      releaseWrite();
      await service.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('treats marker absence as aborted only after reconstruction under a new owner', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nim-366-dead-reservation-'));
    const filePath = path.join(directory, 'convergence.jsonl');
    const intent = {
      auditId: 'audit-dead-owner',
      operation: 'session_set_pinned' as const,
      phase: 'reserved' as const,
      reservationOwnerId: 'dead-owner',
      targetSessionId: 'target',
      workspaceId: 'ws-dead-owner',
      beforeStateId: 'before',
      afterStateId: 'after',
      mutationIdentity: 'dead-owner-mutation-identity',
      audit: {
        event: 'session_visibility_control' as const,
        auditId: 'audit-dead-owner',
        timestamp: '2026-07-20T00:00:00.000Z',
        source: 'mcp-host' as const,
        operation: 'session_set_pinned' as const,
        outcome: 'changed' as const,
        actorSessionId: 'actor',
        actorKind: 'session' as const,
        targetSessionId: 'target',
        workspaceId: 'ws-dead-owner',
        before: { pinned: false },
        after: { pinned: true },
        reasonCode: null,
        correlationId: 'crash-control',
      },
      delivery: null,
    };
    const first = new SessionVisibilityConvergenceOutbox({
      filePath,
      retryIntervalMs: 60_000,
      audit: async () => undefined,
      deliver: async () => undefined,
    });
    await first.reserveMutation(intent);
    await first.close();

    const f = fixture([session('actor'), session('target')]);
    let reconstructedService!: SessionVisibilityControlService;
    const reconstructedOutbox = new SessionVisibilityConvergenceOutbox({
      filePath,
      retryIntervalMs: 10,
      audit: async () => undefined,
      deliver: async () => undefined,
      resolveReservedMutation: (candidate) => (
        reconstructedService as any
      ).resolveReservedMutation(candidate),
    });
    reconstructedService = new SessionVisibilityControlService({
      repository: f.repository,
      audit: async () => undefined,
      convergenceOutbox: reconstructedOutbox,
      reservationOwnerId: 'new-owner',
    });

    try {
      await eventually(() => expect(reconstructedOutbox.pendingCountSync()).toBe(0));
      expect(await readFile(filePath, 'utf8')).toContain('"action":"abort"');
      expect(f.repository.hasVisibilityMutation).toHaveBeenCalledWith(
        'target', 'audit-dead-owner', 'dead-owner-mutation-identity',
      );
    } finally {
      await reconstructedService.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('terminally audits and aborts an actual legacy reservation without inferring visible-state success', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nim-366-legacy-reservation-'));
    const filePath = path.join(directory, 'convergence.jsonl');
    const legacyIntent = {
      auditId: 'audit-legacy-no-fingerprint',
      operation: 'session_set_pinned' as const,
      phase: 'reserved' as const,
      targetSessionId: 'target',
      workspaceId: 'ws-legacy',
      beforeStateId: 'legacy-before',
      afterStateId: 'legacy-after',
      audit: {
        event: 'session_visibility_control' as const,
        auditId: 'audit-legacy-no-fingerprint',
        timestamp: '2026-07-20T00:00:00.000Z',
        source: 'mcp-host' as const,
        operation: 'session_set_pinned' as const,
        outcome: 'changed' as const,
        actorSessionId: 'actor',
        actorKind: 'session' as const,
        targetSessionId: 'target',
        workspaceId: 'ws-legacy',
        before: { pinned: false },
        after: { pinned: true },
        reasonCode: null,
        correlationId: 'legacy-upgrade',
      },
      delivery: null,
    };
    await writeFile(filePath, `${JSON.stringify({
      action: 'reserve',
      entry: {
        id: 'mutation:audit-legacy-no-fingerprint',
        kind: 'mutation',
        payload: legacyIntent,
        phase: 'reserved',
        auditPending: true,
        deliveryPending: false,
      },
    })}\n`, 'utf8');

    const f = fixture([
      session('actor'),
      session('target', { isPinned: true }),
    ]);
    const reconciliationAudits: SessionVisibilityAuditEvent[] = [];
    let reconstructedService!: SessionVisibilityControlService;
    const reconstructedOutbox = new SessionVisibilityConvergenceOutbox({
      filePath,
      retryIntervalMs: 10,
      audit: async (event) => { reconciliationAudits.push(event); },
      deliver: async () => undefined,
      resolveReservedMutation: (candidate) => (
        reconstructedService as any
      ).resolveReservedMutation(candidate),
    });
    reconstructedService = new SessionVisibilityControlService({
      repository: f.repository,
      audit: async () => undefined,
      convergenceOutbox: reconstructedOutbox,
      reservationOwnerId: 'repair6-owner',
    });

    try {
      await eventually(() => expect(reconstructedOutbox.pendingCountSync()).toBe(0));
      expect(reconciliationAudits).toContainEqual(expect.objectContaining({
        auditId: 'audit-legacy-no-fingerprint',
        outcome: 'failed',
        reasonCode: 'INTERNAL_ERROR',
      }));
      expect(f.repository.hasVisibilityMutation).not.toHaveBeenCalled();
      expect(await readFile(filePath, 'utf8')).toContain('"action":"abort"');
      await reconstructedService.close();

      const repeatedAudit = vi.fn(async () => undefined);
      const terminalRestart = new SessionVisibilityConvergenceOutbox({
        filePath,
        retryIntervalMs: 10,
        audit: repeatedAudit,
        deliver: async () => undefined,
      });
      await terminalRestart.start();
      expect(terminalRestart.pendingCountSync()).toBe(0);
      expect(repeatedAudit).not.toHaveBeenCalled();
      await terminalRestart.close();
    } finally {
      await reconstructedService.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('reports delivered only after the exact workspace renderer acknowledges the stable auditId', async () => {
    const f = fixture([session('actor'), session('target')]);
    const wrongWorkspaceAcks: boolean[] = [];
    await f.service.configureHostBroadcast((workspacePath, channel, ...args) => {
      f.broadcasts.push({ channel, args });
      if (channel === 'sessions:visibility-delivery') {
        const marker = args[0] as { auditId: string };
        wrongWorkspaceAcks.push(
          f.service.acknowledgeRendererDelivery(marker.auditId, OTHER_WORKSPACE),
        );
        queueMicrotask(() => f.service.acknowledgeRendererDelivery(marker.auditId, workspacePath));
      }
      return false;
    });

    await expect(f.service.setPinned(context(), 'target', true)).resolves.toMatchObject({
      deliveryStatus: 'delivered',
      after: { pinned: true },
    });
    expect(f.broadcasts.at(-1)).toEqual({
      channel: 'sessions:visibility-delivery',
      args: [expect.objectContaining({ auditId: 'audit-1', workspacePath: WORKSPACE })],
    });
    expect(wrongWorkspaceAcks).toEqual([false]);
  });

  it('pins authoritatively, preserves authority, and makes replays no-ops with fresh audits', async () => {
    const actor = session('actor');
    const target = session('target', { worktreeId: 'wt-1', worktreePath: 'C:\\wt' });
    const f = fixture([actor, target]);
    const authorityBefore = captureSessionAuthoritySnapshot(target, 'session_set_pinned');

    const changed = await f.service.setPinned(context(), 'target', true);
    const replay = await f.service.setPinned(context({ correlationId: 'correlation-2' }), 'target', true);

    expect(changed).toMatchObject({
      ok: true,
      operation: 'session_set_pinned',
      changed: true,
      before: { pinned: false },
      after: { pinned: true },
      auditStatus: 'recorded',
      deliveryStatus: 'delivered',
    });
    expect(replay).toMatchObject({ changed: false, after: { pinned: true } });
    expect(replay.auditId).not.toBe(changed.auditId);
    expect(f.repository.setPinnedVisibility).toHaveBeenCalledTimes(1);
    expect(captureSessionAuthoritySnapshot(f.rows.get('target'), 'session_set_pinned')).toEqual(authorityBefore);
    expect(f.audits.map((event) => event.outcome)).toEqual(['changed', 'noop']);
    expect(f.broadcasts).toEqual([
      {
        channel: 'sessions:session-updated',
        args: ['target', {
          workspacePath: WORKSPACE,
          isPinned: true,
          visibilityAuditId: changed.auditId,
        }],
      },
      {
        channel: 'sessions:visibility-delivery',
        args: [expect.objectContaining({ auditId: changed.auditId, workspacePath: WORKSPACE })],
      },
    ]);
    expect(JSON.stringify(f.audits)).not.toContain(WORKSPACE);
    expect(JSON.stringify(f.audits)).not.toContain('secret prompt');
    expect(JSON.stringify(f.audits)).not.toContain('target title');
  });

  it('returns the same non-enumerating error for missing and cross-workspace targets', async () => {
    const f = fixture([
      session('actor'),
      session('cross-workspace', { workspacePath: OTHER_WORKSPACE }),
    ]);

    for (const id of ['missing', 'cross-workspace']) {
      await expect(f.service.setPinned(context(), id, true)).rejects.toMatchObject({
        code: 'TARGET_NOT_FOUND',
      });
    }

    expect(f.writes).toEqual([]);
    expect(f.audits.map((event) => event.reasonCode)).toEqual([
      'TARGET_NOT_FOUND',
      'TARGET_NOT_FOUND',
    ]);
  });

  it('moves only ordinary non-worktree sessions into root, visible workstreams', async () => {
    const target = session('target');
    const f = fixture([
      session('actor'),
      target,
      session('workstream-a', { sessionType: 'workstream', title: 'A' }),
      session('workstream-b', { sessionType: 'workstream', title: 'B' }),
      session('archived-workstream', { sessionType: 'workstream', isArchived: true }),
    ]);
    const authorityBefore = captureSessionAuthoritySnapshot(target, 'session_set_workstream');

    const intoA = await f.service.setWorkstream(context(), 'target', 'workstream-a');
    const intoB = await f.service.setWorkstream(context(), 'target', 'workstream-b');
    const removed = await f.service.setWorkstream(context(), 'target', null);
    const replay = await f.service.setWorkstream(context(), 'target', null);

    expect(intoA).toMatchObject({
      changed: true,
      before: { workstreamId: null, workstreamTitle: null },
      after: { workstreamId: 'workstream-a', workstreamTitle: 'A' },
    });
    expect(intoB).toMatchObject({
      before: { workstreamId: 'workstream-a', workstreamTitle: 'A' },
      after: { workstreamId: 'workstream-b', workstreamTitle: 'B' },
    });
    expect(removed.after).toEqual({ workstreamId: null, workstreamTitle: null });
    expect(replay.changed).toBe(false);
    expect(f.repository.setWorkstreamMembershipIfDestinationValid).toHaveBeenCalledTimes(2);
    expect(f.repository.setWorkstreamMembership).toHaveBeenCalledTimes(1);
    expect(captureSessionAuthoritySnapshot(f.rows.get('target'), 'session_set_workstream')).toEqual(authorityBefore);

    await expect(
      f.service.setWorkstream(context(), 'target', 'archived-workstream'),
    ).rejects.toMatchObject({ code: 'INVALID_WORKSTREAM_TARGET' });
  });

  it.each([
    ['worktree target', session('target', { worktreeId: 'wt-1' }), session('destination', { sessionType: 'workstream' })],
    ['container target', session('target', { sessionType: 'workstream' }), session('destination', { sessionType: 'workstream' })],
    ['standalone destination', session('target'), session('destination')],
    ['nested destination', session('target'), session('destination', { sessionType: 'workstream', parentSessionId: 'root' })],
    ['worktree destination', session('target'), session('destination', { sessionType: 'workstream', worktreeId: 'wt-1' })],
  ])('rejects invalid workstream structure: %s', async (_label, target, destination) => {
    const f = fixture([session('actor'), target, destination]);
    await expect(
      f.service.setWorkstream(context(), 'target', 'destination'),
    ).rejects.toMatchObject({ code: 'INVALID_WORKSTREAM_TARGET' });
    expect(f.writes).toEqual([]);
  });

  it('serializes concurrent mutations for one target and returns observed authoritative states', async () => {
    const f = fixture([
      session('actor'),
      session('target'),
      session('workstream-a', { sessionType: 'workstream', title: 'A' }),
      session('workstream-b', { sessionType: 'workstream', title: 'B' }),
    ]);
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let markFirstWriteStarted!: () => void;
    const firstWriteStarted = new Promise<void>((resolve) => { markFirstWriteStarted = resolve; });
    let writes = 0;
    f.repository.setWorkstreamMembershipIfDestinationValid.mockImplementation(async (id: string, parent: string) => {
      writes += 1;
      if (writes === 1) {
        markFirstWriteStarted();
        await firstBlocked;
      }
      f.rows.set(id, { ...f.rows.get(id), parentSessionId: parent });
    });

    const aPromise = f.service.setWorkstream(context({ correlationId: 'a' }), 'target', 'workstream-a');
    const bPromise = f.service.setWorkstream(context({ correlationId: 'b' }), 'target', 'workstream-b');
    await firstWriteStarted;
    expect(writes).toBe(1);
    releaseFirst();
    const [a, b] = await Promise.all([aPromise, bPromise]);

    expect(a.before).toMatchObject({ workstreamId: null });
    expect(a.after).toMatchObject({ workstreamId: 'workstream-a' });
    expect(b.before).toMatchObject({ workstreamId: 'workstream-a' });
    expect(b.after).toMatchObject({ workstreamId: 'workstream-b' });
  });

  it('does not commit when destination authority changes after validation but before membership write', async () => {
    const f = fixture([
      session('actor'),
      session('target'),
      session('destination', { sessionType: 'workstream' }),
    ]);
    let beginConcurrentChange!: () => void;
    const changeStarted = new Promise<void>((resolve) => { beginConcurrentChange = resolve; });
    let releaseValidation!: () => void;
    const validationReleased = new Promise<void>((resolve) => { releaseValidation = resolve; });
    f.repository.setWorkstreamMembershipIfDestinationValid.mockImplementation(async () => {
      beginConcurrentChange();
      await validationReleased;
      const destination = f.rows.get('destination');
      if (destination?.isArchived) throw new Error('WORKSTREAM_DESTINATION_CHANGED');
      f.rows.set('target', { ...f.rows.get('target'), parentSessionId: 'destination' });
    });

    const mutation = f.service.setWorkstream(context(), 'target', 'destination');
    await changeStarted;
    f.rows.set('destination', { ...f.rows.get('destination'), isArchived: true });
    releaseValidation();

    await expect(mutation).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(f.rows.get('target')?.parentSessionId).toBeNull();
  });

  it('keeps a committed mutation successful and convergent across concurrent volatile updates', async () => {
    const target = session('target');
    const authorityBefore = captureSessionAuthoritySnapshot(target, 'session_set_pinned');
    const f = fixture([session('actor'), target]);
    f.repository.setPinnedVisibility.mockImplementation(async (id: string, pinned: boolean) => {
      f.rows.set(id, {
        ...f.rows.get(id),
        isPinned: pinned,
        updatedAt: 999,
        messages: [{ id: 2, text: 'concurrent response' }],
        metadata: { phase: 'running', unrelated: true },
        lastDocumentState: { filePath: 'C:\\repo\\note.md', contentHash: 'new' },
      });
    });

    const result = await f.service.setPinned(context(), 'target', true);

    expect(result).toMatchObject({
      ok: true,
      changed: true,
      after: { pinned: true },
      auditStatus: 'recorded',
      deliveryStatus: 'delivered',
    });
    expect(captureSessionAuthoritySnapshot(f.rows.get('target'), 'session_set_pinned'))
      .toEqual(authorityBefore);
    expect(f.audits).toHaveLength(1);
    expect(f.broadcasts).toHaveLength(2);
  });

  it('durably reserves audit and renderer convergence before the repository commit', async () => {
    const f = fixture([session('actor'), session('target')]);

    await f.service.setPinned(context(), 'target', true);

    expect(f.operationOrder.slice(0, 3)).toEqual([
      'reserve-intent',
      'repository-write',
      'mark-committed',
    ]);
    expect(f.mutationIntents).toEqual([expect.objectContaining({
      auditId: 'audit-1',
      operation: 'session_set_pinned',
      phase: 'reserved',
      audit: expect.objectContaining({ outcome: 'changed' }),
      delivery: expect.objectContaining({ operation: 'session_set_pinned' }),
    })]);
  });

  it('returns a committed pending receipt when commit journaling and immediate sinks fail', async () => {
    const f = fixture(
      [session('actor'), session('target')],
      { failCommitJournal: true, failAuditAttempts: 1, failBroadcastAttempts: 1 },
    );

    await expect(f.service.setPinned(context(), 'target', true)).resolves.toMatchObject({
      ok: true,
      changed: true,
      after: { pinned: true },
      auditStatus: 'pending',
      deliveryStatus: 'pending',
    });
    expect(f.rows.get('target')?.isPinned).toBe(true);
    expect(f.mutationIntents).toHaveLength(1);
  });

  it('returns the exact committed visibility state when authoritative reload fails after write', async () => {
    const f = fixture([session('actor'), session('target')]);
    let committed = false;
    f.repository.setPinnedVisibility.mockImplementation(async (id: string, pinned: boolean) => {
      f.operationOrder.push('repository-write');
      f.rows.set(id, { ...f.rows.get(id), isPinned: pinned });
      committed = true;
    });
    f.repository.get.mockImplementation(async (id: string) => {
      if (id === 'target' && committed) throw new Error('transient reload failure');
      const value = f.rows.get(id);
      return value ? structuredClone(value) : null;
    });

    await expect(f.service.setPinned(context(), 'target', true)).resolves.toMatchObject({
      ok: true,
      changed: true,
      after: { pinned: true },
      deliveryStatus: 'pending',
    });
    expect(f.rows.get('target')?.isPinned).toBe(true);
  });

  it('tracks a failed audit for retry without hiding a committed renderer update', async () => {
    const f = fixture([session('actor'), session('target')], { failAuditAttempts: 1 });

    const changed = await f.service.setPinned(context(), 'target', true);
    expect(changed).toMatchObject({
      ok: true,
      changed: true,
      auditStatus: 'pending',
      deliveryStatus: 'delivered',
    });
    expect(f.rows.get('target')?.isPinned).toBe(true);
    expect(f.broadcasts).toHaveLength(2);
    expect(f.audits).toEqual([]);

    expect(f.mutationIntents).toHaveLength(1);
    expect(f.mutationIntents[0].audit).toMatchObject({
      outcome: 'changed', auditId: changed.auditId,
    });
  });

  it('deduplicates durable audit replay by auditId', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nim-366-audit-dedupe-'));
    const filePath = path.join(directory, 'session-visibility.jsonl');
    try {
      const sink = createSessionVisibilityAuditSink(filePath);
      const event: SessionVisibilityAuditEvent = {
        event: 'session_visibility_control', auditId: 'audit-dedupe',
        timestamp: '2026-07-20T00:00:00.000Z', source: 'mcp-host',
        operation: 'session_set_pinned', outcome: 'changed', actorSessionId: 'actor',
        actorKind: 'session', targetSessionId: 'target', workspaceId: 'ws-redacted',
        before: { pinned: false }, after: { pinned: true }, reasonCode: null,
        correlationId: 'correlation',
      };
      await sink(event);
      await sink(structuredClone(event));

      const lines = (await readFile(filePath, 'utf8')).trim().split('\n');
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0])).toEqual(event);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('tracks renderer delivery for retry without reporting a committed write as failed', async () => {
    const f = fixture([session('actor'), session('target')], { failBroadcastAttempts: 1 });

    const changed = await f.service.setPinned(context(), 'target', true);
    expect(changed).toMatchObject({
      ok: true,
      changed: true,
      auditStatus: 'recorded',
      deliveryStatus: 'pending',
    });
    expect(f.rows.get('target')?.isPinned).toBe(true);
    expect(f.audits).toHaveLength(1);
    expect(f.broadcasts).toEqual([]);

    await f.service.configureHostBroadcast((_workspacePath, channel, ...args) => {
      f.broadcasts.push({ channel, args });
    });
    expect(f.mutationIntents.map((intent) => intent.delivery)).toEqual([expect.objectContaining({
      auditId: changed.auditId,
      operation: 'session_set_pinned',
      targetSessionId: 'target',
      before: { pinned: false },
      after: { pinned: true },
    })]);
    expect(f.mutationIntents[0].delivery.workspacePath).toBe(WORKSPACE);
  });

  it('reconstructs pending audit and renderer convergence without another mutation', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nim-366-service-restart-'));
    const outboxPath = path.join(directory, 'convergence.jsonl');
    const base = fixture([session('actor'), session('target')]);
    const first = new SessionVisibilityControlService({
      repository: base.repository,
      audit: async () => { throw new Error('audit offline'); },
      broadcast: () => { throw new Error('renderer offline'); },
      convergenceOutboxFilePath: outboxPath,
      convergenceRetryIntervalMs: 60_000,
      now: () => 1_721_350_800_000,
      randomId: () => 'audit-restart-service',
    });

    try {
      const receipt = await first.setPinned(context(), 'target', true);
      expect(receipt).toMatchObject({
        changed: true,
        auditStatus: 'pending',
        deliveryStatus: 'pending',
      });
      await first.close();

      const recoveredAudits: SessionVisibilityAuditEvent[] = [];
      const recoveredBroadcasts: Array<{ channel: string; args: unknown[] }> = [];
      const reconstructed = new SessionVisibilityControlService({
        repository: base.repository,
        audit: async (event) => { recoveredAudits.push(event); },
        broadcast: (_workspacePath, channel, ...args) => { recoveredBroadcasts.push({ channel, args }); },
        convergenceOutboxFilePath: outboxPath,
        convergenceRetryIntervalMs: 10,
      });

      await eventually(() => {
        expect(recoveredAudits).toContainEqual(expect.objectContaining({
          auditId: 'audit-restart-service',
          outcome: 'changed',
        }));
        expect(recoveredBroadcasts).toContainEqual({
          channel: 'sessions:session-updated',
          args: ['target', {
            workspacePath: WORKSPACE,
            isPinned: true,
            visibilityAuditId: 'audit-restart-service',
          }],
        });
      });
      await reconstructed.close();
    } finally {
      await first.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== 'win32')(
    'replays through the current host alias after restart instead of the mutation-time spelling',
    async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'nim-366-service-alias-restart-'));
      const outboxPath = path.join(directory, 'convergence.jsonl');
      const base = fixture([
        session('actor', { workspacePath: 'C:\\Repo' }),
        session('target', { workspacePath: 'C:\\Repo' }),
      ]);
      const first = new SessionVisibilityControlService({
        repository: base.repository,
        audit: async () => undefined,
        broadcast: () => { throw new Error('renderer offline'); },
        convergenceOutboxFilePath: outboxPath,
        convergenceRetryIntervalMs: 60_000,
        randomId: () => 'audit-windows-alias',
      });
      const mutationAlias = 'c:/repo/';
      const reopenedAlias = 'C:/Repo';

      try {
        await expect(first.setPinned(context({ workspacePath: mutationAlias }), 'target', true))
          .resolves.toMatchObject({ deliveryStatus: 'pending' });
        await first.close();

        const routedPaths: string[] = [];
        const replayedUpdates: unknown[][] = [];
        const reconstructed = new SessionVisibilityControlService({
          repository: base.repository,
          audit: async () => undefined,
          broadcast: (workspacePath, channel, ...args) => {
            routedPaths.push(workspacePath);
            if (channel === 'sessions:session-updated') replayedUpdates.push(args);
          },
          resolveOperationalWorkspacePath: async (workspaceId, durablePath) => {
            expect(workspaceId).toBeTruthy();
            expect(durablePath).toBe(mutationAlias);
            return reopenedAlias;
          },
          convergenceOutboxFilePath: outboxPath,
          convergenceRetryIntervalMs: 10,
        });
        await eventually(() => {
          expect(routedPaths).toContain(reopenedAlias);
          expect(replayedUpdates).toContainEqual([
            'target',
            expect.objectContaining({
              workspacePath: reopenedAlias,
              visibilityAuditId: 'audit-windows-alias',
            }),
          ]);
        });
        expect(routedPaths).not.toContain(mutationAlias);
        await reconstructed.close();
      } finally {
        await first.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it('authorizes renderer IPC through a distinct window principal instead of target impersonation', async () => {
    const f = fixture([session('target')]);

    const result = await f.service.setPinned(context({
      actorSessionId: 'renderer-window:7',
      actorKind: 'renderer-user',
      source: 'renderer-ipc',
    }), 'target', true);

    expect(result).toMatchObject({
      actorSessionId: 'renderer-window:7',
      actorKind: 'renderer-user',
      targetSessionId: 'target',
      changed: true,
    });
    expect(f.repository.get).not.toHaveBeenCalledWith('renderer-window:7');
    expect(f.audits[0]).toMatchObject({
      actorSessionId: 'renderer-window:7',
      actorKind: 'renderer-user',
    });
  });

  it('normalizes an exact-target rename and rejects empty, control, and overlong names', async () => {
    const target = session('target');
    const parent = session('parent', { sessionType: 'blitz', title: 'Blitz parent' });
    target.parentSessionId = 'parent';
    const f = fixture([session('actor'), target, parent]);
    const authorityBefore = captureSessionAuthoritySnapshot(target, 'session_rename');

    const renamed = await f.service.rename(context(), 'target', '  Exact target  ');
    const replay = await f.service.rename(context(), 'target', 'Exact target');

    expect(renamed).toMatchObject({
      changed: true,
      before: { name: 'target title', hasBeenNamed: false },
      after: { name: 'Exact target', hasBeenNamed: true },
    });
    expect(replay.changed).toBe(false);
    expect(f.rows.get('parent')?.title).toBe('Blitz parent');
    expect(captureSessionAuthoritySnapshot(f.rows.get('target'), 'session_rename')).toEqual(authorityBefore);

    for (const name of ['   ', 'bad\u0000name', 'x'.repeat(101)]) {
      await expect(f.service.rename(context(), 'target', name)).rejects.toBeInstanceOf(
        SessionVisibilityControlError,
      );
      await expect(f.service.rename(context(), 'target', name)).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      });
    }
  });

  it('rate limits per actor with bounded retry data and no mutation', async () => {
    const f = fixture([session('actor'), session('target')], { rateLimitMax: 1 });
    await f.service.setPinned(context(), 'target', true);

    await expect(f.service.setPinned(context(), 'target', false)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterMs: 60_000,
    });
    expect(f.repository.setPinnedVisibility).toHaveBeenCalledTimes(1);
    expect(f.audits.at(-1)).toMatchObject({ outcome: 'denied', reasonCode: 'RATE_LIMITED' });
  });

  it('audits server-detected unknown tool arguments as INVALID_ARGUMENT', async () => {
    const f = fixture([session('actor'), session('target')]);

    await expect(f.service.setPinned(
      context({ requestArgumentsValid: false }),
      'target',
      true,
    )).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });

    expect(f.writes).toEqual([]);
    expect(f.audits).toHaveLength(1);
    expect(f.audits[0]).toMatchObject({
      outcome: 'denied',
      reasonCode: 'INVALID_ARGUMENT',
    });
  });
});
