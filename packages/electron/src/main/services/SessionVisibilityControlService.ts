import { createHash, randomUUID } from 'crypto';
import { mkdir, open, readFile, truncate } from 'fs/promises';
import path from 'path';
import { isDeepStrictEqual } from 'util';
import { AISessionsRepository } from '@nimbalyst/runtime';
import type { SessionData } from '@nimbalyst/runtime/ai/server/types';
import {
  SessionVisibilityConvergenceOutbox,
  type SessionVisibilityDeliveryDescriptor,
  type SessionVisibilityMutationIntent,
} from './SessionVisibilityConvergenceOutbox';

export type SessionVisibilityOperation =
  | 'session_set_pinned'
  | 'session_set_workstream'
  | 'session_rename';

export type SessionVisibilityErrorCode =
  | 'INVALID_ARGUMENT'
  | 'TARGET_NOT_FOUND'
  | 'WORKSTREAM_NOT_FOUND'
  | 'INVALID_WORKSTREAM_TARGET'
  | 'RATE_LIMITED'
  | 'CONFLICT'
  | 'INTERNAL_ERROR';

export interface SessionVisibilityContext {
  actorSessionId: string;
  actorKind?: 'session' | 'renderer-user';
  workspacePath: string;
  source: 'mcp-host' | 'renderer-ipc';
  correlationId: string;
  /** Server-computed schema guard; tool callers cannot set this field. */
  requestArgumentsValid?: boolean;
}

export interface SessionPinnedState {
  pinned: boolean;
}

export interface SessionWorkstreamState {
  workstreamId: string | null;
  workstreamTitle: string | null;
}

export interface SessionRenameState {
  name: string;
  hasBeenNamed: boolean;
}

export type SessionVisibilityState =
  | SessionPinnedState
  | SessionWorkstreamState
  | SessionRenameState;

export interface SessionVisibilityReceipt<TState extends SessionVisibilityState = SessionVisibilityState> {
  ok: true;
  operation: SessionVisibilityOperation;
  auditId: string;
  timestamp: string;
  actorSessionId: string;
  actorKind: 'session' | 'renderer-user';
  targetSessionId: string;
  workspaceId: string;
  changed: boolean;
  before: TState;
  after: TState;
  auditStatus: 'recorded' | 'pending';
  deliveryStatus: 'delivered' | 'pending';
}

export interface SessionVisibilityAuditEvent {
  event: 'session_visibility_control';
  auditId: string;
  timestamp: string;
  source: SessionVisibilityContext['source'];
  operation: SessionVisibilityOperation;
  outcome: 'changed' | 'noop' | 'denied' | 'failed';
  actorSessionId: string;
  actorKind: 'session' | 'renderer-user';
  targetSessionId: string;
  workspaceId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reasonCode: SessionVisibilityErrorCode | null;
  correlationId: string;
}

interface SessionVisibilityRepository {
  get(sessionId: string): Promise<SessionData | null>;
  setPinnedVisibility(
    sessionId: string, pinned: boolean, mutationId: string,
    expectedPinned: boolean, workspacePath: string,
    workspaceComparisonPath: string,
  ): Promise<void>;
  setWorkstreamMembership(
    sessionId: string, workstreamId: string | null, mutationId: string,
    expectedWorkstreamId: string | null, workspacePath: string,
    workspaceComparisonPath: string,
  ): Promise<void>;
  setWorkstreamMembershipIfDestinationValid?(
    sessionId: string,
    workstreamId: string,
    mutationId: string,
    expectedWorkstreamId: string | null,
    workspacePath: string,
    workspaceComparisonPath: string,
  ): Promise<void>;
  renameExactSession(
    sessionId: string, name: string, mutationId: string,
    expected: { title: string; hasBeenNamed: boolean }, workspacePath: string,
    workspaceComparisonPath: string,
  ): Promise<void>;
  hasVisibilityMutation(
    sessionId: string,
    mutationId: string,
    mutationIdentity?: string,
  ): Promise<boolean>;
}

interface SessionVisibilityControlDependencies {
  repository?: SessionVisibilityRepository;
  audit?: (event: SessionVisibilityAuditEvent) => Promise<void> | void;
  broadcast?: (
    workspacePath: string, channel: string, ...args: unknown[]
  ) => boolean | void | Promise<boolean | void>;
  resolveOperationalWorkspacePath?: (
    workspaceId: string,
    durableWorkspacePath: string,
  ) => string | null | Promise<string | null>;
  now?: () => number;
  randomId?: () => string;
  rateLimitMax?: number;
  rateLimitWindowMs?: number;
  convergenceOutbox?: Pick<
    SessionVisibilityConvergenceOutbox,
    | 'start' | 'reserveMutation' | 'markMutationCommitted' | 'markMutationAborted'
    | 'acknowledgeMutationAudit' | 'acknowledgeMutationDelivery'
    | 'enqueueAudit' | 'enqueueDelivery' | 'flush' | 'close'
  >;
  convergenceOutboxFilePath?: string;
  storageRoot?: string;
  auditFilePath?: string;
  convergenceRetryIntervalMs?: number;
  rendererAckTimeoutMs?: number;
  reservationOwnerId?: string;
  assertStorageRootOwnership?: () => void;
  withStorageRootWriteFence?: <T>(work: () => Promise<T>) => Promise<T>;
}

interface RateLimitBucket {
  windowStart: number;
  count: number;
}

interface RequestEnvelope {
  operation: SessionVisibilityOperation;
  auditId: string;
  timestamp: string;
  actorSessionId: string;
  actorKind: 'session' | 'renderer-user';
  targetSessionId: string;
  canonicalWorkspacePath: string;
  workspaceId: string;
  source: SessionVisibilityContext['source'];
  correlationId: string;
}

interface AuditState {
  before: SessionVisibilityState | null;
  after: SessionVisibilityState | null;
}

interface ConvergenceEvent {
  channel: string;
  args: unknown[];
}

const MAX_SESSION_ID_LENGTH = 200;
const MAX_NAME_LENGTH = 100;
const DEFAULT_RATE_LIMIT_MAX = 30;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_RATE_LIMIT_BUCKETS = 1_000;
const targetLockTails = new Map<string, Promise<void>>();

