import {
  FeedbackRequestSync,
  type FeedbackRequestNudgeReceipt,
  type FeedbackRequestSyncEvent,
  type FeedbackRequestSyncState,
  type FeedbackRequestTarget,
  type TeamJwt,
} from '@nimbalyst/runtime';
import type { TeamMemberId } from '@nimbalyst/runtime/auth/jwtScopes';
import {
  validateFeedbackRequest,
  type FeedbackAnswer,
  type FeedbackDiscussionComment,
  type FeedbackRequestCreateInput,
  type FeedbackRequestLifecycleStatus,
  type RichCommentBody,
} from '@nimbalyst/collab-protocol';

import type {
  FeedbackRequestCreateIpcRequest,
  FeedbackRequestServiceState,
  FeedbackRequestServiceTarget,
} from '../../shared/feedbackRequest';

import { getCollabSyncHttpUrl } from '../utils/collabSyncUrl';
import { getSubFromJwt } from './jwtOrg';
import { getOrgScopedJwt } from './TeamService';
import {
  FeedbackRequestPersistence,
  type FeedbackRequestPersistenceTarget,
} from './FeedbackRequestPersistence';

const PERSIST_DEBOUNCE_MS = 40;

export interface FeedbackRequestServiceDependencies {
  getTeamJwt: (orgId: string) => Promise<TeamJwt>;
  getTeamMemberId: (jwt: TeamJwt) => TeamMemberId | null;
  getServerUrl: () => string;
  persistence: FeedbackRequestPersistence;
  createSync?: (
    target: FeedbackRequestTarget,
    getTeamJwt: () => Promise<TeamJwt>,
  ) => FeedbackRequestSync;
  setTimer?: (
    callback: () => void,
    delayMs: number,
  ) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

/**
 * Main-process owner for workspace-scoped FeedbackRequestRoom connections and
 * their durable local projections.
 */
export class FeedbackRequestService {
  private readonly dependencies: FeedbackRequestServiceDependencies;
  private readonly clients = new Map<string, FeedbackRequestSync>();
  private readonly cleanups = new Map<string, () => void>();
  private readonly states = new Map<string, FeedbackRequestServiceState>();
  private readonly loaded = new Set<string>();
  private readonly persistTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly listeners = new Set<
    (state: FeedbackRequestServiceState) => void
  >();

  constructor(dependencies: FeedbackRequestServiceDependencies) {
    this.dependencies = dependencies;
  }

  subscribe(
    listener: (state: FeedbackRequestServiceState) => void,
  ): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  async start(
    target: FeedbackRequestServiceTarget,
  ): Promise<FeedbackRequestServiceState> {
    assertTarget(target);
    const scopedTarget = await this.scopeTarget(target);
    await this.loadCached(scopedTarget);
    const sync = await this.ensureSync(scopedTarget);
    const state = await sync.sync();
    await this.applySyncedState(scopedTarget, state, true);
    return this.currentState(scopedTarget);
  }

  async getCached(
    target: FeedbackRequestServiceTarget,
  ): Promise<FeedbackRequestServiceState> {
    assertTarget(target);
    const scopedTarget = await this.scopeTarget(target);
    await this.loadCached(scopedTarget);
    return this.currentState(scopedTarget);
  }

  async create(
    target: FeedbackRequestServiceTarget,
    clientMutationId: string,
    request: FeedbackRequestCreateIpcRequest['request'],
  ): Promise<FeedbackRequestServiceState> {
    assertTarget(target);
    assertMutationId(clientMutationId);
    if (request.id !== target.requestId || request.orgId !== target.orgId) {
      throw new Error('Feedback request identity must match its target');
    }
    const validation = validateFeedbackRequest(request);
    if (!validation.valid) {
      throw new Error(validation.errors.map((error) => error.message).join(' '));
    }
    const scopedTarget = await this.scopeTarget(target);
    // The author's org-scoped member id comes from the team JWT, never from the
    // caller: a renderer knows the session, main knows who that session belongs
    // to in this org.
    const authored: FeedbackRequestCreateInput = {
      ...request,
      author: { ...request.author, onBehalfOfUserId: scopedTarget.teamMemberId },
    };
    await this.loadCached(scopedTarget);
    const sync = await this.ensureSync(scopedTarget);
    const state = await sync.create(clientMutationId, authored);
    await this.applySyncedState(scopedTarget, state, true);
    return this.currentState(scopedTarget);
  }

