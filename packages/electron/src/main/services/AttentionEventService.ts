import { randomUUID } from 'crypto';
import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import type { AttentionSummary } from '@nimbalyst/runtime/sync/types';
import type { SessionStateEvent } from '@nimbalyst/runtime/ai/server/types/SessionState';
import { getSessionStateManager } from '@nimbalyst/runtime/ai/server/SessionStateManager';

const ATTENTION_METADATA_KEY = 'attentionEvents';
const MAX_ATTENTION_EVENTS_PER_SESSION = 100;
const DEFAULT_ESCALATION_DELAY_MS = 10 * 60 * 1000;
const DIRECT_ATTENTION_RATE_WINDOW_MS = 60 * 1000;
const DIRECT_ATTENTION_RATE_LIMIT = 10;

export type AttentionSeverity = 'low' | 'normal' | 'critical';
export type AttentionEventStatus = 'pending' | 'cancelled';
export type AttentionCancelReason =
  | 'manual'
  | 'answered'
  | 'cancelled'
  | 'superseded'
  | 'completed'
  | 'interrupted'
  | 'error'
  | 'provider_limit';

export interface AttentionImmediateReceipt {
  requested: boolean;
  attempted: boolean;
  skippedReason: string | null;
  recordedAt: string;
  error?: string;
  local?: {
    attempted: boolean;
    shown: boolean;
    skippedReason: string | null;
  };
  mobile?: {
    attempted: boolean;
    requestFrameWritten: boolean;
    outcome: 'skipped' | 'failed' | 'request_frame_written';
    skippedReason: string | null;
    bypassActiveDeviceRouting: boolean;
    forceDesktopAwayForPush: boolean;
    error?: string;
  };
}

export interface AttentionEvent {
  id: string;
  sessionId: string;
  promptId?: string;
  toolUseId?: string;
  progressFingerprint?: string;
  /** Opaque turn identity used for generation-safe terminal settlement. */
  attentionGeneration?: string;
  kind: 'generic' | 'interactive_prompt';
  promptType?: string;
  /** Bounded local-only prompt context; never copied into the synced summary. */
  context?: unknown;
  severity: AttentionSeverity;
  deadline: string | null;
  dedupeKey: string;
  status: AttentionEventStatus;
  armedAt: string;
  doNotDisturb: boolean;
  immediateReceipt: AttentionImmediateReceipt;
  dedupeCount: number;
  lastDeduplicatedAt?: string;
  cancelledAt?: string;
  cancelReason?: AttentionCancelReason;
  cancelDetail?: string;
}

export interface ArmAttentionArgs {
  sessionId: string;
  promptId?: string;
  toolUseId?: string;
  progressFingerprint?: string;
  severity: AttentionSeverity;
  deadline?: string;
  dedupeKey: string;
  doNotDisturb?: boolean;
  title?: string;
  body?: string;
  /** Internal-only discriminator used by authoritative prompt-open paths. */
  kind?: 'generic' | 'interactive_prompt';
  /** Internal-only bounded prompt kind (AskUserQuestion, ToolPermission, etc.). */
  promptType?: string;
  /** Internal-only context, bounded before persistence. */
  context?: unknown;
  /** Internal-only turn identity; inferred from SessionStateManager when omitted. */
  attentionGeneration?: string;
}

export interface SettleTerminalAttentionArgs {
  attentionGeneration?: string;
  promptIdentity?: string;
  reason: Extract<AttentionCancelReason, 'completed' | 'interrupted' | 'error' | 'provider_limit'>;
}

export interface ArmInteractivePromptArgs {
  sessionId: string;
  promptType: string;
  promptId?: string;
  toolUseId?: string;
  severity?: AttentionSeverity;
  title?: string;
  /** Bounded notification preview only; the durable transcript remains authoritative. */
  body?: string;
  context?: unknown;
  /** Internal-only turn identity; inferred from SessionStateManager when omitted. */
  attentionGeneration?: string;
}

export interface CancelAttentionArgs {
  sessionId: string;
  eventId?: string;
  dedupeKey?: string;
  reason?: string;
}

export interface AttentionStatusArgs {
  sessionId: string;
  dedupeKey?: string;
  includeCancelled?: boolean;
}

export interface AttentionSession {
  id: string;
  title?: string | null;
  workspacePath?: string | null;
  metadata?: unknown;
}

