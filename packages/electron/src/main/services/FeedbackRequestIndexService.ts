import {
  FeedbackRequestSync,
  type FeedbackRequestTarget,
} from '@nimbalyst/runtime/sync';
import type {
  FeedbackRequestIndexEntry,
} from '@nimbalyst/collab-protocol';
import type { TeamJwt, TeamMemberId } from '@nimbalyst/runtime/auth/jwtScopes';

import type {
  FeedbackRequestIndexChangedPayload,
  FeedbackRequestIndexSnapshotIpcRequest,
  FeedbackRequestIndexSubjectIpcRequest,
  FeedbackRequestIndexTarget,
  FeedbackRequestIndexUpsertIpcRequest,
  FeedbackRequestIndexViewerTarget,
} from '../../shared/feedbackRequestIndex';
import { getCollabSyncHttpUrl } from '../utils/collabSyncUrl';
import { getSubFromJwt } from './jwtOrg';
import { runWhenFirstUsable } from './startupMaintenanceGate';
import { getOrgScopedJwt } from './TeamService';
import {
  FeedbackRequestIndexPersistence,
  type FeedbackRequestIndexBackfillState,
} from './FeedbackRequestIndexPersistence';

const BROADCAST_PERSIST_DEBOUNCE_MS = 40;
const BACKFILL_BATCH_SIZE = 20;
const BACKFILL_INTER_BATCH_DELAY_MS = 10;
const BACKFILL_ROOM_CONNECT_TIMEOUT_MS = 10_000;

type PingFeedbackRequestRoom = (
  target: FeedbackRequestTarget,
  getTeamJwt: () => Promise<TeamJwt>,
) => Promise<void>;

export interface FeedbackRequestIndexServiceDependencies {
  getTeamJwt: (orgId: string) => Promise<TeamJwt>;
  getTeamMemberId: (jwt: TeamJwt) => TeamMemberId | null;
  persistence: FeedbackRequestIndexPersistence;
  pingRequestRoom: PingFeedbackRequestRoom;
  scheduleMaintenance: (label: string, task: () => Promise<void>) => void;
  setTimer?: (
    callback: () => void,
    delayMs: number,
  ) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  yieldBetweenBackfillBatches?: () => Promise<void>;
}

function scopeKey(target: FeedbackRequestIndexViewerTarget): string {
  return JSON.stringify([
    target.workspacePath,
    target.orgId,
    target.teamMemberId,
  ]);
}

function assertTarget(
  target: Partial<FeedbackRequestIndexTarget> | null | undefined,
): asserts target is FeedbackRequestIndexTarget {
  if (!target?.workspacePath || !target.orgId) {
    throw new Error('Feedback request index workspace and organization ids are required');
  }
}

function assertIndexEntry(
  target: FeedbackRequestIndexViewerTarget,
  entry: FeedbackRequestIndexEntry,
): void {
  if (!entry?.requestId || entry.orgId !== target.orgId) {
    throw new Error('Feedback request index entry must match its organization');
  }
}

async function pingFeedbackRequestRoom(
  target: FeedbackRequestTarget,
  getTeamJwt: () => Promise<TeamJwt>,
): Promise<void> {
  const sync = new FeedbackRequestSync({
    serverUrl: getCollabSyncHttpUrl(),
    target,
    getTeamJwt,
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => void) | undefined;
  try {
    const connected = new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        if (error) reject(error);
        else resolve();
      };
      unsubscribe = sync.subscribe((event) => {
        if (event.type === 'connected') finish();
        else if (event.type === 'error') finish(new Error(event.message));
      });
      timeout = setTimeout(() => finish(new Error(
        'Timed out connecting to feedback request room for index backfill',
      )), BACKFILL_ROOM_CONNECT_TIMEOUT_MS);
    });
    await Promise.all([sync.connect(), connected]);
  } finally {
    if (timeout) clearTimeout(timeout);
    unsubscribe?.();
    sync.destroy();
  }
}

/**
 * Resume the one-time pre-index request-room pass from its durable cursor.
 * A crash can replay only the unfinished chunk; room registration is idempotent.
 */