/** Append-only, fsync-backed and idempotent by auditId. Existing audit data is
 * retained instead of truncating the whole file at an arbitrary size bound.
 */
export function createSessionVisibilityAuditSink(
  auditPath: string,
): (event: SessionVisibilityAuditEvent) => Promise<void> {
  const seenAuditIds = new Set<string>();
  let writeTail: Promise<void> = Promise.resolve();
  const loaded = (async () => {
    let content: Buffer;
    try {
      content = await readFile(auditPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return;
    }
    const lastNewline = content.lastIndexOf(0x0a);
    const safeLength = lastNewline + 1;
    for (const line of content.subarray(0, safeLength).toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      const parsed = JSON.parse(line) as Partial<SessionVisibilityAuditEvent>;
      if (typeof parsed.auditId === 'string') seenAuditIds.add(parsed.auditId);
    }
    const tail = content.subarray(safeLength).toString('utf8');
    if (!tail.trim()) return;
    try {
      const parsed = JSON.parse(tail) as Partial<SessionVisibilityAuditEvent>;
      if (typeof parsed.auditId === 'string') seenAuditIds.add(parsed.auditId);
      const handle = await open(auditPath, 'a');
      try {
        await handle.appendFile('\n', 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch {
      await truncate(auditPath, safeLength);
    }
  })();

  return (event) => {
    const write = async () => {
      await loaded;
      if (seenAuditIds.has(event.auditId)) return;
      await mkdir(path.dirname(auditPath), { recursive: true });
      const handle = await open(auditPath, 'a');
      try {
        await handle.appendFile(`${JSON.stringify(event)}\n`, 'utf8');
        await handle.sync();
        seenAuditIds.add(event.auditId);
      } finally {
        await handle.close();
      }
    };
    const current = writeTail.then(write, write);
    writeTail = current.catch(() => undefined);
    return current;
  };
}

function requireBoundedString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} is required`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new Error(`${field} is too long`);
  }
  return normalized;
}

export function canonicalizeSessionWorkspacePath(value: string): string {
  const resolved = path.resolve(value.trim()).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function workspaceReceiptId(canonicalWorkspacePath: string): string {
  return `ws-${createHash('sha256').update(canonicalWorkspacePath).digest('hex').slice(0, 16)}`;
}

function cloneSnapshotValue<T>(value: T): T {
  if (value === undefined || value === null) return value;
  return structuredClone(value);
}

/** Explicit authority fields that a visibility-only repository primitive must
 * never change. Volatile content (messages, metadata, document state,
 * timestamps, token usage) is intentionally excluded so an unrelated
 * concurrent update cannot turn a committed visibility write into a failure.
 */
export function captureSessionAuthoritySnapshot(
  session: SessionData,
  _operation?: SessionVisibilityOperation,
): Record<string, unknown> {
  const documentContext = session.documentContext as Record<string, unknown> | undefined;
  return cloneSnapshotValue({
    id: session.id,
    workspacePath: session.workspacePath,
    worktreeId: session.worktreeId,
    worktreePath: session.worktreePath,
    worktreeProjectPath: session.worktreeProjectPath,
    sessionType: session.sessionType,
    provider: session.provider,
    model: session.model,
    mode: session.mode,
    agentRole: session.agentRole,
    createdBySessionId: session.createdBySessionId,
    providerSessionId: session.providerSessionId,
    providerConfig: session.providerConfig,
    branchedFromSessionId: session.branchedFromSessionId,
    branchPointMessageId: session.branchPointMessageId,
    branchedAt: session.branchedAt,
    branchedFromProviderSessionId: session.branchedFromProviderSessionId,
    documentAuthority: documentContext ? {
      permissionsPath: documentContext.permissionsPath,
      mcpConfigWorkspacePath: documentContext.mcpConfigWorkspacePath,
      worktreeId: documentContext.worktreeId,
      worktreePath: documentContext.worktreePath,
      worktreeProjectPath: documentContext.worktreeProjectPath,
    } : undefined,
  });
}

function assertAuthorityUnchanged(
  before: Record<string, unknown>,
  after: SessionData,
  operation: SessionVisibilityOperation,
): void {
  if (!isDeepStrictEqual(before, captureSessionAuthoritySnapshot(after, operation))) {
    throw new Error('authority snapshot changed');
  }
}

function boundedCorrelationId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return `correlation-${randomUUID()}`;
  return value.trim().slice(0, 200);
}

function auditState(
  operation: SessionVisibilityOperation,
  state: SessionVisibilityState | null,
): Record<string, unknown> | null {
  if (!state) return null;
  if (operation === 'session_set_pinned') {
    return { pinned: (state as SessionPinnedState).pinned };
  }
  if (operation === 'session_set_workstream') {
    return { workstreamId: (state as SessionWorkstreamState).workstreamId };
  }
  return { hasBeenNamed: (state as SessionRenameState).hasBeenNamed };
}

function stateIdentity(
  operation: SessionVisibilityOperation,
  state: SessionVisibilityState,
): string {
  const operationalState = operation === 'session_set_pinned'
    ? { pinned: (state as SessionPinnedState).pinned }
    : operation === 'session_set_workstream'
      ? { workstreamId: (state as SessionWorkstreamState).workstreamId }
      : {
          name: (state as SessionRenameState).name,
          hasBeenNamed: (state as SessionRenameState).hasBeenNamed,
        };
  return createHash('sha256').update(JSON.stringify(operationalState)).digest('hex');
}

function storeMutationIdentity(
  sessionId: string,
  operation: SessionVisibilityOperation,
  workspaceComparisonPath: string,
  before: SessionVisibilityState,
  after: SessionVisibilityState,
): string {
  const expected = operation === 'session_set_pinned'
    ? { isPinned: (before as SessionPinnedState).pinned }
    : operation === 'session_set_workstream'
      ? { parentSessionId: (before as SessionWorkstreamState).workstreamId }
      : {
          title: (before as SessionRenameState).name,
          hasBeenNamed: (before as SessionRenameState).hasBeenNamed,
        };
  const next = operation === 'session_set_pinned'
    ? { isPinned: (after as SessionPinnedState).pinned }
    : operation === 'session_set_workstream'
      ? { parentSessionId: (after as SessionWorkstreamState).workstreamId }
      : {
          title: (after as SessionRenameState).name,
          hasBeenNamed: (after as SessionRenameState).hasBeenNamed,
        };
  const destinationSessionId = operation === 'session_set_workstream'
    ? (after as SessionWorkstreamState).workstreamId
    : null;
  return createHash('sha256').update(JSON.stringify({
    sessionId,
    operation,
    workspaceComparisonPath,
    expected,
    after: next,
    destinationSessionId,
  })).digest('hex');
}

async function withTargetLock<T>(targetSessionId: string, fn: () => Promise<T>): Promise<T> {
  const previousTail = targetLockTails.get(targetSessionId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const nextTail = previousTail.then(() => current);
  targetLockTails.set(targetSessionId, nextTail);
  await previousTail;
  try {
    return await fn();
  } finally {
    release();
    if (targetLockTails.get(targetSessionId) === nextTail) {
      targetLockTails.delete(targetSessionId);
    }
  }
}

export class SessionVisibilityControlError extends Error {
  readonly code: SessionVisibilityErrorCode;
  readonly auditId: string;
  readonly timestamp: string;
  readonly correlationId: string;
  readonly retryAfterMs?: number;
  auditStatus: 'recorded' | 'pending' = 'recorded';

  constructor(args: {
    code: SessionVisibilityErrorCode;
    auditId: string;
    timestamp: string;
    correlationId: string;
    retryAfterMs?: number;
  }) {
    super(args.code);
    this.name = 'SessionVisibilityControlError';
    this.code = args.code;
    this.auditId = args.auditId;
    this.timestamp = args.timestamp;
    this.correlationId = args.correlationId;
    this.retryAfterMs = args.retryAfterMs;
  }
}

export function toSessionVisibilityErrorPayload(error: unknown): Record<string, unknown> {
  const candidate = error as Partial<SessionVisibilityControlError> | null;
  const knownCodes: SessionVisibilityErrorCode[] = [
    'INVALID_ARGUMENT',
    'TARGET_NOT_FOUND',
    'WORKSTREAM_NOT_FOUND',
    'INVALID_WORKSTREAM_TARGET',
    'RATE_LIMITED',
    'CONFLICT',
    'INTERNAL_ERROR',
  ];
  if (
    candidate &&
    typeof candidate.code === 'string' &&
    knownCodes.includes(candidate.code as SessionVisibilityErrorCode)
  ) {
    return {
      ok: false,
      code: candidate.code,
      ...(candidate.auditId && { auditId: candidate.auditId }),
      ...(candidate.timestamp && { timestamp: candidate.timestamp }),
      ...(candidate.correlationId && { correlationId: candidate.correlationId }),
      ...(candidate.retryAfterMs !== undefined && { retryAfterMs: candidate.retryAfterMs }),
      ...(candidate.auditStatus !== undefined && { auditStatus: candidate.auditStatus }),
    };
  }
  return { ok: false, code: 'INTERNAL_ERROR' };
}

export class SessionVisibilityControlService {
  private static instance: SessionVisibilityControlService | null = null;

  private readonly repository: SessionVisibilityRepository;
  private readonly auditSink: (event: SessionVisibilityAuditEvent) => Promise<void> | void;
  private broadcaster: (
    workspacePath: string, channel: string, ...args: unknown[]
  ) => boolean | void | Promise<boolean | void>;
  private readonly now: () => number;
  private readonly randomId: () => string;
  private readonly rateLimitMax: number;
  private readonly rateLimitWindowMs: number;
  private readonly rateLimitBuckets = new Map<string, RateLimitBucket>();
  private readonly convergenceOutbox: Pick<
    SessionVisibilityConvergenceOutbox,
    | 'start' | 'reserveMutation' | 'markMutationCommitted' | 'markMutationAborted'
    | 'acknowledgeMutationAudit' | 'acknowledgeMutationDelivery'
    | 'enqueueAudit' | 'enqueueDelivery' | 'flush' | 'close'
  >;
  private broadcasterReady: boolean;
  private operationalWorkspaceResolver: NonNullable<
    SessionVisibilityControlDependencies['resolveOperationalWorkspacePath']
  > | null;
  private readonly rendererAckTimeoutMs: number;
  private readonly rendererAckWaiters = new Map<string, () => void>();
  private readonly reservationOwnerId: string;
  private readonly liveReservations = new Set<string>();
  private readonly assertStorageRootOwnership: () => void;
  private readonly withStorageRootWriteFence: <T>(work: () => Promise<T>) => Promise<T>;

  static getInstance(deps: SessionVisibilityControlDependencies = {}): SessionVisibilityControlService {
    if (!SessionVisibilityControlService.instance) {
      SessionVisibilityControlService.instance = new SessionVisibilityControlService(deps);
    }
    return SessionVisibilityControlService.instance;
  }

  constructor(deps: SessionVisibilityControlDependencies = {}) {
    this.repository = deps.repository ?? AISessionsRepository;
    const auditPath = deps.auditFilePath ?? (deps.storageRoot
      ? path.join(deps.storageRoot, 'session-visibility', 'audit.jsonl')
      : null);
    if (!deps.audit && !auditPath) {
      throw new Error('Session visibility storage root is required');
    }
    this.auditSink = deps.audit ?? createSessionVisibilityAuditSink(auditPath!);
    this.broadcaster = deps.broadcast ?? (() => undefined);
    this.operationalWorkspaceResolver = deps.resolveOperationalWorkspacePath ?? null;
    this.now = deps.now ?? Date.now;
    this.randomId = deps.randomId ?? (() => `sv-${randomUUID()}`);
    this.rateLimitMax = deps.rateLimitMax ?? DEFAULT_RATE_LIMIT_MAX;
    this.rateLimitWindowMs = deps.rateLimitWindowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS;
    this.rendererAckTimeoutMs = Math.max(10, deps.rendererAckTimeoutMs ?? 2_000);
    this.reservationOwnerId = deps.reservationOwnerId ?? `sv-owner-${randomUUID()}`;
    this.assertStorageRootOwnership = deps.assertStorageRootOwnership ?? (() => undefined);
    this.withStorageRootWriteFence = deps.withStorageRootWriteFence
      ?? ((work) => this.withStorageRootFence(work));
    this.broadcasterReady = deps.broadcast !== undefined;
    this.convergenceOutbox = deps.convergenceOutbox ?? new SessionVisibilityConvergenceOutbox({
      filePath: deps.convergenceOutboxFilePath,
      storageRoot: deps.storageRoot,
      retryIntervalMs: deps.convergenceRetryIntervalMs,
      audit: (event) => this.withStorageRootFence(
        () => Promise.resolve(this.auditSink(event)),
      ),
      deliver: (descriptor) => this.replayDelivery(descriptor),
      resolveReservedMutation: (intent) => this.resolveReservedMutation(intent),
    });
    void this.withStorageRootFence(
      () => this.convergenceOutbox.start(),
    ).catch(() => undefined);
  }

  /** Main-process host injection; tests can keep the service Electron-free. */
  async configureHostBroadcast(
    broadcast: (
      workspacePath: string, channel: string, ...args: unknown[]
    ) => boolean | void | Promise<boolean | void>,
    resolveOperationalWorkspacePath?: NonNullable<
      SessionVisibilityControlDependencies['resolveOperationalWorkspacePath']
    >,
  ): Promise<void> {
    this.broadcaster = broadcast;
    if (resolveOperationalWorkspacePath) {
      this.operationalWorkspaceResolver = resolveOperationalWorkspacePath;
    }
    this.broadcasterReady = true;
    void this.withStorageRootFence(
      () => this.convergenceOutbox.flush(),
    ).catch(() => undefined);
  }

  acknowledgeRendererDelivery(auditId: string, workspacePath: string): boolean {
    try {
      this.assertStorageRootOwnership();
    } catch {
      return false;
    }
    const workspaceId = workspaceReceiptId(canonicalizeSessionWorkspacePath(workspacePath));
    const waiter = this.rendererAckWaiters.get(`${workspaceId}:${auditId}`);
    if (!waiter) return false;
    waiter();
    return true;
  }

  async close(): Promise<void> {
    await this.convergenceOutbox.close();
  }

  private async withStorageRootFence<T>(work: () => Promise<T>): Promise<T> {
    this.assertStorageRootOwnership();
    const result = await work();
    this.assertStorageRootOwnership();
    return result;
  }

  async setPinned(
    context: SessionVisibilityContext,
    sessionId: string,
    pinned: boolean,
  ): Promise<SessionVisibilityReceipt<SessionPinnedState>> {
    return this.runMutation('session_set_pinned', context, sessionId, async (request, state, commit) => {
      if (typeof pinned !== 'boolean') {
        throw this.error(request, 'INVALID_ARGUMENT');
      }
      return withTargetLock(request.targetSessionId, async () => {
        const target = await this.loadAuthorizedTarget(request);
        const authority = captureSessionAuthoritySnapshot(target, 'session_set_pinned');
        const before = { pinned: target.isPinned === true };
        state.before = before;
        const changed = before.pinned !== pinned;
        if (changed) {
          const intendedAfter = { pinned };
          await commit(before, intendedAfter, () =>
            this.repository.setPinnedVisibility(
              target.id, pinned, request.auditId, before.pinned, context.workspacePath,
              request.canonicalWorkspacePath,
            ));
          try {
            const reloaded = await this.reloadTarget(request);
            assertAuthorityUnchanged(authority, reloaded, 'session_set_pinned');
            const after = { pinned: reloaded.isPinned === true };
            state.after = after;
            if (after.pinned !== pinned) return {
              changed, before, after, reloadVerified: false,
            };
            return { changed, before, after, reloadVerified: true };
          } catch {
            state.after = intendedAfter;
            return { changed, before, after: intendedAfter, reloadVerified: false };
          }
        }
        const reloaded = await this.reloadTarget(request);
        assertAuthorityUnchanged(authority, reloaded, 'session_set_pinned');
        const after = { pinned: reloaded.isPinned === true };
        state.after = after;
        if (after.pinned !== pinned) throw this.error(request, 'CONFLICT');
        return { changed, before, after, reloadVerified: true };
      });
    }, (request, result) => result.changed ? [
      {
        channel: 'sessions:session-updated',
        args: [request.targetSessionId, {
          workspacePath: context.workspacePath,
          isPinned: result.after.pinned,
          visibilityAuditId: request.auditId,
        }],
      },
    ] : []);
  }

  async setWorkstream(
    context: SessionVisibilityContext,
    sessionId: string,
    workstreamId: string | null,
  ): Promise<SessionVisibilityReceipt<SessionWorkstreamState>> {
    return this.runMutation('session_set_workstream', context, sessionId, async (request, state, commit) => {
      const normalizedWorkstreamId = workstreamId === null
        ? null
        : this.requireId(request, workstreamId, 'workstreamId');
      return withTargetLock(request.targetSessionId, async () => {
        const target = await this.loadAuthorizedTarget(request);
        if (
          target.sessionType !== 'session' ||
          Boolean(target.worktreeId) ||
          normalizedWorkstreamId === target.id
        ) {
          throw this.error(request, 'INVALID_WORKSTREAM_TARGET');
        }

        const oldParent = target.parentSessionId
          ? await this.repository.get(target.parentSessionId)
          : null;
        const before: SessionWorkstreamState = {
          workstreamId: target.parentSessionId ?? null,
          workstreamTitle: oldParent && this.matchesWorkspace(
            oldParent.workspacePath,
            request.canonicalWorkspacePath,
          ) ? oldParent.title ?? null : null,
        };
        state.before = before;

        let destination: SessionData | null = null;
        if (normalizedWorkstreamId) {
          destination = await this.repository.get(normalizedWorkstreamId);
          if (!destination || !this.matchesWorkspace(destination.workspacePath, request.canonicalWorkspacePath)) {
            throw this.error(request, 'WORKSTREAM_NOT_FOUND');
          }
          if (
            destination.sessionType !== 'workstream' ||
            Boolean(destination.parentSessionId) ||
            Boolean(destination.worktreeId) ||
            destination.isArchived === true
          ) {
            throw this.error(request, 'INVALID_WORKSTREAM_TARGET');
          }
        }

        const authority = captureSessionAuthoritySnapshot(target, 'session_set_workstream');
        const changed = before.workstreamId !== normalizedWorkstreamId;
        if (changed) {
          const intendedAfter: SessionWorkstreamState = {
            workstreamId: normalizedWorkstreamId,
            workstreamTitle: destination?.title ?? null,
          };
          await commit(before, intendedAfter, async () => {
            if (normalizedWorkstreamId && destination && this.repository.setWorkstreamMembershipIfDestinationValid) {
              await this.repository.setWorkstreamMembershipIfDestinationValid(
                target.id,
                normalizedWorkstreamId,
                request.auditId,
                before.workstreamId,
                context.workspacePath,
                request.canonicalWorkspacePath,
              );
            } else {
              await this.repository.setWorkstreamMembership(
                target.id, normalizedWorkstreamId, request.auditId,
                before.workstreamId, context.workspacePath, request.canonicalWorkspacePath,
              );
            }
          });
          try {
            const reloaded = await this.reloadTarget(request);
            assertAuthorityUnchanged(authority, reloaded, 'session_set_workstream');
            const authoritativeParent = reloaded.parentSessionId
              ? await this.repository.get(reloaded.parentSessionId)
              : null;
            const after: SessionWorkstreamState = {
              workstreamId: reloaded.parentSessionId ?? null,
              workstreamTitle: authoritativeParent && this.matchesWorkspace(
                authoritativeParent.workspacePath,
                request.canonicalWorkspacePath,
              ) ? authoritativeParent.title ?? null : null,
            };
            state.after = after;
            return {
              changed,
              before,
              after,
              reloadVerified: after.workstreamId === normalizedWorkstreamId,
            };
          } catch {
            state.after = intendedAfter;
            return { changed, before, after: intendedAfter, reloadVerified: false };
          }
        }
        const reloaded = await this.reloadTarget(request);
        assertAuthorityUnchanged(authority, reloaded, 'session_set_workstream');
        const authoritativeParent = reloaded.parentSessionId
          ? await this.repository.get(reloaded.parentSessionId)
          : null;
        const after: SessionWorkstreamState = {
          workstreamId: reloaded.parentSessionId ?? null,
          workstreamTitle: authoritativeParent && this.matchesWorkspace(
            authoritativeParent.workspacePath,
            request.canonicalWorkspacePath,
          ) ? authoritativeParent.title ?? null : null,
        };
        state.after = after;
        if (after.workstreamId !== normalizedWorkstreamId) throw this.error(request, 'CONFLICT');
        return { changed, before, after, reloadVerified: true };
      });
    }, (request, result) => {
      if (!result.changed) return [];
      const payload = {
        workspacePath: context.workspacePath,
        sessionId: request.targetSessionId,
        oldParentSessionId: result.before.workstreamId,
        newParentSessionId: result.after.workstreamId,
      };
      return [
        { channel: 'sessions:session-reparented', args: [payload] },
        {
          channel: 'sessions:session-updated',
          args: [request.targetSessionId, {
            workspacePath: context.workspacePath,
            parentSessionId: result.after.workstreamId,
            visibilityAuditId: request.auditId,
          }],
        },
        {
          channel: 'sessions:refresh-list',
          args: [{
            workspacePath: context.workspacePath,
            sessionId: request.targetSessionId,
          }],
        },
      ];
    });
  }

  async rename(
    context: SessionVisibilityContext,
    sessionId: string,
    name: string,
  ): Promise<SessionVisibilityReceipt<SessionRenameState>> {
    return this.runMutation('session_rename', context, sessionId, async (request, state, commit) => {
      const normalizedName = this.normalizeName(request, name);
      return withTargetLock(request.targetSessionId, async () => {
        const target = await this.loadAuthorizedTarget(request);
        const authority = captureSessionAuthoritySnapshot(target, 'session_rename');
        const before = {
          name: target.title ?? '',
          hasBeenNamed: target.hasBeenNamed === true,
        };
        state.before = before;
        const changed = before.name !== normalizedName || before.hasBeenNamed !== true;
        if (changed) {
          const intendedAfter = { name: normalizedName, hasBeenNamed: true };
          await commit(before, intendedAfter, () =>
            this.repository.renameExactSession(
              target.id, normalizedName, request.auditId,
              { title: before.name, hasBeenNamed: before.hasBeenNamed }, context.workspacePath,
              request.canonicalWorkspacePath,
            ));
          try {
            const reloaded = await this.reloadTarget(request);
            assertAuthorityUnchanged(authority, reloaded, 'session_rename');
            const after = {
              name: reloaded.title ?? '',
              hasBeenNamed: reloaded.hasBeenNamed === true,
            };
            state.after = after;
            return {
              changed,
              before,
              after,
              reloadVerified: after.name === normalizedName && after.hasBeenNamed,
            };
          } catch {
            state.after = intendedAfter;
            return { changed, before, after: intendedAfter, reloadVerified: false };
          }
        }
        const reloaded = await this.reloadTarget(request);
        assertAuthorityUnchanged(authority, reloaded, 'session_rename');
        const after = {
          name: reloaded.title ?? '',
          hasBeenNamed: reloaded.hasBeenNamed === true,
        };
        state.after = after;
        if (after.name !== normalizedName || !after.hasBeenNamed) {
          throw this.error(request, 'CONFLICT');
        }
        return { changed, before, after, reloadVerified: true };
      });
    }, (request, result) => {
      if (!result.changed) return [];
      return [
        {
          channel: 'session:title-updated',
          args: [{ sessionId: request.targetSessionId, title: result.after.name }],
        },
        {
          channel: 'sessions:session-updated',
          args: [request.targetSessionId, {
            workspacePath: context.workspacePath,
            title: result.after.name,
            visibilityAuditId: request.auditId,
          }],
        },
      ];
    });
  }

  private async runMutation<TState extends SessionVisibilityState>(
    operation: SessionVisibilityOperation,
    context: SessionVisibilityContext,
    rawSessionId: unknown,
    mutate: (
      request: RequestEnvelope,
      auditStateValue: AuditState,
      commit: (
        before: TState,
        after: TState,
        write: () => Promise<void>,
      ) => Promise<void>,
    ) => Promise<{
      changed: boolean;
      before: TState;
      after: TState;
      reloadVerified: boolean;
    }>,
    buildConvergenceEvents: (
      request: RequestEnvelope,
      result: { changed: boolean; before: TState; after: TState },
    ) => ConvergenceEvent[],
  ): Promise<SessionVisibilityReceipt<TState>> {
    this.assertStorageRootOwnership();
    const now = this.now();
    const timestamp = new Date(now).toISOString();
    const auditId = this.randomId().slice(0, 200);
    const correlationId = boundedCorrelationId(context?.correlationId);
    const provisionalWorkspace = typeof context?.workspacePath === 'string' && context.workspacePath.trim()
      ? canonicalizeSessionWorkspacePath(context.workspacePath)
      : 'unknown';
    const request: RequestEnvelope = {
      operation,
      auditId,
      timestamp,
      actorSessionId: typeof context?.actorSessionId === 'string'
        ? context.actorSessionId.trim().slice(0, MAX_SESSION_ID_LENGTH)
        : '',
      actorKind: context?.actorKind === 'renderer-user' && context?.source === 'renderer-ipc'
        ? 'renderer-user'
        : 'session',
      targetSessionId: typeof rawSessionId === 'string'
        ? rawSessionId.trim().slice(0, MAX_SESSION_ID_LENGTH)
        : '',
      canonicalWorkspacePath: provisionalWorkspace,
      workspaceId: workspaceReceiptId(provisionalWorkspace),
      source: context?.source === 'renderer-ipc' ? 'renderer-ipc' : 'mcp-host',
      correlationId,
    };
    const state: AuditState = { before: null, after: null };
    let auditResult: 'recorded' | 'pending' | null = null;
    let committedIntent: SessionVisibilityMutationIntent | null = null;
    const persistAudit = async (
      outcome: SessionVisibilityAuditEvent['outcome'],
      reasonCode: SessionVisibilityErrorCode | null,
    ): Promise<'recorded' | 'pending'> => {
      if (auditResult) return auditResult;
      auditResult = await this.recordAudit({
        event: 'session_visibility_control',
        auditId,
        timestamp,
        source: request.source,
        operation,
        outcome,
        actorSessionId: request.actorSessionId,
        actorKind: request.actorKind,
        targetSessionId: request.targetSessionId,
        workspaceId: request.workspaceId,
        before: auditState(operation, state.before),
        after: auditState(operation, state.after),
        reasonCode,
        correlationId,
      });
      return auditResult;
    };

    const commit = async (
      before: TState,
      after: TState,
      write: () => Promise<void>,
    ): Promise<void> => {
      state.before = before;
      state.after = after;
      const descriptor: SessionVisibilityDeliveryDescriptor = {
        auditId,
        operation,
        targetSessionId: request.targetSessionId,
        workspaceId: request.workspaceId,
        workspacePath: context.workspacePath,
        before: auditState(operation, before),
        after: auditState(operation, after),
      };
      const intent: SessionVisibilityMutationIntent = {
        auditId,
        operation,
        phase: 'reserved',
        reservationOwnerId: this.reservationOwnerId,
        targetSessionId: request.targetSessionId,
        workspaceId: request.workspaceId,
        beforeStateId: stateIdentity(operation, before),
        afterStateId: stateIdentity(operation, after),
        mutationIdentity: storeMutationIdentity(
          request.targetSessionId,
          operation,
          request.canonicalWorkspacePath,
          before,
          after,
        ),
        audit: {
          event: 'session_visibility_control',
          auditId,
          timestamp,
          source: request.source,
          operation,
          outcome: 'changed',
          actorSessionId: request.actorSessionId,
          actorKind: request.actorKind,
          targetSessionId: request.targetSessionId,
          workspaceId: request.workspaceId,
          before: descriptor.before,
          after: descriptor.after,
          reasonCode: null,
          correlationId,
        },
        delivery: descriptor,
      };
      this.liveReservations.add(auditId);
      try {
        await this.withStorageRootFence(() => this.convergenceOutbox.reserveMutation(intent));
      } catch (error) {
        this.liveReservations.delete(auditId);
        state.after = before;
        throw error;
      }
      try {
        await this.withStorageRootWriteFence(write);
      } catch (error) {
        state.after = before;
        await this.withStorageRootFence(
          () => this.convergenceOutbox.markMutationAborted(auditId),
        ).catch(() => undefined);
        this.liveReservations.delete(auditId);
        throw error;
      }
      committedIntent = intent;
      try {
        await this.withStorageRootFence(
          () => this.convergenceOutbox.markMutationCommitted(auditId),
        ).catch(() => undefined);
      } finally {
        this.liveReservations.delete(auditId);
      }
    };

    try {
      void this.withStorageRootFence(
        () => this.convergenceOutbox.flush(),
      ).catch(() => undefined);
      request.actorSessionId = this.requireId(request, context?.actorSessionId, 'actorSessionId');
      request.targetSessionId = this.requireId(request, rawSessionId, 'sessionId');
      if (typeof context?.workspacePath !== 'string' || !context.workspacePath.trim()) {
        throw this.error(request, 'INVALID_ARGUMENT');
      }
      if (context.requestArgumentsValid === false) {
        throw this.error(request, 'INVALID_ARGUMENT');
      }
      request.canonicalWorkspacePath = canonicalizeSessionWorkspacePath(context.workspacePath);
      request.workspaceId = workspaceReceiptId(request.canonicalWorkspacePath);
      this.enforceRateLimit(request, now);

      const result = await mutate(request, state, commit);
      let deliveryStatus: 'delivered' | 'pending';
      let auditStatus: 'recorded' | 'pending';
      if (result.changed && committedIntent) {
        deliveryStatus = result.reloadVerified
          ? await this.deliverCommittedConvergence(
              buildConvergenceEvents(request, result),
              committedIntent,
            )
          : 'pending';
        auditStatus = await this.recordCommittedAudit(committedIntent);
        void this.withStorageRootFence(
          () => this.convergenceOutbox.flush(),
        ).catch(() => undefined);
      } else {
        deliveryStatus = 'delivered';
        auditStatus = await persistAudit('noop', null);
      }
      return {
        ok: true,
        operation,
        auditId,
        timestamp,
        actorSessionId: request.actorSessionId,
        actorKind: request.actorKind,
        targetSessionId: request.targetSessionId,
        workspaceId: request.workspaceId,
        auditStatus,
        deliveryStatus,
        ...result,
      };
    } catch (caught) {
      const error = caught instanceof SessionVisibilityControlError
        ? caught
        : this.error(request, 'INTERNAL_ERROR');
      const denied = [
        'INVALID_ARGUMENT',
        'TARGET_NOT_FOUND',
        'WORKSTREAM_NOT_FOUND',
        'INVALID_WORKSTREAM_TARGET',
        'RATE_LIMITED',
      ].includes(error.code);
      error.auditStatus = await persistAudit(denied ? 'denied' : 'failed', error.code);
      throw error;
    }
  }

  private async recordAudit(
    event: SessionVisibilityAuditEvent,
  ): Promise<'recorded' | 'pending'> {
    try {
      await this.withStorageRootFence(() => Promise.resolve(this.auditSink(event)));
      return 'recorded';
    } catch {
      await this.withStorageRootFence(
        () => this.convergenceOutbox.enqueueAudit(event),
      ).catch(() => undefined);
      return 'pending';
    }
  }

  private async recordCommittedAudit(
    intent: SessionVisibilityMutationIntent,
  ): Promise<'recorded' | 'pending'> {
    try {
      await this.withStorageRootFence(() => Promise.resolve(this.auditSink(intent.audit)));
      await this.withStorageRootFence(
        () => this.convergenceOutbox.acknowledgeMutationAudit(intent.auditId),
      ).catch(() => undefined);
      return 'recorded';
    } catch {
      return 'pending';
    }
  }

  private async deliverCommittedConvergence(
    events: ConvergenceEvent[],
    intent: SessionVisibilityMutationIntent,
  ): Promise<'delivered' | 'pending'> {
    if (events.length === 0) {
      await this.withStorageRootFence(
        () => this.convergenceOutbox.acknowledgeMutationDelivery(intent.auditId),
      ).catch(() => undefined);
      return 'delivered';
    }
    try {
      await this.deliverEventsWithRendererAck(events, intent.delivery!);
      await this.withStorageRootFence(
        () => this.convergenceOutbox.acknowledgeMutationDelivery(intent.auditId),
      ).catch(() => undefined);
      return 'delivered';
    } catch {
      return 'pending';
    }
  }

  private async replayDelivery(
    descriptor: SessionVisibilityDeliveryDescriptor,
  ): Promise<void> {
    this.assertStorageRootOwnership();
    if (!this.broadcasterReady) throw new Error('renderer broadcaster unavailable');
    const target = await this.withStorageRootFence(
      () => this.repository.get(descriptor.targetSessionId),
    );
    if (!target?.workspacePath) throw new Error('target unavailable for convergence');
    const canonicalWorkspacePath = canonicalizeSessionWorkspacePath(target.workspacePath);
    if (workspaceReceiptId(canonicalWorkspacePath) !== descriptor.workspaceId) {
      throw new Error('target workspace changed before convergence');
    }
    const operationalWorkspacePath = await this.resolveOperationalWorkspacePath(descriptor);

    const events: ConvergenceEvent[] = [];
    if (descriptor.operation === 'session_set_pinned') {
      events.push({
        channel: 'sessions:session-updated',
        args: [target.id, {
          workspacePath: operationalWorkspacePath,
          isPinned: target.isPinned === true,
          visibilityAuditId: descriptor.auditId,
        }],
      });
    } else if (descriptor.operation === 'session_set_workstream') {
      const oldParentSessionId = typeof descriptor.before?.workstreamId === 'string'
        ? descriptor.before.workstreamId
        : null;
      const newParentSessionId = target.parentSessionId ?? null;
      events.push(
        {
          channel: 'sessions:session-reparented',
          args: [{
            workspacePath: operationalWorkspacePath,
            sessionId: target.id,
            oldParentSessionId,
            newParentSessionId,
          }],
        },
        {
          channel: 'sessions:session-updated',
          args: [target.id, {
            workspacePath: operationalWorkspacePath,
            parentSessionId: newParentSessionId,
            visibilityAuditId: descriptor.auditId,
          }],
        },
        {
          channel: 'sessions:refresh-list',
          args: [{ workspacePath: operationalWorkspacePath, sessionId: target.id }],
        },
      );
    } else {
      events.push(
        {
          channel: 'session:title-updated',
          args: [{ sessionId: target.id, title: target.title ?? '' }],
        },
        {
          channel: 'sessions:session-updated',
          args: [target.id, {
            workspacePath: operationalWorkspacePath,
            title: target.title ?? '',
            visibilityAuditId: descriptor.auditId,
          }],
        },
      );
    }
    await this.withStorageRootFence(
      () => this.deliverEventsWithRendererAck(events, descriptor),
    );
  }

  private async deliverEventsWithRendererAck(
    events: ConvergenceEvent[],
    descriptor: SessionVisibilityDeliveryDescriptor,
  ): Promise<void> {
    if (!this.broadcasterReady) throw new Error('renderer broadcaster unavailable');
    const operationalWorkspacePath = await this.resolveOperationalWorkspacePath(descriptor);
    const key = `${descriptor.workspaceId}:${descriptor.auditId}`;
    let settled = false;
    let timer!: NodeJS.Timeout;
    const ack = new Promise<void>((resolve, reject) => {
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.rendererAckWaiters.delete(key);
        resolve();
      };
      this.rendererAckWaiters.set(key, finish);
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.rendererAckWaiters.delete(key);
        reject(new Error('matching renderer did not acknowledge visibility delivery'));
      }, this.rendererAckTimeoutMs);
      timer.unref?.();
    });
    let hostReportedApplied = false;
    try {
      for (const event of events) {
        const args = event.args.map((arg) => (
          arg && typeof arg === 'object' && 'workspacePath' in arg
            ? { ...(arg as Record<string, unknown>), workspacePath: operationalWorkspacePath }
            : arg
        ));
        const result = await this.withStorageRootFence(
          () => Promise.resolve(this.broadcaster(operationalWorkspacePath, event.channel, ...args)),
        );
        if (result !== false) hostReportedApplied = true;
      }
      const markerResult = await this.withStorageRootFence(() => Promise.resolve(this.broadcaster(
          operationalWorkspacePath,
          'sessions:visibility-delivery',
          {
            auditId: descriptor.auditId,
            workspaceId: descriptor.workspaceId,
            workspacePath: operationalWorkspacePath,
            targetSessionId: descriptor.targetSessionId,
          },
        )));
      if (markerResult !== false && hostReportedApplied) {
        settled = true;
        clearTimeout(timer);
        this.rendererAckWaiters.delete(key);
        return;
      }
      await ack;
    } catch (error) {
      settled = true;
      clearTimeout(timer!);
      this.rendererAckWaiters.delete(key);
      throw error;
    }
  }

  private async resolveOperationalWorkspacePath(
    descriptor: SessionVisibilityDeliveryDescriptor,
  ): Promise<string> {
    if (!descriptor.workspacePath) {
      throw new Error('durable operational renderer workspace unavailable');
    }
    const resolved = this.operationalWorkspaceResolver
      ? await this.operationalWorkspaceResolver(descriptor.workspaceId, descriptor.workspacePath)
      : descriptor.workspacePath;
    if (!resolved || workspaceReceiptId(canonicalizeSessionWorkspacePath(resolved)) !== descriptor.workspaceId) {
      throw new Error('current operational renderer workspace unavailable');
    }
    return resolved;
  }

  private async resolveReservedMutation(
    intent: SessionVisibilityMutationIntent,
  ): Promise<'committed' | 'aborted' | 'pending' | 'unattributable'> {
    this.assertStorageRootOwnership();
    if (
      intent.reservationOwnerId === this.reservationOwnerId &&
      this.liveReservations.has(intent.auditId)
    ) {
      return 'pending';
    }
    if (typeof intent.mutationIdentity !== 'string' || !intent.mutationIdentity) {
      // Upgrade rule for pre-fingerprint journals: never infer success from
      // visible state. The outbox first records a bounded failed-reconciliation
      // audit under the stable auditId, then terminally aborts the reservation.
      return 'unattributable';
    }
    try {
      return await this.withStorageRootFence(() => this.repository.hasVisibilityMutation(
        intent.targetSessionId,
        intent.auditId,
        intent.mutationIdentity,
      ))
        ? 'committed'
        : 'aborted';
    } catch {
      return 'pending';
    }
  }

  private requireId(request: RequestEnvelope, value: unknown, _field: string): string {
    try {
      return requireBoundedString(value, 'id', MAX_SESSION_ID_LENGTH);
    } catch {
      throw this.error(request, 'INVALID_ARGUMENT');
    }
  }

  private normalizeName(request: RequestEnvelope, value: unknown): string {
    if (typeof value !== 'string') throw this.error(request, 'INVALID_ARGUMENT');
    const normalized = value.trim();
    if (!normalized || normalized.length > MAX_NAME_LENGTH || /[\u0000-\u001F\u007F]/u.test(normalized)) {
      throw this.error(request, 'INVALID_ARGUMENT');
    }
    return normalized;
  }

  private enforceRateLimit(request: RequestEnvelope, now: number): void {
    const bucket = this.rateLimitBuckets.get(request.actorSessionId);
    if (!bucket || now - bucket.windowStart >= this.rateLimitWindowMs) {
      if (!bucket && this.rateLimitBuckets.size >= MAX_RATE_LIMIT_BUCKETS) {
        const oldestActor = this.rateLimitBuckets.keys().next().value;
        if (oldestActor) this.rateLimitBuckets.delete(oldestActor);
      }
      this.rateLimitBuckets.set(request.actorSessionId, { windowStart: now, count: 1 });
      return;
    }
    if (bucket.count >= this.rateLimitMax) {
      throw this.error(
        request,
        'RATE_LIMITED',
        Math.max(1, this.rateLimitWindowMs - (now - bucket.windowStart)),
      );
    }
    bucket.count += 1;
  }

  private async loadAuthorizedTarget(request: RequestEnvelope): Promise<SessionData> {
    const actor = request.actorKind === 'session'
      ? await this.repository.get(request.actorSessionId)
      : null;
    if (request.actorKind === 'session' && (
      !actor || !this.matchesWorkspace(actor.workspacePath, request.canonicalWorkspacePath)
    )) {
      throw this.error(request, 'TARGET_NOT_FOUND');
    }
    const target = actor?.id === request.targetSessionId
      ? actor
      : await this.repository.get(request.targetSessionId);
    if (!target || !this.matchesWorkspace(target.workspacePath, request.canonicalWorkspacePath)) {
      throw this.error(request, 'TARGET_NOT_FOUND');
    }
    return target;
  }

  private async reloadTarget(request: RequestEnvelope): Promise<SessionData> {
    const target = await this.repository.get(request.targetSessionId);
    if (!target || !this.matchesWorkspace(target.workspacePath, request.canonicalWorkspacePath)) {
      throw this.error(request, 'CONFLICT');
    }
    return target;
  }

  private matchesWorkspace(value: string | undefined, canonicalWorkspacePath: string): boolean {
    return typeof value === 'string' && value.trim().length > 0 &&
      canonicalizeSessionWorkspacePath(value) === canonicalWorkspacePath;
  }

  private error(
    request: RequestEnvelope,
    code: SessionVisibilityErrorCode,
    retryAfterMs?: number,
  ): SessionVisibilityControlError {
    return new SessionVisibilityControlError({
      code,
      auditId: request.auditId,
      timestamp: request.timestamp,
      correlationId: request.correlationId,
      retryAfterMs,
    });
  }
}