export type AttentionNotifyUserJson = (
  callerSessionId: string,
  workspaceId: string,
  args: {
    title: string;
    body: string;
    sessionId: string;
    bypassFocusCheck: boolean;
    urgency: AttentionSeverity;
    mobilePush: 'always';
  }
) => Promise<string>;

export interface AttentionEventServiceDeps {
  getSession: (sessionId: string) => Promise<AttentionSession | null>;
  updateSessionMetadata: (sessionId: string, metadata: Record<string, unknown>) => Promise<void>;
  pushAttentionSummary: (sessionId: string, summary: AttentionSummary) => Promise<void>;
  now: () => Date;
  notifyUserJson?: AttentionNotifyUserJson;
}

export class AttentionEventService {
  private readonly deps: AttentionEventServiceDeps;
  private notifyUserJsonFn: AttentionNotifyUserJson | null;
  private readonly sessionLockTails = new Map<string, Promise<void>>();
  private readonly directArmAttempts = new Map<string, number[]>();

  constructor(deps: Partial<AttentionEventServiceDeps> = {}) {
    this.deps = {
      getSession: deps.getSession ?? ((sessionId) => AISessionsRepository.get(sessionId)),
      updateSessionMetadata:
        deps.updateSessionMetadata ??
        ((sessionId, metadata) => AISessionsRepository.updateMetadata(sessionId, { metadata })),
      pushAttentionSummary:
        deps.pushAttentionSummary ??
        (async (sessionId, summary) => {
          const { getSyncProvider } = await import('./SyncManager');
          const provider = getSyncProvider();
          if (!provider) return;
          if (provider.pushMetadataChangeWithResult) {
            const result = await provider.pushMetadataChangeWithResult(sessionId, {
              attentionSummary: summary,
            });
            if (result.outcome === 'queued') return;
            if (!result.indexFrameWritten) {
              throw new Error(
                `attention summary sync ${result.outcome}: ${result.skippedReason || result.error || 'not written'}`,
              );
            }
            return;
          }
          await Promise.resolve(provider.pushChange(sessionId, {
            type: 'metadata_updated',
            metadata: { attentionSummary: summary },
          }));
          throw new Error('attention summary sync write result unavailable');
        }),
      now: deps.now ?? (() => new Date()),
      notifyUserJson: deps.notifyUserJson,
    };
    this.notifyUserJsonFn = deps.notifyUserJson ?? null;
  }

  configureNotifier(notifyUserJson: AttentionNotifyUserJson): void {
    this.notifyUserJsonFn = notifyUserJson;
  }

