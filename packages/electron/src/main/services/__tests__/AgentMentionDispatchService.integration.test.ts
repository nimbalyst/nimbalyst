// @vitest-environment node
import type { AgentWakePromptOrigin } from '@nimbalyst/runtime/ai/server/types';
import type { TeamInboxMaterializedDelivery, TeamInboxSnapshot } from '@nimbalyst/runtime/sync';
import type { FeedbackRequest } from '@nimbalyst/collab-protocol';
import { describe, expect, it, vi } from 'vitest';
import { asTeamMemberId } from '@nimbalyst/runtime/auth/jwtScopes';

import {
  AgentMentionDispatchService,
  AgentWakePolicyRegistry,
} from '../AgentMentionDispatchService';
import {
  FEEDBACK_REQUEST_WAKE_POLICY_KEY,
  registerFeedbackRequestWakePolicy,
} from '../FeedbackRequestWakePolicy';
import type {
  QueuedPrompt,
  QueuedPromptsStore,
} from '../PGLiteQueuedPromptsStore';

const waitForDispatch = () => new Promise((resolve) => setTimeout(resolve, 15));

function delivery(
  id: string,
  messageId: string,
  createdAt: number,
  sessionId = 'session-attached',
): TeamInboxMaterializedDelivery {
  return {
    id,
    teamMemberId: asTeamMemberId('owner'),
    orgId: 'org-a',
    orgName: 'Acme',
    source: {
      orgId: 'org-a',
      sourceKind: 'roomMessage',
      sourceId: 'conversation-a',
      commentId: messageId,
    },
    reason: 'agentMention',
    agentSessionIds: [sessionId],
    agentDispatchedSessionIds: [],
    agentDispatch: 'pending',
    preview: { snippet: `message ${messageId}` },
    createdAt,
    hasUnreadActivity: true,
  };
}

function feedbackDelivery(
  trigger: string,
  createdAt = 1,
): TeamInboxMaterializedDelivery {
  return {
    ...delivery('feedback-delivery', 'unused', createdAt),
    source: {
      orgId: 'org-a',
      resourceKind: 'feedbackRequest',
      resourceId: 'feedback-a',
      sourceEventId: `feedback:feedback-a:wake:${trigger}`,
      eventClass: 'feedbackRequestWake',
    },
    agentWakePolicy: FEEDBACK_REQUEST_WAKE_POLICY_KEY,
    agentWakeMetadata: { requestId: 'feedback-a', trigger },
  };
}

function feedbackRequest(respondedUserIds: string[]): FeedbackRequest {
  const responseSet = new Set(respondedUserIds);
  return {
    id: 'feedback-a',
    urn: 'nimbalyst://feedback-request/feedback-a',
    orgId: 'org-a',
    author: {
      kind: 'agent',
      sessionId: 'session-attached',
      sessionName: 'Review',
      onBehalfOfUserId: 'owner',
    },
    subjects: [],
    asks: [{
      type: 'confirm',
      id: 'ask-a',
      label: 'Approve?',
      description: 'Approve the proposal.',
    }],
    recipients: [
      { userId: 'recipient-a', name: 'Recipient A' },
      { userId: 'recipient-b', name: 'Recipient B' },
    ],
    assignments: [
      { askId: 'ask-a', target: { kind: 'user', userId: 'recipient-a' } },
      { askId: 'ask-a', target: { kind: 'user', userId: 'recipient-b' } },
    ],
    responses: ['recipient-a', 'recipient-b'].flatMap((recipientUserId, index) =>
      responseSet.has(recipientUserId) ? [{
        id: `response-${index}`,
        requestId: 'feedback-a',
        askId: 'ask-a',
        recipientUserId,
        answer: { type: 'confirm' as const, value: true },
        createdAt: index + 2,
        updatedAt: index + 2,
      }] : []),
    discussion: [],
    lifecycle: { status: 'open', changedAt: 1 },
    visibility: 'open',
    wakePolicy: 'quorumOrClose',
    quorum: { requiredRecipientCount: 2 },
    createdAt: 1,
    updatedAt: 3,
  };
}

class FakeInbox {
  snapshot: TeamInboxSnapshot = {
    status: 'offlineWithCache',
    deliveries: [],
    organizations: [],
  };
  readonly claims: Array<[string, string]> = [];
  readonly completions: Array<[string, string]> = [];
  private listeners = new Set<(snapshot: TeamInboxSnapshot) => void>();