  async respond(
    target: FeedbackRequestServiceTarget,
    clientMutationId: string,
    askId: string,
    answer: FeedbackAnswer,
  ): Promise<FeedbackRequestServiceState> {
    assertTarget(target);
    assertMutationId(clientMutationId);
    if (!askId) throw new Error('Feedback response ask id is required');
    const scopedTarget = await this.scopeTarget(target);
    const sync = await this.ensureState(scopedTarget);
    const state = await sync.respond(clientMutationId, askId, answer);
    await this.applySyncedState(scopedTarget, state, true);
    return this.currentState(scopedTarget);
  }

  async comment(
    target: FeedbackRequestServiceTarget,
    clientMutationId: string,
    body: RichCommentBody,
    replyToCommentId?: string,
  ): Promise<FeedbackDiscussionComment> {
    assertTarget(target);
    assertMutationId(clientMutationId);
    const scopedTarget = await this.scopeTarget(target);
    const sync = await this.ensureState(scopedTarget);
    return sync.comment(clientMutationId, body, replyToCommentId);
  }

  async close(
    target: FeedbackRequestServiceTarget,
    clientMutationId: string,
    status: Exclude<FeedbackRequestLifecycleStatus, 'open'>,
  ): Promise<FeedbackRequestServiceState> {
    assertTarget(target);
    assertMutationId(clientMutationId);
    const scopedTarget = await this.scopeTarget(target);
    const sync = await this.ensureState(scopedTarget);
    const state = await sync.close(clientMutationId, status);
    await this.applySyncedState(scopedTarget, state, true);
    return this.currentState(scopedTarget);
  }

  async nudge(
    target: FeedbackRequestServiceTarget,
    clientMutationId: string,
    recipientUserIds?: string[],
  ): Promise<FeedbackRequestNudgeReceipt> {
    assertTarget(target);
    assertMutationId(clientMutationId);
    const scopedTarget = await this.scopeTarget(target);
    const sync = await this.ensureState(scopedTarget);
    return sync.nudge(clientMutationId, recipientUserIds);
  }

  destroy(): void {
    for (const cleanup of this.cleanups.values()) cleanup();
    this.cleanups.clear();
    for (const client of this.clients.values()) client.destroy();
    this.clients.clear();
    for (const timer of this.persistTimers.values()) this.clearTimer(timer);
    this.persistTimers.clear();
    this.states.clear();
    this.loaded.clear();
    this.listeners.clear();
  }

  private async ensureState(
    target: FeedbackRequestPersistenceTarget,
  ): Promise<FeedbackRequestSync> {
    await this.loadCached(target);
    const sync = await this.ensureSync(target);
    if (!sync.getState()) {
      const state = await sync.sync();
      await this.applySyncedState(target, state, true);
    }
    return sync;
  }

  private async ensureSync(
    target: FeedbackRequestPersistenceTarget,
  ): Promise<FeedbackRequestSync> {
    const key = targetKey(target);
    const existing = this.clients.get(key);
    if (existing) {
      await existing.connect();
      return existing;
    }

    const syncTarget = { orgId: target.orgId, requestId: target.requestId };
    const getTeamJwt = async () => {
      const jwt = await this.dependencies.getTeamJwt(target.orgId);
      if (this.dependencies.getTeamMemberId(jwt) !== target.teamMemberId) {
        throw new Error('Feedback request team identity changed');
      }
      return jwt;
    };
    const sync = this.dependencies.createSync
      ? this.dependencies.createSync(syncTarget, getTeamJwt)
      : new FeedbackRequestSync({
          serverUrl: this.dependencies.getServerUrl(),
          target: syncTarget,
          getTeamJwt,
        });
    this.clients.set(key, sync);
    let hasConnected = false;
    this.cleanups.set(key, sync.subscribe((event) => {
      if (event.type === 'connected') hasConnected = true;
      else if (event.type === 'disconnected' && !hasConnected) {
        this.cleanups.get(key)?.();
        this.cleanups.delete(key);
        if (this.clients.get(key) === sync) {
          this.clients.delete(key);
          sync.destroy();
        }
      }
      this.handleSyncEvent(target, event);
    }));
    try {
      await sync.connect();
      return sync;
    } catch (error) {
      this.cleanups.get(key)?.();
      this.cleanups.delete(key);
      this.clients.delete(key);
      sync.destroy();
      throw error;
    }
  }

  private handleSyncEvent(
    target: FeedbackRequestPersistenceTarget,
    event: FeedbackRequestSyncEvent,
  ): void {
    if (event.type === 'state') {
      void this.applySyncedState(target, event.state, false);
      return;
    }
    if (event.type === 'nudged') {
      this.updateState(target, { lastNudge: event.receipt });
      return;
    }
    if (event.type === 'error') {
      this.updateState(target, {
        status: 'error',
        error: { code: event.code, message: event.message },
      });
      return;
    }
    this.updateState(target, {
      status: event.type,
      ...(event.type === 'connecting' || event.type === 'connected'
        ? { error: undefined }
        : {}),
    });
  }