  async arm(
    workspaceId: string,
    args: ArmAttentionArgs,
    options: { callerSessionId?: string; enforceDirectRateLimit?: boolean } = {},
  ): Promise<{
    event: AttentionEvent;
    deduplicated: boolean;
  }> {
    const stateGeneration = getSessionStateManager()
      .getSessionState(args.sessionId)?.attentionGeneration;
    const validated = this.validateArmArgs({
      ...args,
      ...(args.attentionGeneration || !stateGeneration
        ? {}
        : { attentionGeneration: stateGeneration }),
    });

    return this.withSessionLock(validated.sessionId, async () => {
      const session = await this.getWorkspaceSession(validated.sessionId, workspaceId);
      const events = this.readEvents(session);
      const now = this.deps.now().toISOString();
      const duplicate = events.find((event) => event.dedupeKey === validated.dedupeKey);

      if (duplicate) {
        duplicate.dedupeCount += 1;
        duplicate.lastDeduplicatedAt = now;
        await this.persistEvents(validated.sessionId, events);
        return { event: duplicate, deduplicated: true };
      }

      if (options.enforceDirectRateLimit) {
        this.consumeDirectArmRateLimit(
          options.callerSessionId || validated.sessionId,
          validated.sessionId,
        );
      }

      if (validated.kind === 'interactive_prompt') {
        this.cancelMatchingEvents(
          events,
          (event) => event.kind === 'interactive_prompt' && event.dedupeKey !== validated.dedupeKey,
          'superseded',
        );
      }

      const event: AttentionEvent = {
        id: randomUUID(),
        sessionId: validated.sessionId,
        ...(validated.promptId ? { promptId: validated.promptId } : {}),
        ...(validated.toolUseId ? { toolUseId: validated.toolUseId } : {}),
        ...(validated.progressFingerprint
          ? { progressFingerprint: validated.progressFingerprint }
          : {}),
        ...(validated.attentionGeneration
          ? { attentionGeneration: validated.attentionGeneration }
          : {}),
        kind: validated.kind,
        ...(validated.promptType ? { promptType: validated.promptType } : {}),
        ...(validated.context !== undefined ? { context: validated.context } : {}),
        severity: validated.severity,
        deadline: validated.deadline,
        dedupeKey: validated.dedupeKey,
        status: 'pending',
        armedAt: now,
        doNotDisturb: validated.doNotDisturb,
        immediateReceipt: {
          requested: true,
          attempted: false,
          skippedReason: validated.doNotDisturb ? 'do_not_disturb' : 'pending',
          recordedAt: now,
        },
        dedupeCount: 0,
      };

      events.push(event);
      await this.persistEvents(validated.sessionId, events);

      if (validated.doNotDisturb) {
        return { event, deduplicated: false };
      }

      if (!this.notifyUserJsonFn) {
        event.immediateReceipt = {
          requested: true,
          attempted: false,
          skippedReason: 'notifier_unavailable',
          recordedAt: this.deps.now().toISOString(),
        };
        await this.persistEvents(validated.sessionId, events);
        return { event, deduplicated: false };
      }

      try {
        const receiptJson = await this.notifyUserJsonFn(validated.sessionId, workspaceId, {
          title: validated.title || this.defaultNotificationTitle(validated.severity),
          body: validated.body || this.defaultNotificationBody(session),
          sessionId: validated.sessionId,
          bypassFocusCheck: true,
          urgency: validated.severity,
          mobilePush: 'always',
        });
        event.immediateReceipt = this.normalizeNotificationReceipt(receiptJson);
      } catch (error) {
        const errorMessage = this.boundReceiptError(error);
        event.immediateReceipt = {
          requested: true,
          attempted: false,
          skippedReason: 'error',
          error: errorMessage,
          recordedAt: this.deps.now().toISOString(),
        };
      }

      await this.persistEvents(validated.sessionId, events);
      return { event, deduplicated: false };
    });
  }

  async armInteractivePrompt(
    workspaceId: string,
    args: ArmInteractivePromptArgs,
  ): Promise<{ event: AttentionEvent; deduplicated: boolean }> {
    const promptType = this.requireBoundedString(args.promptType, 'promptType', 80);
    const promptId = this.optionalBoundedString(args.promptId, 'promptId', 300);
    const toolUseId = this.optionalBoundedString(args.toolUseId, 'toolUseId', 300);
    const identity = promptId || toolUseId;
    if (!identity) throw new Error('promptId or toolUseId is required');
    return this.arm(workspaceId, {
      sessionId: args.sessionId,
      ...(promptId ? { promptId } : {}),
      ...(toolUseId ? { toolUseId } : {}),
      ...(args.attentionGeneration ? { attentionGeneration: args.attentionGeneration } : {}),
      severity: args.severity || 'normal',
      dedupeKey: `interactive:${promptType}:${identity}`,
      kind: 'interactive_prompt',
      promptType,
      ...(args.title ? { title: args.title } : {}),
      ...(args.body ? { body: args.body } : {}),
      ...(args.context !== undefined ? { context: args.context } : {}),
    });
  }

  async cancelInteractivePrompt(
    sessionId: string,
    promptIdentity: string,
    reason: Extract<AttentionCancelReason, 'answered' | 'cancelled' | 'superseded' | 'provider_limit'>,
    options: { expectedGeneration?: string } = {},
  ): Promise<number> {
    const boundedSessionId = this.requireBoundedString(sessionId, 'sessionId', 200);
    const boundedIdentity = this.requireBoundedString(promptIdentity, 'promptIdentity', 300);
    const expectedGeneration = this.optionalBoundedString(
      options.expectedGeneration,
      'expectedGeneration',
      300,
    );
    return this.withSessionLock(boundedSessionId, async () => {
      const session = await this.deps.getSession(boundedSessionId);
      if (!session) return 0;
      const events = this.readEvents(session);
      const count = this.cancelMatchingEvents(
        events,
        (event) => event.kind === 'interactive_prompt' &&
          (!expectedGeneration || event.attentionGeneration === expectedGeneration) &&
          (event.promptId === boundedIdentity || event.toolUseId === boundedIdentity),
        reason,
      );
      if (count > 0) await this.persistEvents(boundedSessionId, events);
      return count;
    });
  }

