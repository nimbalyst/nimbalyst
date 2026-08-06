import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QueueSettlementResult, QueueTerminalReceipt } from '../../PGLiteQueuedPromptsStore';

type TerminalSettlementMock = (
  rowId: string,
  sessionId: string,
  claimToken: string,
  terminal: QueueTerminalReceipt,
) => Promise<QueueSettlementResult>;

function settledTerminalResult(
  rowId: string,
  sessionId: string,
  claimToken: string,
  terminal: QueueTerminalReceipt,
): QueueSettlementResult {
  return {
    outcome: 'settled',
    row: {
      id: rowId,
      sessionId,
      prompt: '',
      status: terminal.lifecycle,
      createdAt: 0,
      claimToken,
      deliveryClass: 'ordinary',
      priorityRank: 0,
      deliveryReady: true,
      terminalStatus: terminal.lifecycle,
      terminalAt: terminal.terminalAt,
      streamEventSequence: terminal.eventSequence,
    },
  };
}

const state = vi.hoisted(() => ({
  callbacks: null as any,
  rows: [] as any[],
  complete: vi.fn<TerminalSettlementMock>(async (rowId, sessionId, claimToken, terminal) => settledTerminalResult(rowId, sessionId, claimToken, terminal)),
  fail: vi.fn<TerminalSettlementMock>(async (rowId, sessionId, claimToken, terminal) => settledTerminalResult(rowId, sessionId, claimToken, terminal)),
  publishSnapshot: vi.fn(async () => undefined),
  reDrive: vi.fn(async () => false),
  subAgentInFlight: false,
}));

vi.mock('@nimbalyst/runtime', () => ({
  AgentMessagesRepository: { create: vi.fn(async (row) => { state.rows.push(row); }) },
  AISessionsRepository: { get: vi.fn(async () => null) },
  TrackerReferenceChip: () => null,
  TrackerReferencePicker: () => null,
  useResolvedTrackerReference: () => null,
  navigateToTrackerReference: vi.fn(),
}));
vi.mock('../../RepositoryManager', () => ({
  getQueuedPromptsStore: () => ({ completeAfterDispatch: state.complete, failAfterDispatch: state.fail }),
}));
vi.mock('../AIService', () => ({ publishQueuedPromptSnapshotForSession: state.publishSnapshot }));
vi.mock('../../analytics/AnalyticsService', () => ({ AnalyticsService: { getInstance: () => ({ sendEvent: vi.fn() }) } }));
vi.mock('../../NotificationService', () => ({ notificationService: { showNotification: vi.fn() } }));
vi.mock('../../SoundNotificationService', () => ({ SoundNotificationService: { getInstance: () => ({ playCompletionSound: vi.fn() }) } }));
vi.mock('../../SessionFileTracker', () => ({ sessionFileTracker: { trackToolExecution: vi.fn() } }));
vi.mock('../../../window/WindowManager', () => ({ findWindowByWorkspace: vi.fn(() => null) }));
vi.mock('../../SyncManager', () => ({ getSyncProvider: vi.fn(() => null), isDesktopTrulyAway: vi.fn(() => false) }));
vi.mock('../../../utils/store', () => ({ getClaudeCodeApiUpstreamUrl: vi.fn(() => undefined) }));
vi.mock('../claudeCliQueueFlushSingleton', () => ({ flushNextClaudeCliQueuedPromptForSession: state.reDrive }));
vi.mock('../claudeCliUserPromptLog', () => ({ broadcastMessageLogged: vi.fn() }));
vi.mock('../claudeCliToolResultLog', () => ({ logClaudeCliToolResults: vi.fn(), loadSeenToolResultIds: vi.fn(async () => []) }));
vi.mock('../claudeCliToolResultSeen', () => ({ getSeenToolResultIds: vi.fn(() => new Set()), clearSeenToolResultIds: vi.fn() }));
vi.mock('../claudeCliContextUsage', () => ({ clearClaudeCliObserved1mSupport: vi.fn(), logClaudeCliContextUsage: vi.fn(), noteClaudeCliObserved1mSupport: vi.fn() }));
vi.mock('../claudeCliErrorClassifier', () => ({ classifyClaudeCliUpstreamError: vi.fn() }));
vi.mock('../claudeCliErrorSurfacePolicy', () => ({ createClaudeCliErrorSurfacePolicy: () => ({ noteAssistantMessage: vi.fn(), shouldSurface: vi.fn(() => true) }) }));
vi.mock('../claudeCliErrorLog', () => ({ buildClaudeCliErrorContent: vi.fn(() => JSON.stringify({ type: 'error' })), logClaudeCliUpstreamError: vi.fn() }));
vi.mock('../claudeCliFileTracking', () => ({ trackClaudeCliFileEdits: vi.fn() }));
vi.mock('../claudeCliSubAgentTracker', () => ({ isSubAgentTurnInFlight: vi.fn(() => state.subAgentInFlight), noteAssistantTaskCalls: vi.fn(), noteToolResultsCompleteTasks: vi.fn(), clearSubAgentTracking: vi.fn() }));
vi.mock('../claudeCliTurnSummary', () => ({ recordClaudeCliTurnMessage: vi.fn(), takeClaudeCliTurnSummary: vi.fn(() => null), clearClaudeCliTurnSummary: vi.fn() }));
vi.mock('../claudeCliTurnNotification', () => ({ extractAssistantText: vi.fn(() => 'answer'), buildTurnNotificationBody: vi.fn(() => 'answer') }));
vi.mock('../claudeCliResponseAnalytics', () => ({ buildClaudeCliResponseEvent: vi.fn(() => ({})) }));
vi.mock('../claudeCliObservation/claudeApiRequestParser', () => ({ extractToolResults: vi.fn(() => []) }));
vi.mock('../claudeCliObservation/proxyPassthroughEnv', () => ({ buildProxyPassthroughEnv: vi.fn(() => ({})) }));
vi.mock('../claudeCliObservation/claudeCliTranscriptBridge', () => ({ buildAssistantRawContent: vi.fn(() => JSON.stringify({ type: 'assistant', message: {} })) }));
vi.mock('../claudeCliObservation/claudeCliProxyObservation', () => ({
  ClaudeCliProxyObservation: class {
    constructor(callbacks: any) { state.callbacks = callbacks; }
    async start() { return { baseUrl: 'http://proxy.test' }; }
    stop() {}
  },
}));