  async start() { return this.snapshot; }
  getSnapshot() { return this.snapshot; }
  subscribe(listener: (snapshot: TeamInboxSnapshot) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  async claimAgentDelivery(deliveryId: string, sessionId: string) {
    this.claims.push([deliveryId, sessionId]);
    return true;
  }
  async completeAgentDelivery(deliveryId: string, sessionId: string) {
    this.completions.push([deliveryId, sessionId]);
    return true;
  }
  publish(snapshot: TeamInboxSnapshot) {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener(snapshot);
  }
}

function memoryQueue(): QueuedPromptsStore {
  const rows = new Map<string, QueuedPrompt>();
  return {
    async create(input) {
      const row: QueuedPrompt = {
        ...input,
        status: 'pending',
        createdAt: Date.now(),
      };
      rows.set(row.id, row);
      return row;
    },
    async get(id) { return rows.get(id) ?? null; },
    async listForSession(sessionId, options) {
      return [...rows.values()].filter((row) =>
        row.sessionId === sessionId
        && (options?.includeCompleted || !['completed', 'failed'].includes(row.status)));
    },
    async listPending(sessionId) {
      return [...rows.values()].filter((row) => row.sessionId === sessionId && row.status === 'pending');
    },
    async listSessionIdsWithPending() { return []; },
    async failAllPendingForSession() { return 0; },
    async claim(id) {
      const row = rows.get(id);
      if (!row || row.status !== 'pending') return null;
      row.status = 'executing';
      return row;
    },
    async complete(id) { const row = rows.get(id); if (row) row.status = 'completed'; },
    async fail(id, errorMessage) {
      const row = rows.get(id);
      if (row) { row.status = 'failed'; row.errorMessage = errorMessage; }
    },
    async delete(id) { rows.delete(id); },
    async rollbackExecuting() { return 0; },
    async rollbackAllExecuting() { return 0; },
    async sweepExecutingOnBoot() { return { completed: 0, failed: 0, rolledBack: 0 }; },
    async sweepExecutingForSession() { return { completed: 0, failed: 0, rolledBack: 0 }; },
    async cleanup() { return 0; },
  };
}

function setup(options?: {
  policy?: AgentWakePolicyRegistry;
  feedbackState?: FeedbackRequest;
}) {
  const feedbackState = options?.feedbackState;
  const inbox = new FakeInbox();
  const queueStore = memoryQueue();
  const queued: Array<{
    id: string;
    prompt: string;
    origin: AgentWakePromptOrigin;
  }> = [];
  const drives: Array<[string, string]> = [];
  let promptClaimed: ((event: { sessionId: string; promptId: string }) => void) | null = null;
  let sessionState: ((event: { type: string; sessionId: string }) => void) | null = null;
  const service = new AgentMentionDispatchService({
    inbox,
    queueStore,
    policies: options?.policy,
    batchDelayMs: 1,
    getSession: async (sessionId) => sessionId === 'session-attached'
      ? { id: sessionId, workspacePath: '/workspace' } as never
      : null,
    queuePrompt: async (sessionId, prompt, documentContext) => {
      const id = `wake-${queued.length + 1}`;
      const origin = documentContext.agentWakeOrigin as AgentWakePromptOrigin;
      await queueStore.create({ id, sessionId, prompt, documentContext });
      queued.push({ id, prompt, origin });
      return { id };
    },
    requestDrive: (sessionId, workspacePath) => drives.push([sessionId, workspacePath]),
    subscribePromptClaims: (listener) => {
      promptClaimed = listener;
      return () => { promptClaimed = null; };
    },
    subscribeSessionState: (listener) => {
      sessionState = listener;
      return () => { sessionState = null; };
    },
    loadConversationEvents: async () => [],
    loadFeedbackRequestState: feedbackState
      ? async (workspacePath, orgId, requestId) => ({
          workspacePath,
          orgId,
          requestId,
          teamMemberId: asTeamMemberId('owner'),
          status: 'connected',
          request: feedbackState,
          progress: {
            answeredAskCount: feedbackState.responses.length,
            totalAssignedAskCount: feedbackState.assignments.length,
            answeredRecipientCount: feedbackState.responses.length,
            totalRecipientCount: feedbackState.recipients.length,
            quorumReached: true,
          },
        })
      : undefined,
  });
  return {
    service,
    inbox,
    queued,
    drives,
    async claimPrompt(id: string) {
      await queueStore.claim(id);
      promptClaimed?.({ sessionId: 'session-attached', promptId: id });
    },
    async settleTurn(id: string) {
      await queueStore.complete(id);
      sessionState?.({ type: 'session:completed', sessionId: 'session-attached' });
    },
  };
}

describe('AgentMentionDispatchService integration', () => {
  it('queues offline deliveries on reconnect, batches rapid mentions, and keeps one conversation turn in flight', async () => {
    const harness = setup();
    harness.inbox.snapshot.deliveries = [
      delivery('delivery-1', 'message-1', 1),
      delivery('delivery-2', 'message-2', 2),
    ];
    await harness.service.start();
    await waitForDispatch();
    expect(harness.queued).toHaveLength(0);

    harness.inbox.publish({ ...harness.inbox.snapshot, status: 'ready' });
    await waitForDispatch();
    expect(harness.queued).toHaveLength(1);
    expect(harness.queued[0].origin.targets).toEqual([
      { deliveryId: 'delivery-1', sessionId: 'session-attached' },
      { deliveryId: 'delivery-2', sessionId: 'session-attached' },
    ]);
    expect(harness.queued[0].prompt).toContain(
      'nimbalyst://conversation/conversation-a/message/message-1?orgId=org-a',
    );
    expect(harness.drives).toEqual([['session-attached', '/workspace']]);

    harness.inbox.publish({
      ...harness.inbox.snapshot,
      deliveries: [
        ...harness.inbox.snapshot.deliveries,
        delivery('delivery-3', 'message-3', 3),
      ],
    });
    await waitForDispatch();
    expect(harness.queued).toHaveLength(1);

    await harness.claimPrompt('wake-1');
    await waitForDispatch();
    expect(harness.inbox.completions).toEqual([
      ['delivery-1', 'session-attached'],
      ['delivery-2', 'session-attached'],
    ]);

    harness.inbox.publish({
      ...harness.inbox.snapshot,
      deliveries: [delivery('delivery-3', 'message-3', 3)],
    });
    await harness.settleTurn('wake-1');
    await waitForDispatch();
    expect(harness.queued).toHaveLength(2);
    expect(harness.queued[1].origin.messageIds).toEqual(['message-3']);
    harness.service.destroy();
  });

  it('refuses a delivery whose target is not an attached local session and honors a non-waking policy', async () => {
    const policy = new AgentWakePolicyRegistry();
    policy.register('agentMention', () => ({ wake: false, reason: 'awaiting quorum' }));
    const harness = setup({ policy });
    await harness.service.start();
    harness.inbox.publish({
      status: 'ready',
      organizations: [],
      deliveries: [
        delivery('delivery-unattached', 'message-x', 1, 'not-local'),
        delivery('delivery-policy', 'message-y', 2),
      ],
    });
    await waitForDispatch();
    expect(harness.inbox.claims).toEqual([]);
    expect(harness.queued).toEqual([]);
    harness.service.destroy();
  });

  it('keeps policy batches separate without letting a deferred feedback response suppress an explicit mention', async () => {
    const policy = new AgentWakePolicyRegistry();
    policy.register('feedbackResponse', () => ({ wake: false, reason: 'awaiting quorum' }));
    const harness = setup({ policy });
    const feedback = delivery('delivery-feedback', 'message-feedback', 1);
    feedback.agentWakePolicy = 'feedbackResponse';
    await harness.service.start();
    harness.inbox.publish({
      status: 'ready',
      organizations: [],
      deliveries: [feedback, delivery('delivery-mention', 'message-mention', 2)],
    });

    await waitForDispatch();
    expect(harness.queued).toHaveLength(1);
    expect(harness.queued[0].origin.policyKey).toBe('agentMention');
    expect(harness.queued[0].origin.targets).toEqual([
      { deliveryId: 'delivery-mention', sessionId: 'session-attached' },
    ]);
    expect(harness.inbox.claims).toEqual([
      ['delivery-mention', 'session-attached'],
    ]);
    harness.service.destroy();
  });

  it('registers the dispatcher feedback key and wakes only for quorum, close, or explicit nudge', async () => {
    const policy = new AgentWakePolicyRegistry();
    let request = feedbackRequest(['recipient-a']);
    registerFeedbackRequestWakePolicy(policy, {
      targetFor: async (_context, candidate, requestId) => ({
        workspacePath: '/workspace',
        orgId: candidate.orgId,
        requestId,
      }),
      loadState: async (target) => ({
        ...target,
        teamMemberId: asTeamMemberId('owner'),
        status: 'connected',
        request,
        progress: {
          answeredAskCount: request.responses.length,
          totalAssignedAskCount: request.assignments.length,
          answeredRecipientCount: request.responses.length,
          totalRecipientCount: request.recipients.length,
          quorumReached: false,
        },
      }),
    });
    const context = (trigger: string) => ({
      policyKey: FEEDBACK_REQUEST_WAKE_POLICY_KEY,
      sessionId: 'session-attached',
      conversationId: 'feedback-request:feedback-a',
      candidates: [{
        deliveryId: `delivery-${trigger}`,
        orgId: 'org-a',
        conversationId: 'feedback-request:feedback-a',
        messageId: `event-${trigger}`,
        sessionId: 'session-attached',
        createdAt: 1,
        policyMetadata: { requestId: 'feedback-a', trigger },
      }],
    });

    await expect(policy.evaluate(context('response'))).resolves.toMatchObject({
      wake: false,
    });
    request = feedbackRequest(['recipient-a', 'recipient-b']);
    await expect(policy.evaluate(context('quorum'))).resolves.toMatchObject({
      wake: true,
    });
    await expect(policy.evaluate(context('closed'))).resolves.toMatchObject({
      wake: true,
    });
    await expect(policy.evaluate(context('nudge'))).resolves.toMatchObject({
      wake: true,
    });

    const harness = setup({ policy, feedbackState: request });
    await harness.service.start();
    harness.inbox.publish({
      status: 'ready',
      organizations: [],
      deliveries: [feedbackDelivery('closed')],
    });
    await waitForDispatch();
    expect(harness.queued).toHaveLength(1);
    expect(harness.queued[0].origin.policyKey).toBe('feedbackRequest');
    expect(harness.queued[0].prompt).toContain(
      'nimbalyst://feedback-request/feedback-a',
    );
    expect(harness.queued[0].prompt).toContain('"responses"');
    expect(harness.queued[0].prompt).toContain('"value": true');
    harness.service.destroy();
  });
});