  async getPendingInteractiveEvent(
    sessionId: string,
    promptIdentity: string,
  ): Promise<AttentionEvent | null> {
    const boundedSessionId = this.requireBoundedString(sessionId, 'sessionId', 200);
    const boundedIdentity = this.requireBoundedString(promptIdentity, 'promptIdentity', 300);
    const session = await this.deps.getSession(boundedSessionId);
    if (!session) return null;
    return this.readEvents(session).find((event) =>
      event.status === 'pending'
      && event.kind === 'interactive_prompt'
      && (event.promptId === boundedIdentity || event.toolUseId === boundedIdentity)
    ) ?? null;
  }

  async cancelAllForSession(
    sessionId: string,
    reason: Extract<AttentionCancelReason, 'completed' | 'interrupted' | 'error' | 'provider_limit' | 'cancelled'>,
  ): Promise<number> {
    return this.cancelPendingForLifecycle(sessionId, reason);
  }

  async settleTerminalAttention(
    sessionId: string,
    args: SettleTerminalAttentionArgs,
  ): Promise<number> {
    const boundedSessionId = this.requireBoundedString(sessionId, 'sessionId', 200);
    const attentionGeneration = this.optionalBoundedString(
      args.attentionGeneration,
      'attentionGeneration',
      300,
    );
    const promptIdentity = this.optionalBoundedString(
      args.promptIdentity,
      'promptIdentity',
      300,
    );
    return this.withSessionLock(boundedSessionId, async () => {
      const session = await this.deps.getSession(boundedSessionId);
      if (!session) return 0;
      const events = this.readEvents(session);
      const cancelledCount = this.cancelMatchingEvents(events, (event) => {
        if (event.kind === 'generic') {
          // Legacy/unscoped generic events retain the prior terminal cleanup
          // behavior. A generation-scoped event, however, requires an exact
          // supplied generation; an unscoped legacy terminal cannot erase it.
          return !event.attentionGeneration || Boolean(
            attentionGeneration &&
            event.attentionGeneration === attentionGeneration
          );
        }
        if (
          attentionGeneration &&
          event.attentionGeneration === attentionGeneration
        ) {
          return true;
        }
        return Boolean(promptIdentity && (
          event.promptId === promptIdentity || event.toolUseId === promptIdentity
        ));
      }, args.reason);
      if (cancelledCount > 0) {
        await this.persistEvents(boundedSessionId, events);
      }
      return cancelledCount;
    });
  }

  async cancel(workspaceId: string, args: CancelAttentionArgs): Promise<{
    cancelledCount: number;
    events: AttentionEvent[];
  }> {
    const sessionId = this.requireBoundedString(args.sessionId, 'sessionId', 200);
    const eventId = this.optionalBoundedString(args.eventId, 'eventId', 200);
    const dedupeKey = this.optionalBoundedString(args.dedupeKey, 'dedupeKey', 300);
    if (!eventId && !dedupeKey) {
      throw new Error('eventId or dedupeKey is required');
    }

    return this.withSessionLock(sessionId, async () => {
      const session = await this.getWorkspaceSession(sessionId, workspaceId);
      const events = this.readEvents(session);
      const cancelledCount = this.cancelMatchingEvents(
        events,
        (event) => (eventId ? event.id === eventId : event.dedupeKey === dedupeKey),
        'manual',
        this.optionalBoundedString(args.reason, 'reason', 500)
      );
      if (cancelledCount > 0) {
        await this.persistEvents(sessionId, events);
      }
      return { cancelledCount, events };
    });
  }

  async status(workspaceId: string, args: AttentionStatusArgs): Promise<{
    sessionId: string;
    defaultEscalationDelayMs: number;
    events: Array<AttentionEvent & { effectiveDeadline: string; isOverdue: boolean }>;
  }> {
    const sessionId = this.requireBoundedString(args.sessionId, 'sessionId', 200);
    const dedupeKey = this.optionalBoundedString(args.dedupeKey, 'dedupeKey', 300);
    const session = await this.getWorkspaceSession(sessionId, workspaceId);
    const nowMs = this.deps.now().getTime();
    const events = this.readEvents(session)
      .filter((event) => !dedupeKey || event.dedupeKey === dedupeKey)
      .filter((event) => args.includeCancelled === true || event.status === 'pending')
      .map((event) => {
        const effectiveDeadline =
          event.deadline || new Date(Date.parse(event.armedAt) + DEFAULT_ESCALATION_DELAY_MS).toISOString();
        return {
          ...event,
          effectiveDeadline,
          isOverdue: event.status === 'pending' && Date.parse(effectiveDeadline) <= nowMs,
        };
      });

    return {
      sessionId,
      defaultEscalationDelayMs: DEFAULT_ESCALATION_DELAY_MS,
      events,
    };
  }

