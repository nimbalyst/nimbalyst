import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AttentionEventService, type ArmAttentionArgs } from '../AttentionEventService';

const WORKSPACE = '/workspace';
const SESSION_ID = 'session-1';

function createHarness() {
  let now = new Date('2026-07-18T10:00:00.000Z');
  const session = {
    id: SESSION_ID,
    title: 'Coordinator session',
    workspacePath: WORKSPACE,
    metadata: {} as Record<string, unknown>,
  };
  const notifyUserJson = vi.fn().mockResolvedValue(JSON.stringify({
    result: {
      attempted: true,
      shown: true,
      skippedReason: null,
    },
    mobilePush: {
      attempted: true,
      requestFrameWritten: true,
      outcome: 'request_frame_written',
      skippedReason: null,
      bypassActiveDeviceRouting: true,
      forceDesktopAwayForPush: true,
    },
  }));
  const updateSessionMetadata = vi.fn(async (_sessionId: string, metadata: Record<string, unknown>) => {
    session.metadata = { ...session.metadata, ...metadata };
  });
  const pushAttentionSummary = vi.fn().mockResolvedValue(undefined);
  const service = new AttentionEventService({
    getSession: vi.fn(async (sessionId: string) => (sessionId === SESSION_ID ? session : null)),
    updateSessionMetadata,
    pushAttentionSummary,
    now: () => now,
    notifyUserJson,
  });

  return {
    service,
    session,
    notifyUserJson,
    updateSessionMetadata,
    pushAttentionSummary,
    setNow(value: string) {
      now = new Date(value);
    },
  };
}

function armArgs(overrides: Partial<ArmAttentionArgs> = {}): ArmAttentionArgs {
  return {
    sessionId: SESSION_ID,
    promptId: 'prompt-1',
    severity: 'normal',
    dedupeKey: 'waiting:prompt-1',
    ...overrides,
  };
}