import {
  clearClaudeCliQueuedTurnRegistration,
  fireClaudeCliTurnCompletion,
  registerClaudeCliQueuedTurn,
  startClaudeCliProxyObservation,
} from '../claudeCliObservationSingleton';

function registration(sessionId = 'session-1') {
  return {
    sessionId, workspacePath: '/workspace', queueRowId: `row-${sessionId}`, claimToken: `claim-${sessionId}`,
    clientSubmissionId: `client-${sessionId}`, sourceSessionId: sessionId, sourceRoomId: `room-${sessionId}`,
    submissionSequence: 1, producer: 'composer', claimTrigger: 'claude_cli_idle_flush', claimTriggeredAt: 1,
    turnId: `turn-${sessionId}`, providerInputMessageId: `input-${sessionId}`,
    providerOutputMessageId: `output-${sessionId}`, payloadReceipt: { utf8Bytes: 4, unicodeScalars: 4, sha256: 'a'.repeat(64) },
  };
}

describe('queued CLI observed-output truth boundary', () => {
  afterEach(() => {
    vi.useRealTimers();
    clearClaudeCliQueuedTurnRegistration('session-1');
    clearClaudeCliQueuedTurnRegistration('session-2');
    state.rows.length = 0;
    state.complete.mockClear();
    state.fail.mockClear();
    state.publishSnapshot.mockClear();
    state.reDrive.mockClear();
    state.subAgentInFlight = false;
  });

  it('binds a visible observed output and settles exactly once at idle', async () => {
    expect(registerClaudeCliQueuedTurn(registration())).toBe(true);
    await startClaudeCliProxyObservation({ sessionId: 'session-1', workspacePath: '/workspace' });
    state.callbacks.onAssistantMessage({ id: 'anthropic-1', model: 'claude', usage: {}, content: [] });
    await vi.waitFor(() => expect(state.rows).toHaveLength(1));
    expect(state.rows[0].metadata.queuedPromptTruth).toMatchObject({
      queueRowId: 'row-session-1', clientSubmissionId: 'client-session-1', turnId: 'turn-session-1',
      providerOutputMessageId: 'output-session-1', lifecycle: 'streaming', eventSequence: 1,
    });

    fireClaudeCliTurnCompletion('session-1', '/workspace');
    fireClaudeCliTurnCompletion('session-1', '/workspace');
    await vi.waitFor(() => expect(state.complete).toHaveBeenCalledTimes(1));
    expect(state.complete).toHaveBeenCalledWith('row-session-1', 'session-1', 'claim-session-1', expect.objectContaining({
      lifecycle: 'completed', eventSequence: 2, terminalAt: expect.any(Number),
    }));
    await vi.waitFor(() => expect(state.publishSnapshot).toHaveBeenCalledWith('session-1', expect.anything()));
    await vi.waitFor(() => expect(state.reDrive).toHaveBeenCalledTimes(1));
  });

  it('fences the association before terminal settlement awaits', async () => {
    let releaseSettlement: (() => void) | undefined;
    state.complete.mockImplementationOnce((rowId, sessionId, claimToken, terminal) => new Promise((resolve) => { releaseSettlement = () => resolve(settledTerminalResult(rowId, sessionId, claimToken, terminal)); }));
    expect(registerClaudeCliQueuedTurn(registration())).toBe(true);
    await startClaudeCliProxyObservation({ sessionId: 'session-1', workspacePath: '/workspace' });
    fireClaudeCliTurnCompletion('session-1', '/workspace');
    state.callbacks.onAssistantMessage({ id: 'immediate-next-turn', model: 'claude', usage: {}, content: [] });
    await vi.waitFor(() => expect(state.rows).toHaveLength(1));
    expect(state.rows[0].metadata).toBeUndefined();
    releaseSettlement?.();
    await vi.waitFor(() => expect(state.complete).toHaveBeenCalledTimes(1));
  });

  it('does not let a hidden Task sub-agent error fail or surface the parent row', async () => {
    expect(registerClaudeCliQueuedTurn(registration())).toBe(true);
    await startClaudeCliProxyObservation({ sessionId: 'session-1', workspacePath: '/workspace' });
    state.subAgentInFlight = true;
    state.callbacks.onUpstreamError({ statusCode: 500, body: 'failure' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.rows).toHaveLength(0);
    expect(state.fail).not.toHaveBeenCalled();
    fireClaudeCliTurnCompletion('session-1', '/workspace');
    await vi.waitFor(() => expect(state.complete).toHaveBeenCalledTimes(1));
  });

  it('reconciles an unresolved stale-owner result before permitting the next claim', async () => {
    vi.useFakeTimers();
    state.complete.mockResolvedValueOnce({ outcome: 'stale_owner' });
    expect(registerClaudeCliQueuedTurn(registration())).toBe(true);
    await startClaudeCliProxyObservation({ sessionId: 'session-1', workspacePath: '/workspace' });
    fireClaudeCliTurnCompletion('session-1', '/workspace');
    await vi.waitFor(() => expect(state.complete).toHaveBeenCalledTimes(1));
    expect(state.reDrive).not.toHaveBeenCalled();
    state.callbacks.onAssistantMessage({ id: 'post-reject', model: 'claude', usage: {}, content: [] });
    await vi.waitFor(() => expect(state.rows).toHaveLength(1));
    expect(state.rows[0].metadata).toBeUndefined();
    expect(registerClaudeCliQueuedTurn(registration())).toBe(false);
    await vi.advanceTimersByTimeAsync(25);
    await vi.waitFor(() => expect(state.complete).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(state.reDrive).toHaveBeenCalledTimes(1));
    expect(registerClaudeCliQueuedTurn(registration())).toBe(true);
  });

  it('fails closed at the finite ceiling for persistent thrown and stale terminal mutations', async () => {
    vi.useFakeTimers();
    state.complete
      .mockRejectedValueOnce(new Error('one'))
      .mockResolvedValueOnce({ outcome: 'stale_owner' })
      .mockResolvedValueOnce({ outcome: 'terminal_conflict' });
    expect(registerClaudeCliQueuedTurn(registration())).toBe(true);
    fireClaudeCliTurnCompletion('session-1', '/workspace');
    await vi.waitFor(() => expect(state.complete).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(25);
    expect(state.complete).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(50);
    expect(state.complete).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.complete).toHaveBeenCalledTimes(3);
    expect(state.publishSnapshot).not.toHaveBeenCalled();
    expect(state.reDrive).not.toHaveBeenCalled();
    expect(registerClaudeCliQueuedTurn(registration())).toBe(false);
  });

  it('reconciles a thrown terminal settlement with the immutable original receipt before progression', async () => {
    vi.useFakeTimers();
    state.complete.mockRejectedValueOnce(new Error('storage unavailable')).mockImplementationOnce(async (rowId, sessionId, claimToken, terminal) => settledTerminalResult(rowId, sessionId, claimToken, terminal));
    expect(registerClaudeCliQueuedTurn(registration())).toBe(true);
    fireClaudeCliTurnCompletion('session-1', '/workspace');
    await vi.waitFor(() => expect(state.complete).toHaveBeenCalledTimes(1));
    expect(state.publishSnapshot).not.toHaveBeenCalled();
    expect(state.reDrive).not.toHaveBeenCalled();
    expect(registerClaudeCliQueuedTurn(registration())).toBe(false);
    await vi.advanceTimersByTimeAsync(25);
    await vi.waitFor(() => expect(state.complete).toHaveBeenCalledTimes(2));
    expect(state.complete.mock.calls[1].slice(0, 3)).toEqual(state.complete.mock.calls[0].slice(0, 3));
    expect(state.complete.mock.calls[1][3]).toEqual(state.complete.mock.calls[0][3]);
    await vi.waitFor(() => expect(state.publishSnapshot).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(state.reDrive).toHaveBeenCalledTimes(1));
    expect(registerClaudeCliQueuedTurn(registration())).toBe(true);
  });

  it('keeps one bounded retry chain across repeated throws', async () => {
    vi.useFakeTimers();
    state.complete
      .mockRejectedValueOnce(new Error('transient one'))
      .mockRejectedValueOnce(new Error('transient two'))
      .mockImplementationOnce(async (rowId, sessionId, claimToken, terminal) => settledTerminalResult(rowId, sessionId, claimToken, terminal));
    expect(registerClaudeCliQueuedTurn(registration())).toBe(true);
    fireClaudeCliTurnCompletion('session-1', '/workspace');
    await vi.waitFor(() => expect(state.complete).toHaveBeenCalledTimes(1));
    expect(state.reDrive).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(25);
    expect(state.complete).toHaveBeenCalledTimes(2);
    expect(state.reDrive).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(50);
    expect(state.complete).toHaveBeenCalledTimes(3);
    expect(state.publishSnapshot).toHaveBeenCalledTimes(1);
    expect(state.reDrive).toHaveBeenCalledTimes(1);
  });

  it('matching teardown cancels a pending terminal retry before it can affect a newer claim', async () => {
    vi.useFakeTimers();
    state.complete.mockRejectedValueOnce(new Error('transient'));
    expect(registerClaudeCliQueuedTurn(registration())).toBe(true);
    fireClaudeCliTurnCompletion('session-1', '/workspace');
    await vi.waitFor(() => expect(state.complete).toHaveBeenCalledTimes(1));
    clearClaudeCliQueuedTurnRegistration('session-1', 'claim-session-1');
    const next = { ...registration(), claimToken: 'claim-next', turnId: 'turn-next', providerInputMessageId: 'input-next', providerOutputMessageId: 'output-next' };
    expect(registerClaudeCliQueuedTurn(next)).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.complete).toHaveBeenCalledTimes(1);
    expect(state.publishSnapshot).not.toHaveBeenCalled();
    expect(state.reDrive).not.toHaveBeenCalled();
  });

  it('discards an old in-flight terminal continuation after teardown and same-session replacement', async () => {
    let releaseOldSettlement: (() => void) | undefined;
    state.complete.mockImplementationOnce((rowId, sessionId, claimToken, terminal) => new Promise((resolve) => {
      releaseOldSettlement = () => resolve(settledTerminalResult(rowId, sessionId, claimToken, terminal));
    }));
    expect(registerClaudeCliQueuedTurn(registration())).toBe(true);
    await startClaudeCliProxyObservation({ sessionId: 'session-1', workspacePath: '/workspace' });
    fireClaudeCliTurnCompletion('session-1', '/workspace');
    await vi.waitFor(() => expect(state.complete).toHaveBeenCalledTimes(1));
    clearClaudeCliQueuedTurnRegistration('session-1', 'claim-session-1');
    const replacement = {
      ...registration(), queueRowId: 'row-replacement', claimToken: 'claim-replacement',
      clientSubmissionId: 'client-replacement', turnId: 'turn-replacement',
      providerInputMessageId: 'input-replacement', providerOutputMessageId: 'output-replacement',
    };
    expect(registerClaudeCliQueuedTurn(replacement)).toBe(true);
    releaseOldSettlement?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(state.publishSnapshot).not.toHaveBeenCalled();
    expect(state.reDrive).not.toHaveBeenCalled();
    state.callbacks.onAssistantMessage({ id: 'replacement-output', model: 'claude', usage: {}, content: [] });
    await vi.waitFor(() => expect(state.rows).toHaveLength(1));
    expect(state.rows[0].metadata.queuedPromptTruth.queueRowId).toBe('row-replacement');
  });

  it('discards a post-store teardown replacement before terminal snapshot publication', async () => {
    let replaceOldTurn: (() => void) | undefined;
    state.complete.mockImplementationOnce((rowId, sessionId, claimToken, terminal) =>
      Promise.resolve(settledTerminalResult(rowId, sessionId, claimToken, terminal)).then((result) => {
        queueMicrotask(() => queueMicrotask(() => replaceOldTurn?.()));
        return result;
      }),
    );
    expect(registerClaudeCliQueuedTurn(registration())).toBe(true);
    fireClaudeCliTurnCompletion('session-1', '/workspace');
    await vi.waitFor(() => expect(state.complete).toHaveBeenCalledTimes(1));
    replaceOldTurn = () => {
      clearClaudeCliQueuedTurnRegistration('session-1', 'claim-session-1');
      expect(registerClaudeCliQueuedTurn({
        ...registration(), queueRowId: 'row-post-store-replacement', claimToken: 'claim-post-store-replacement',
        clientSubmissionId: 'client-post-store-replacement', turnId: 'turn-post-store-replacement',
        providerInputMessageId: 'input-post-store-replacement', providerOutputMessageId: 'output-post-store-replacement',
      })).toBe(true);
    };
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(state.publishSnapshot).not.toHaveBeenCalled();
    expect(state.reDrive).not.toHaveBeenCalled();
  });

  it('does not let stale token cleanup clear a newer session fence', async () => {
    state.complete.mockImplementationOnce(async (rowId, sessionId, claimToken, terminal) => ({
      outcome: 'stale_owner',
      row: settledTerminalResult(rowId, sessionId, claimToken, terminal).row,
    }));
    expect(registerClaudeCliQueuedTurn(registration())).toBe(true);
    fireClaudeCliTurnCompletion('session-1', '/workspace');
    await vi.waitFor(() => expect(state.reDrive).toHaveBeenCalledTimes(1));
    const next = { ...registration(), claimToken: 'claim-next', turnId: 'turn-next', providerInputMessageId: 'input-next', providerOutputMessageId: 'output-next' };
    expect(registerClaudeCliQueuedTurn(next)).toBe(true);
    clearClaudeCliQueuedTurnRegistration('session-1', 'claim-session-1');
    expect(registerClaudeCliQueuedTurn({ ...next, claimToken: 'claim-third', turnId: 'turn-third', providerInputMessageId: 'input-third', providerOutputMessageId: 'output-third' })).toBe(false);
  });

  it('fails closed for conflicting registration and leaves an immediate observed turn unbound', async () => {
    expect(registerClaudeCliQueuedTurn(registration())).toBe(true);
    expect(registerClaudeCliQueuedTurn(registration())).toBe(false);
    clearClaudeCliQueuedTurnRegistration('session-1', 'claim-session-1');
    await startClaudeCliProxyObservation({ sessionId: 'session-1', workspacePath: '/workspace' });
    state.callbacks.onAssistantMessage({ id: 'immediate-1', model: 'claude', usage: {}, content: [] });
    await vi.waitFor(() => expect(state.rows).toHaveLength(1));
    expect(state.rows[0].metadata).toBeUndefined();
  });
});