  async armJson(
    workspaceId: string,
    args: ArmAttentionArgs,
    options: { callerSessionId?: string; enforceDirectRateLimit?: boolean } = {},
  ): Promise<string> {
    return JSON.stringify(await this.arm(workspaceId, args, options), null, 2);
  }

  async cancelJson(workspaceId: string, args: CancelAttentionArgs): Promise<string> {
    return JSON.stringify(await this.cancel(workspaceId, args), null, 2);
  }

  async statusJson(workspaceId: string, args: AttentionStatusArgs): Promise<string> {
    return JSON.stringify(await this.status(workspaceId, args), null, 2);
  }

  async handleSessionStateEvent(event: SessionStateEvent): Promise<void> {
    switch (event.type) {
      case 'session:started':
      case 'session:streaming':
      case 'session:activity':
      case 'session:waiting':
        // Waiting is the state produced by the prompt that just armed the
        // event. Activity before an exact response is not proof of progress.
        return;
      case 'session:completed':
        await this.settleTerminalAttention(event.sessionId, {
          attentionGeneration: event.attentionGeneration,
          reason: 'completed',
        });
        return;
      case 'session:interrupted':
        await this.settleTerminalAttention(event.sessionId, {
          attentionGeneration: event.attentionGeneration,
          reason: 'interrupted',
        });
        return;
      case 'session:error':
        await this.settleTerminalAttention(event.sessionId, {
          attentionGeneration: event.attentionGeneration,
          reason: 'error',
        });
        return;
    }
  }

  private async cancelPendingForLifecycle(
    sessionId: string,
    reason: Exclude<AttentionCancelReason, 'manual'>
  ): Promise<number> {
    return this.withSessionLock(sessionId, async () => {
      const session = await this.deps.getSession(sessionId);
      if (!session) {
        return 0;
      }
      const events = this.readEvents(session);
      const cancelledCount = this.cancelMatchingEvents(events, () => true, reason);
      if (cancelledCount > 0) {
        await this.persistEvents(sessionId, events);
      }
      return cancelledCount;
    });
  }

  private cancelMatchingEvents(
    events: AttentionEvent[],
    predicate: (event: AttentionEvent) => boolean,
    reason: AttentionCancelReason,
    detail?: string
  ): number {
    const cancelledAt = this.deps.now().toISOString();
    let cancelledCount = 0;
    for (const event of events) {
      if (event.status !== 'pending' || !predicate(event)) {
        continue;
      }
      event.status = 'cancelled';
      event.cancelledAt = cancelledAt;
      event.cancelReason = reason;
      if (detail) {
        event.cancelDetail = detail;
      }
      cancelledCount += 1;
    }
    return cancelledCount;
  }