export async function runFeedbackRequestIndexBackfill(
  target: FeedbackRequestIndexViewerTarget,
  dependencies: Pick<
    FeedbackRequestIndexServiceDependencies,
    'getTeamJwt' | 'getTeamMemberId' | 'persistence' | 'pingRequestRoom'
      | 'yieldBetweenBackfillBatches'
  >,
): Promise<void> {
  let state = await dependencies.persistence.getOrCreateBackfillState(target);
  if (state.completedAt != null) return;

  while (true) {
    const requestIds = await dependencies.persistence.getBackfillBatch(
      target,
      state,
      BACKFILL_BATCH_SIZE,
    );
    if (requestIds.length === 0) {
      await dependencies.persistence.completeBackfill(target);
      return;
    }

    let lastSuccessfulRequestId: string | undefined;
    try {
      for (const requestId of requestIds) {
        await dependencies.pingRequestRoom(
          { orgId: target.orgId, requestId },
          async () => {
            const jwt = await dependencies.getTeamJwt(target.orgId);
            if (dependencies.getTeamMemberId(jwt) !== target.teamMemberId) {
              throw new Error('Feedback request index backfill team identity changed');
            }
            return jwt;
          },
        );
        lastSuccessfulRequestId = requestId;
      }
    } finally {
      if (lastSuccessfulRequestId) {
        await dependencies.persistence.advanceBackfillCursor(
          target,
          lastSuccessfulRequestId,
        );
        state = {
          ...state,
          cursorRequestId: lastSuccessfulRequestId,
        } satisfies FeedbackRequestIndexBackfillState;
      }
    }

    await (dependencies.yieldBetweenBackfillBatches?.()
      ?? new Promise<void>((resolve) => {
        setTimeout(resolve, BACKFILL_INTER_BATCH_DELAY_MS);
      }));
  }
}

/** Main-process owner for the local feedback request index projection. */
export class FeedbackRequestIndexService {
  private readonly pendingUpserts = new Map<
    string,
    Map<string, FeedbackRequestIndexEntry>
  >();
  private readonly persistTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly scheduledBackfills = new Set<string>();
  private readonly completedBackfills = new Set<string>();
  private readonly listeners = new Set<
    (payload: FeedbackRequestIndexChangedPayload) => void
  >();

  constructor(
    private readonly dependencies: FeedbackRequestIndexServiceDependencies,
  ) {}

  subscribe(
    listener: (payload: FeedbackRequestIndexChangedPayload) => void,
  ): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  async replaceSnapshot(
    input: FeedbackRequestIndexSnapshotIpcRequest,
  ): Promise<FeedbackRequestIndexChangedPayload> {
    const target = await this.scopeTarget(input.target, input.teamMemberId);
    for (const entry of input.entries) assertIndexEntry(target, entry);
    await this.dependencies.persistence.replaceSnapshot(target, input.entries);
    const payload = await this.emitCurrent(target);
    this.scheduleBackfill(target);
    return payload;
  }

  async enqueueUpsert(input: FeedbackRequestIndexUpsertIpcRequest): Promise<void> {
    const target = await this.scopeTarget(input.target, input.teamMemberId);
    assertIndexEntry(target, input.entry);
    const key = scopeKey(target);
    const pending = this.pendingUpserts.get(key) ?? new Map();
    const current = pending.get(input.entry.requestId);
    if (!current || input.entry.updatedAt >= current.updatedAt) {
      pending.set(input.entry.requestId, input.entry);
    }
    this.pendingUpserts.set(key, pending);
    const existing = this.persistTimers.get(key);
    if (existing) this.clearTimer(existing);
    this.persistTimers.set(key, this.setTimer(() => {
      this.persistTimers.delete(key);
      void this.flushUpserts(target).catch((error) => {
        console.error('[FeedbackRequestIndexService] Failed to persist index updates:', error);
      });
    }, BROADCAST_PERSIST_DEBOUNCE_MS));
  }

  async list(
    target: FeedbackRequestIndexTarget,
  ): Promise<FeedbackRequestIndexChangedPayload> {
    const scoped = await this.scopeTarget(target);
    return this.emitCurrent(scoped);
  }

  async findBySubject(
    input: FeedbackRequestIndexSubjectIpcRequest,
  ): Promise<FeedbackRequestIndexChangedPayload> {
    const target = await this.scopeTarget(input.target);
    const entries = await this.dependencies.persistence.findBySubject(
      target,
      input.subject,
    );
    return { ...target, entries };
  }