  private async loadCached(
    target: FeedbackRequestPersistenceTarget,
  ): Promise<void> {
    const key = targetKey(target);
    if (this.loaded.has(key)) return;
    this.loaded.add(key);
    const cached = await this.dependencies.persistence.load(target);
    if (cached) {
      this.updateState(target, {
        status: 'cached',
        request: cached.request,
        progress: cached.progress,
      });
    }
  }

  private async applySyncedState(
    target: FeedbackRequestPersistenceTarget,
    state: FeedbackRequestSyncState,
    persistNow: boolean,
  ): Promise<void> {
    this.updateState(target, {
      request: state.request,
      progress: state.progress,
    });
    if (persistNow) {
      const key = targetKey(target);
      const timer = this.persistTimers.get(key);
      if (timer) this.clearTimer(timer);
      this.persistTimers.delete(key);
      await this.dependencies.persistence.save(target, state);
    } else {
      this.schedulePersist(target, state);
    }
  }

  private schedulePersist(
    target: FeedbackRequestPersistenceTarget,
    state: FeedbackRequestSyncState,
  ): void {
    const key = targetKey(target);
    const current = this.persistTimers.get(key);
    if (current) this.clearTimer(current);
    const timer = this.setTimer(() => {
      this.persistTimers.delete(key);
      void this.dependencies.persistence.save(target, state);
    }, PERSIST_DEBOUNCE_MS);
    this.persistTimers.set(key, timer);
  }

  private updateState(
    target: FeedbackRequestPersistenceTarget,
    patch: Partial<FeedbackRequestServiceState>,
  ): void {
    const key = targetKey(target);
    const next = {
      ...this.currentState(target),
      ...patch,
    };
    this.states.set(key, next);
    for (const listener of this.listeners) listener(next);
  }

  private currentState(
    target: FeedbackRequestPersistenceTarget,
  ): FeedbackRequestServiceState {
    return this.states.get(targetKey(target)) ?? {
      ...target,
      status: 'idle',
    };
  }

  private async scopeTarget(
    target: FeedbackRequestServiceTarget,
  ): Promise<FeedbackRequestPersistenceTarget> {
    const jwt = await this.dependencies.getTeamJwt(target.orgId);
    const teamMemberId = this.dependencies.getTeamMemberId(jwt);
    if (!teamMemberId) {
      throw new Error('Feedback request team member identity is unavailable');
    }
    this.discardOtherViewers(target.orgId, teamMemberId);
    return { ...target, teamMemberId };
  }

  private discardOtherViewers(orgId: string, teamMemberId: TeamMemberId): void {
    for (const key of [...this.clients.keys()]) {
      const [, keyOrgId, keyViewerUserId] = JSON.parse(key) as string[];
      if (keyOrgId !== orgId || keyViewerUserId === teamMemberId) continue;
      this.cleanups.get(key)?.();
      this.cleanups.delete(key);
      this.clients.get(key)?.destroy();
      this.clients.delete(key);
      const timer = this.persistTimers.get(key);
      if (timer) this.clearTimer(timer);
      this.persistTimers.delete(key);
      this.states.delete(key);
      this.loaded.delete(key);
    }
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

function targetKey(target: FeedbackRequestPersistenceTarget): string {
  return JSON.stringify([
    target.workspacePath,
    target.orgId,
    target.teamMemberId,
    target.requestId,
  ]);
}

function assertTarget(
  target: Partial<FeedbackRequestServiceTarget> | null | undefined,
): asserts target is FeedbackRequestServiceTarget {
  if (!target?.workspacePath || !target.orgId || !target.requestId) {
    throw new Error(
      'Feedback request workspace, organization, and request ids are required',
    );
  }
}

function assertMutationId(clientMutationId: string): void {
  if (!clientMutationId) {
    throw new Error('Feedback request clientMutationId is required');
  }
}

let service: FeedbackRequestService | null = null;

export function getFeedbackRequestService(): FeedbackRequestService {
  if (!service) {
    service = new FeedbackRequestService({
      getTeamJwt: (orgId) => getOrgScopedJwt(orgId),
      getTeamMemberId: getSubFromJwt,
      getServerUrl: getCollabSyncHttpUrl,
      persistence: new FeedbackRequestPersistence(),
    });
  }
  return service;
}

export function shutdownFeedbackRequestService(): void {
  service?.destroy();
  service = null;
}