  private validateArmArgs(args: ArmAttentionArgs): Required<
    Pick<ArmAttentionArgs, 'sessionId' | 'severity' | 'dedupeKey'>
  > & Omit<ArmAttentionArgs, 'sessionId' | 'severity' | 'dedupeKey' | 'deadline'> & {
    deadline: string | null;
    doNotDisturb: boolean;
    kind: 'generic' | 'interactive_prompt';
  } {
    const sessionId = this.requireBoundedString(args.sessionId, 'sessionId', 200);
    const promptId = this.optionalBoundedString(args.promptId, 'promptId', 300);
    const toolUseId = this.optionalBoundedString(args.toolUseId, 'toolUseId', 300);
    const progressFingerprint = this.optionalBoundedString(
      args.progressFingerprint,
      'progressFingerprint',
      500
    );
    const attentionGeneration = this.optionalBoundedString(
      args.attentionGeneration,
      'attentionGeneration',
      300,
    );
    if (!promptId && !toolUseId && !progressFingerprint) {
      throw new Error('promptId, toolUseId, or progressFingerprint is required');
    }
    if (!['low', 'normal', 'critical'].includes(args.severity)) {
      throw new Error('severity must be low, normal, or critical');
    }

    let deadline: string | null = null;
    if (args.deadline !== undefined) {
      const rawDeadline = this.requireBoundedString(args.deadline, 'deadline', 100);
      const deadlineMs = Date.parse(rawDeadline);
      if (!Number.isFinite(deadlineMs)) {
        throw new Error('deadline must be an ISO-8601 timestamp');
      }
      deadline = new Date(deadlineMs).toISOString();
    }

    return {
      sessionId,
      ...(promptId ? { promptId } : {}),
      ...(toolUseId ? { toolUseId } : {}),
      ...(progressFingerprint ? { progressFingerprint } : {}),
      ...(attentionGeneration ? { attentionGeneration } : {}),
      severity: args.severity,
      deadline,
      dedupeKey: this.requireBoundedString(args.dedupeKey, 'dedupeKey', 300),
      doNotDisturb: args.doNotDisturb === true,
      kind: args.kind === 'interactive_prompt' ? 'interactive_prompt' : 'generic',
      ...(args.promptType
        ? { promptType: this.requireBoundedString(args.promptType, 'promptType', 80) }
        : {}),
      ...(args.context !== undefined ? { context: this.boundContext(args.context) } : {}),
      ...(args.title ? { title: this.requireBoundedString(args.title, 'title', 120) } : {}),
      ...(args.body ? { body: this.requireBoundedString(args.body, 'body', 1000) } : {}),
    };
  }

  private normalizeNotificationReceipt(receiptJson: string): AttentionImmediateReceipt {
    const recordedAt = this.deps.now().toISOString();
    try {
      const parsed = JSON.parse(receiptJson) as {
        result?: { attempted?: boolean; shown?: boolean; skippedReason?: string | null };
        mobilePush?: {
          attempted?: boolean;
          skippedReason?: string | null;
          requestFrameWritten?: boolean;
          outcome?: 'skipped' | 'failed' | 'request_frame_written';
          bypassActiveDeviceRouting?: boolean;
          forceDesktopAwayForPush?: boolean;
          error?: string;
        };
      };
      const mobile = parsed.mobilePush;
      const local = parsed.result;
      return {
        requested: true,
        attempted: mobile?.attempted === true,
        skippedReason: mobile?.skippedReason ?? null,
        recordedAt,
        ...(local
          ? {
              local: {
                attempted: local.attempted === true,
                shown: local.shown === true,
                skippedReason: local.skippedReason ?? null,
              },
            }
          : {}),
        ...(mobile
          ? {
              mobile: {
                attempted: mobile.attempted === true,
                requestFrameWritten: mobile.requestFrameWritten === true,
                outcome: mobile.outcome || (mobile.requestFrameWritten ? 'request_frame_written' : 'skipped'),
                skippedReason: mobile.skippedReason ?? null,
                bypassActiveDeviceRouting: mobile.bypassActiveDeviceRouting === true,
                forceDesktopAwayForPush: mobile.forceDesktopAwayForPush === true,
                ...(mobile.error ? { error: this.boundReceiptError(mobile.error) } : {}),
              },
            }
          : {}),
        ...(mobile?.error ? { error: this.boundReceiptError(mobile.error) } : {}),
      };
    } catch (error) {
      return {
        requested: true,
        attempted: false,
        skippedReason: 'invalid_receipt',
        error: this.boundReceiptError(error),
        recordedAt,
      };
    }
  }

  private async getWorkspaceSession(sessionId: string, workspaceId: string): Promise<AttentionSession> {
    const session = await this.deps.getSession(sessionId);
    if (!session || session.workspacePath !== workspaceId) {
      throw new Error(`Session ${sessionId} not found`);
    }
    return session;
  }

  private readEvents(session: AttentionSession): AttentionEvent[] {
    const metadata =
      session.metadata && typeof session.metadata === 'object' && !Array.isArray(session.metadata)
        ? (session.metadata as Record<string, unknown>)
        : {};
    const events = metadata[ATTENTION_METADATA_KEY];
    return Array.isArray(events)
      ? events
          .filter((event): event is AttentionEvent => Boolean(event && typeof event === 'object'))
          .map((event) => ({
            ...event,
            kind: event.kind === 'interactive_prompt' ? 'interactive_prompt' : 'generic',
            immediateReceipt: { ...event.immediateReceipt },
          }))
      : [];
  }