  destroy(): void {
    for (const timer of this.persistTimers.values()) this.clearTimer(timer);
    this.persistTimers.clear();
    this.pendingUpserts.clear();
    this.scheduledBackfills.clear();
    this.completedBackfills.clear();
    this.listeners.clear();
  }

  private async flushUpserts(
    target: FeedbackRequestIndexViewerTarget,
  ): Promise<void> {
    const key = scopeKey(target);
    const pending = this.pendingUpserts.get(key);
    if (!pending || pending.size === 0) return;
    this.pendingUpserts.delete(key);
    try {
      await this.dependencies.persistence.upsertEntries(
        target,
        [...pending.values()],
      );
    } catch (error) {
      // Retain the coalesced latest values. A later broadcast will reschedule
      // the flush; dropping them here would make one transient DB failure lose
      // the only incremental lifecycle/progress update.
      const queued = this.pendingUpserts.get(key) ?? new Map();
      for (const [requestId, entry] of pending) {
        const current = queued.get(requestId);
        if (!current || entry.updatedAt >= current.updatedAt) {
          queued.set(requestId, entry);
        }
      }
      this.pendingUpserts.set(key, queued);
      throw error;
    }
    await this.emitCurrent(target);
  }

  private async emitCurrent(
    target: FeedbackRequestIndexViewerTarget,
  ): Promise<FeedbackRequestIndexChangedPayload> {
    // A coalesced write may flush after the local account changed. Revalidate
    // before broadcasting so a new renderer identity never sees the prior
    // team-room viewer's participant-filtered rows.
    await this.scopeTarget(target, target.teamMemberId);
    const entries = await this.dependencies.persistence.list(target);
    // Account/session state can change while the database worker is serving the
    // read. Recheck at the last synchronous point before notifying renderers.
    await this.scopeTarget(target, target.teamMemberId);
    const payload = {
      ...target,
      entries,
    };
    for (const listener of this.listeners) listener(payload);
    return payload;
  }

  private scheduleBackfill(target: FeedbackRequestIndexViewerTarget): void {
    const key = scopeKey(target);
    if (this.scheduledBackfills.has(key) || this.completedBackfills.has(key)) return;
    this.scheduledBackfills.add(key);
    this.dependencies.scheduleMaintenance(
      `feedback-request-index-backfill:${target.orgId}`,
      async () => {
        try {
          await runFeedbackRequestIndexBackfill(target, this.dependencies);
          this.completedBackfills.add(key);
        } finally {
          this.scheduledBackfills.delete(key);
        }
      },
    );
  }

  private async scopeTarget(
    target: FeedbackRequestIndexTarget,
    expectedTeamMemberId?: TeamMemberId,
  ): Promise<FeedbackRequestIndexViewerTarget> {
    assertTarget(target);
    const jwt = await this.dependencies.getTeamJwt(target.orgId);
    const teamMemberId = this.dependencies.getTeamMemberId(jwt);
    if (!teamMemberId) {
      throw new Error('Feedback request index team member identity is unavailable');
    }
    if (expectedTeamMemberId && expectedTeamMemberId !== teamMemberId) {
      throw new Error('Feedback request index team identity changed');
    }
    return { ...target, teamMemberId };
  }

  private setTimer(
    callback: () => void,
    delayMs: number,
  ): ReturnType<typeof setTimeout> {
    return this.dependencies.setTimer?.(callback, delayMs)
      ?? setTimeout(callback, delayMs);
  }

  private clearTimer(timer: ReturnType<typeof setTimeout>): void {
    if (this.dependencies.clearTimer) this.dependencies.clearTimer(timer);
    else clearTimeout(timer);
  }
}

let service: FeedbackRequestIndexService | null = null;

export function getFeedbackRequestIndexService(): FeedbackRequestIndexService {
  if (!service) {
    service = new FeedbackRequestIndexService({
      getTeamJwt: (orgId) => getOrgScopedJwt(orgId),
      getTeamMemberId: getSubFromJwt,
      persistence: new FeedbackRequestIndexPersistence(),
      pingRequestRoom: pingFeedbackRequestRoom,
      scheduleMaintenance: (label, task) => runWhenFirstUsable(label, task),
    });
  }
  return service;
}

export function shutdownFeedbackRequestIndexService(): void {
  service?.destroy();
  service = null;
}