describe('AttentionEventService', () => {
  let harness: ReturnType<typeof createHarness>;

  beforeEach(() => {
    harness = createHarness();
  });

  it('arms a persistent pending event and attempts one forced notification', async () => {
    const result = await harness.service.arm(WORKSPACE, armArgs());

    expect(result.deduplicated).toBe(false);
    expect(result.event).toMatchObject({
      sessionId: SESSION_ID,
      promptId: 'prompt-1',
      severity: 'normal',
      dedupeKey: 'waiting:prompt-1',
      status: 'pending',
      armedAt: '2026-07-18T10:00:00.000Z',
      immediateReceipt: {
        requested: true,
        attempted: true,
        skippedReason: null,
      },
    });
    expect(harness.notifyUserJson).toHaveBeenCalledTimes(1);
    expect(harness.notifyUserJson).toHaveBeenCalledWith(
      SESSION_ID,
      WORKSPACE,
      expect.objectContaining({
        sessionId: SESSION_ID,
        mobilePush: 'always',
        bypassFocusCheck: true,
      })
    );
    expect(harness.session.metadata.attentionEvents).toEqual([result.event]);
    expect(harness.session.metadata.attentionSummary).toEqual({
      pending: true,
      severity: 'normal',
      eventId: result.event.id,
      effectiveDeadline: '2026-07-18T10:10:00.000Z',
    });
    expect(harness.pushAttentionSummary).toHaveBeenLastCalledWith(
      SESSION_ID,
      harness.session.metadata.attentionSummary,
    );
    expect(JSON.stringify(harness.pushAttentionSummary.mock.calls)).not.toContain('prompt-1');
  });

  it('exposes the default unresolved deadline without scheduling escalation delivery', async () => {
    await harness.service.arm(WORKSPACE, armArgs({ doNotDisturb: true }));
    harness.setNow('2026-07-18T10:11:00.000Z');

    const status = await harness.service.status(WORKSPACE, { sessionId: SESSION_ID });

    expect(status.defaultEscalationDelayMs).toBe(10 * 60 * 1000);
    expect(status.events[0]).toMatchObject({
      effectiveDeadline: '2026-07-18T10:10:00.000Z',
      isOverdue: true,
    });
  });

  it('does not cancel attention merely because session activity resumes', async () => {
    await harness.service.arm(WORKSPACE, armArgs());
    harness.setNow('2026-07-18T10:01:00.000Z');

    await harness.service.handleSessionStateEvent({
      type: 'session:started',
      sessionId: SESSION_ID,
      workspacePath: WORKSPACE,
      timestamp: new Date('2026-07-18T10:01:00.000Z'),
    });

    const status = await harness.service.status(WORKSPACE, {
      sessionId: SESSION_ID,
      includeCancelled: true,
    });
    expect(status.events[0].status).toBe('pending');
  });

  it('does not cancel an event because of the waiting state that armed it', async () => {
    await harness.service.arm(WORKSPACE, armArgs());
    harness.setNow('2026-07-18T10:02:00.000Z');

    await harness.service.handleSessionStateEvent({
      type: 'session:waiting',
      sessionId: SESSION_ID,
      workspacePath: WORKSPACE,
      timestamp: new Date('2026-07-18T10:02:00.000Z'),
    });

    const status = await harness.service.status(WORKSPACE, {
      sessionId: SESSION_ID,
      includeCancelled: true,
    });
    expect(status.events[0].status).toBe('pending');
  });

  it('deduplicates a repeated arm without firing a second notification', async () => {
    const first = await harness.service.arm(WORKSPACE, armArgs());
    harness.setNow('2026-07-18T10:03:00.000Z');
    const second = await harness.service.arm(WORKSPACE, armArgs());

    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
    expect(second.event.id).toBe(first.event.id);
    expect(second.event).toMatchObject({
      dedupeCount: 1,
      lastDeduplicatedAt: '2026-07-18T10:03:00.000Z',
    });
    expect(harness.notifyUserJson).toHaveBeenCalledTimes(1);
  });

  it('records a DND event as pending without attempting the notification', async () => {
    const result = await harness.service.arm(WORKSPACE, armArgs({ doNotDisturb: true }));

    expect(result.event).toMatchObject({
      status: 'pending',
      doNotDisturb: true,
      immediateReceipt: {
        requested: true,
        attempted: false,
        skippedReason: 'do_not_disturb',
      },
    });
    expect(harness.notifyUserJson).not.toHaveBeenCalled();
    expect(harness.session.metadata.attentionEvents).toEqual([result.event]);
  });

  it('normalizes a failed client write without calling it a written request', async () => {
    harness.notifyUserJson.mockResolvedValueOnce(JSON.stringify({
      result: { attempted: true, shown: true, skippedReason: null },
      mobilePush: {
        attempted: true,
        requestFrameWritten: false,
        outcome: 'failed',
        skippedReason: 'request_frame_send_failed',
        bypassActiveDeviceRouting: true,
        forceDesktopAwayForPush: true,
        error: 'send exploded',
      },
    }));
    const result = await harness.service.arm(WORKSPACE, armArgs());
    expect(result.event.immediateReceipt).toMatchObject({
      attempted: true,
      skippedReason: 'request_frame_send_failed',
      mobile: {
        attempted: true,
        requestFrameWritten: false,
        outcome: 'failed',
      },
    });
  });

  it('does not infer an attempt from an invalid delivery receipt', async () => {
    harness.notifyUserJson.mockResolvedValueOnce('not-json');
    const result = await harness.service.arm(WORKSPACE, armArgs());
    expect(result.event.immediateReceipt).toMatchObject({
      attempted: false,
      skippedReason: 'invalid_receipt',
    });
  });

  it('cancels a pending event explicitly and persists the cancellation receipt', async () => {
    const armed = await harness.service.arm(WORKSPACE, armArgs({ doNotDisturb: true }));
    harness.setNow('2026-07-18T10:04:00.000Z');

    const result = await harness.service.cancel(WORKSPACE, {
      sessionId: SESSION_ID,
      eventId: armed.event.id,
      reason: 'No longer blocked',
    });

    expect(result.cancelledCount).toBe(1);
    expect(result.events[0]).toMatchObject({
      status: 'cancelled',
      cancelledAt: '2026-07-18T10:04:00.000Z',
      cancelReason: 'manual',
      cancelDetail: 'No longer blocked',
    });
    expect(harness.session.metadata.attentionSummary).toEqual({ pending: false });
  });

  it('does not cancel a reused prompt identity from a newer generation', async () => {
    await harness.service.armInteractivePrompt(WORKSPACE, {
      sessionId: SESSION_ID,
      promptType: 'AskUserQuestion',
      promptId: 'reused-prompt',
      attentionGeneration: 'turn-a',
    });
    await harness.service.cancelInteractivePrompt(
      SESSION_ID,
      'reused-prompt',
      'answered',
      { expectedGeneration: 'turn-a' },
    );
    await harness.service.armInteractivePrompt(WORKSPACE, {
      sessionId: SESSION_ID,
      promptType: 'ToolPermission',
      promptId: 'reused-prompt',
      attentionGeneration: 'turn-b',
    });

    expect(await harness.service.cancelInteractivePrompt(
      SESSION_ID,
      'reused-prompt',
      'cancelled',
      { expectedGeneration: 'turn-a' },
    )).toBe(0);
    const status = await harness.service.status(WORKSPACE, {
      sessionId: SESSION_ID,
      includeCancelled: true,
    });
    expect(status.events).toContainEqual(expect.objectContaining({
      promptId: 'reused-prompt',
      attentionGeneration: 'turn-b',
      status: 'pending',
    }));
  });

  it('supersedes an older automatic prompt while stable identity ignores mutable body text', async () => {
    const first = await harness.service.armInteractivePrompt(WORKSPACE, {
      sessionId: SESSION_ID,
      promptType: 'AskUserQuestion',
      promptId: 'question-1',
      body: 'First preview',
    });
    harness.setNow('2026-07-18T10:01:00.000Z');
    const duplicate = await harness.service.armInteractivePrompt(WORKSPACE, {
      sessionId: SESSION_ID,
      promptType: 'AskUserQuestion',
      promptId: 'question-1',
      body: 'Changed assistant prose',
    });
    const second = await harness.service.armInteractivePrompt(WORKSPACE, {
      sessionId: SESSION_ID,
      promptType: 'ToolPermission',
      toolUseId: 'permission-2',
    });

    expect(duplicate.deduplicated).toBe(true);
    expect(duplicate.event.id).toBe(first.event.id);
    expect(harness.notifyUserJson).toHaveBeenCalledTimes(2);
    const status = await harness.service.status(WORKSPACE, {
      sessionId: SESSION_ID,
      includeCancelled: true,
    });
    expect(status.events.find((event) => event.id === first.event.id)).toMatchObject({
      status: 'cancelled',
      cancelReason: 'superseded',
    });
    expect(status.events.find((event) => event.id === second.event.id)?.status).toBe('pending');
  });

  it('clears only the exact answered interactive prompt', async () => {
    const armed = await harness.service.armInteractivePrompt(WORKSPACE, {
      sessionId: SESSION_ID,
      promptType: 'AskUserQuestion',
      promptId: 'question-1',
    });
    const cancelled = await harness.service.cancelInteractivePrompt(
      SESSION_ID,
      'question-1',
      'answered',
    );
    expect(cancelled).toBe(1);
    const status = await harness.service.status(WORKSPACE, {
      sessionId: SESSION_ID,
      includeCancelled: true,
    });
    expect(status.events.find((event) => event.id === armed.event.id)?.cancelReason).toBe('answered');
    expect(harness.session.metadata.attentionSummary).toEqual({ pending: false });
  });

  it('does not clear an interactive prompt whose identity merely has the same suffix', async () => {
    const armed = await harness.service.armInteractivePrompt(WORKSPACE, {
      sessionId: SESSION_ID,
      promptType: 'AskUserQuestion',
      promptId: 'parent:question-1',
    });

    await expect(harness.service.cancelInteractivePrompt(
      SESSION_ID,
      'question-1',
      'answered',
    )).resolves.toBe(0);

    const status = await harness.service.status(WORKSPACE, {
      sessionId: SESSION_ID,
      includeCancelled: true,
    });
    expect(status.events.find((event) => event.id === armed.event.id)?.status).toBe('pending');
  });

  it('keeps generic attention summary independent when an interactive prompt settles', async () => {
    const generic = await harness.service.arm(WORKSPACE, armArgs({
      promptId: undefined,
      progressFingerprint: 'no-progress-1',
      dedupeKey: 'progress:no-progress-1',
      severity: 'critical',
      doNotDisturb: true,
    }));
    await harness.service.armInteractivePrompt(WORKSPACE, {
      sessionId: SESSION_ID,
      promptType: 'AskUserQuestion',
      promptId: 'question-1',
    });

    expect(harness.session.metadata.attentionSummary).toMatchObject({
      pending: true,
      eventId: generic.event.id,
      severity: 'critical',
    });
    await harness.service.cancelInteractivePrompt(SESSION_ID, 'question-1', 'answered');
    expect(harness.session.metadata.attentionSummary).toMatchObject({
      pending: true,
      eventId: generic.event.id,
    });
  });

  it('cancels every pending event on a true terminal error', async () => {
    await harness.service.arm(WORKSPACE, armArgs({ doNotDisturb: true }));
    await harness.service.handleSessionStateEvent({
      type: 'session:error',
      sessionId: SESSION_ID,
      workspacePath: WORKSPACE,
      timestamp: new Date(),
      error: 'boom',
    } as never);
    expect(harness.session.metadata.attentionSummary).toEqual({ pending: false });
  });

  it('does not let an unscoped legacy terminal cancel a newer scoped generic event', async () => {
    const genericB = await harness.service.arm(WORKSPACE, armArgs({
      promptId: undefined,
      progressFingerprint: 'turn-b-progress',
      dedupeKey: 'turn-b-progress',
      doNotDisturb: true,
      attentionGeneration: 'turn-b',
    }));

    await harness.service.handleSessionStateEvent({
      type: 'session:completed',
      sessionId: SESSION_ID,
      workspacePath: WORKSPACE,
      timestamp: new Date(),
    });

    const status = await harness.service.status(WORKSPACE, {
      sessionId: SESSION_ID,
      includeCancelled: true,
    });
    expect(status.events.find((event) => event.id === genericB.event.id)).toMatchObject({
      status: 'pending',
      attentionGeneration: 'turn-b',
    });
    expect(harness.session.metadata.attentionSummary).toMatchObject({
      pending: true,
      eventId: genericB.event.id,
    });
  });

  it('keeps prompt B pending when a delayed terminal callback for generation A arrives', async () => {
    const promptB = await harness.service.armInteractivePrompt(WORKSPACE, {
      sessionId: SESSION_ID,
      promptType: 'AskUserQuestion',
      promptId: 'prompt-b',
      attentionGeneration: 'turn-b',
    } as any);

    await harness.service.handleSessionStateEvent({
      type: 'session:completed',
      sessionId: SESSION_ID,
      workspacePath: WORKSPACE,
      timestamp: new Date(),
      attentionGeneration: 'turn-a',
    } as any);

    const status = await harness.service.status(WORKSPACE, {
      sessionId: SESSION_ID,
      includeCancelled: true,
    });
    expect(status.events.find((event) => event.id === promptB.event.id)).toMatchObject({
      status: 'pending',
      attentionGeneration: 'turn-b',
    });
  });

  it('keeps prompt B pending when a delayed generation-A error arrives', async () => {
    const promptB = await harness.service.armInteractivePrompt(WORKSPACE, {
      sessionId: SESSION_ID,
      promptType: 'ToolPermission',
      toolUseId: 'prompt-b',
      attentionGeneration: 'turn-b',
    });

    await harness.service.handleSessionStateEvent({
      type: 'session:error',
      sessionId: SESSION_ID,
      workspacePath: WORKSPACE,
      timestamp: new Date(),
      error: 'late turn-a error',
      attentionGeneration: 'turn-a',
    });

    const status = await harness.service.status(WORKSPACE, {
      sessionId: SESSION_ID,
      includeCancelled: true,
    });
    expect(status.events.find((event) => event.id === promptB.event.id)?.status).toBe('pending');
  });

  it('settles matching interactive and generic attention for the terminal generation', async () => {
    const promptA = await harness.service.armInteractivePrompt(WORKSPACE, {
      sessionId: SESSION_ID,
      promptType: 'AskUserQuestion',
      promptId: 'prompt-a',
      attentionGeneration: 'turn-a',
    } as any);
    const genericA = await harness.service.arm(WORKSPACE, armArgs({
      promptId: undefined,
      progressFingerprint: 'turn-a-progress',
      dedupeKey: 'turn-a-progress',
      doNotDisturb: true,
      attentionGeneration: 'turn-a',
    } as any));

    await harness.service.handleSessionStateEvent({
      type: 'session:error',
      sessionId: SESSION_ID,
      workspacePath: WORKSPACE,
      timestamp: new Date(),
      error: 'boom',
      attentionGeneration: 'turn-a',
    } as any);

    const status = await harness.service.status(WORKSPACE, {
      sessionId: SESSION_ID,
      includeCancelled: true,
    });
    expect(status.events.find((event) => event.id === promptA.event.id)?.status).toBe('cancelled');
    expect(status.events.find((event) => event.id === genericA.event.id)?.status).toBe('cancelled');
    expect(harness.session.metadata.attentionSummary).toEqual({ pending: false });
  });

  it('rate limits only new direct events and still deduplicates a stable identity', async () => {
    for (let index = 0; index < 10; index += 1) {
      await harness.service.arm(WORKSPACE, armArgs({
        promptId: `prompt-${index}`,
        dedupeKey: `direct-${index}`,
        doNotDisturb: true,
      }), { callerSessionId: 'caller-1', enforceDirectRateLimit: true });
    }
    await expect(harness.service.arm(WORKSPACE, armArgs({
      promptId: 'prompt-over-limit',
      dedupeKey: 'direct-over-limit',
      doNotDisturb: true,
    }), { callerSessionId: 'caller-1', enforceDirectRateLimit: true }))
      .rejects.toThrow('rate limit exceeded');
    await expect(harness.service.arm(WORKSPACE, armArgs({
      promptId: 'prompt-0',
      dedupeKey: 'direct-0',
      doNotDisturb: true,
    }), { callerSessionId: 'caller-1', enforceDirectRateLimit: true }))
      .resolves.toMatchObject({ deduplicated: true });
  });

  it('exposes the default escalation deadline and overdue state for observers', async () => {
    await harness.service.arm(WORKSPACE, armArgs({ doNotDisturb: true }));
    harness.setNow('2026-07-18T10:11:00.000Z');

    const status = await harness.service.status(WORKSPACE, { sessionId: SESSION_ID });

    expect(status.defaultEscalationDelayMs).toBe(10 * 60 * 1000);
    expect(status.events[0]).toMatchObject({
      armedAt: '2026-07-18T10:00:00.000Z',
      effectiveDeadline: '2026-07-18T10:10:00.000Z',
      isOverdue: true,
    });
  });
});