  private async persistEvents(sessionId: string, events: AttentionEvent[]): Promise<void> {
    const boundedEvents = events.slice(-MAX_ATTENTION_EVENTS_PER_SESSION);
    const summary = this.buildAttentionSummary(boundedEvents);
    await this.deps.updateSessionMetadata(sessionId, {
      [ATTENTION_METADATA_KEY]: boundedEvents,
      attentionSummary: summary,
    });
    try {
      // Only the privacy-safe summary enters sync. Full events, bounded local
      // context, notification previews, receipts, and raw errors remain local.
      await this.deps.pushAttentionSummary(sessionId, summary);
    } catch (error) {
      console.error('[AttentionEventService] Failed to sync attention summary:', error);
    }
  }

  private buildAttentionSummary(events: AttentionEvent[]): AttentionSummary {
    const severityRank: Record<AttentionSeverity, number> = { low: 0, normal: 1, critical: 2 };
    const pending = events
      // Interactive prompts have their own authoritative hasPendingPrompt bit.
      // Keep this summary generic-only so iOS can render/cancel the two states
      // independently instead of showing a generic alert for every question.
      .filter((event) => event.status === 'pending' && event.kind === 'generic')
      .map((event) => ({
        event,
        effectiveDeadline:
          event.deadline ||
          new Date(Date.parse(event.armedAt) + DEFAULT_ESCALATION_DELAY_MS).toISOString(),
      }))
      .sort((left, right) =>
        severityRank[right.event.severity] - severityRank[left.event.severity] ||
        Date.parse(left.effectiveDeadline) - Date.parse(right.effectiveDeadline) ||
        Date.parse(right.event.armedAt) - Date.parse(left.event.armedAt)
      )[0];
    return pending
      ? {
          pending: true,
          severity: pending.event.severity,
          eventId: pending.event.id,
          effectiveDeadline: pending.effectiveDeadline,
        }
      : { pending: false };
  }

  private consumeDirectArmRateLimit(callerSessionId: string, targetSessionId: string): void {
    const key = `${callerSessionId}\u0000${targetSessionId}`;
    const now = this.deps.now().getTime();
    const recent = (this.directArmAttempts.get(key) || []).filter(
      (timestamp) => now - timestamp < DIRECT_ATTENTION_RATE_WINDOW_MS,
    );
    if (recent.length >= DIRECT_ATTENTION_RATE_LIMIT) {
      throw new Error('attention_arm rate limit exceeded for this caller and target session');
    }
    recent.push(now);
    this.directArmAttempts.set(key, recent);
  }

  private defaultNotificationTitle(severity: AttentionSeverity): string {
    return severity === 'critical' ? 'Critical attention required' : 'Session needs attention';
  }

  private defaultNotificationBody(session: AttentionSession): string {
    const sessionName = session.title?.trim() || 'A Nimbalyst session';
    return `${sessionName} is waiting for your input.`;
  }

  private requireBoundedString(value: unknown, field: string, maxLength: number): string {
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`${field} is required`);
    }
    const normalized = value.trim();
    if (normalized.length > maxLength) {
      throw new Error(`${field} must be at most ${maxLength} characters`);
    }
    return normalized;
  }

  private optionalBoundedString(
    value: unknown,
    field: string,
    maxLength: number
  ): string | undefined {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }
    return this.requireBoundedString(value, field, maxLength);
  }

  private boundReceiptError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.length > 500 ? `${message.slice(0, 497)}...` : message;
  }

  private boundContext(value: unknown): unknown {
    try {
      const json = JSON.stringify(value);
      if (json === undefined) return undefined;
      if (json.length <= 2_000) return JSON.parse(json);
      return {
        truncated: true,
        preview: json.slice(0, 1_900),
      };
    } catch {
      return { truncated: true, preview: '[unserializable prompt context]' };
    }
  }

  private async withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const previousTail = this.sessionLockTails.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const nextTail = previousTail.then(() => current);
    this.sessionLockTails.set(sessionId, nextTail);

    await previousTail;
    try {
      return await fn();
    } finally {
      release();
      if (this.sessionLockTails.get(sessionId) === nextTail) {
        this.sessionLockTails.delete(sessionId);
      }
    }
  }
}

export const attentionEventService = new AttentionEventService();
