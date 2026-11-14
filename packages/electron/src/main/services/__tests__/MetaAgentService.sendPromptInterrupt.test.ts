// @vitest-environment node
/**
 * `send_prompt({ interrupt: true })` is the tool-side equivalent of the
 * transcript's send-now lightning bolt: queue the prompt, stop the turn that is
 * in the way, then drive the queue. The branches that matter are the ones where
 * interrupting is wrong -- a session parked on an interactive prompt, and a
 * terminal-backed CLI session whose queue drains through a different path.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({
  AISessionsRepository: { create: vi.fn(), updateMetadata: vi.fn(), get: vi.fn() },
}));
vi.mock('@nimbalyst/runtime/storage/repositories/AgentMessagesRepository', () => ({
  AgentMessagesRepository: {},
}));
vi.mock('@nimbalyst/runtime/storage/repositories/SessionFilesRepository', () => ({
  SessionFilesRepository: {},
}));
vi.mock('@nimbalyst/runtime/ai/server', () => ({
  ClaudeCodeProvider: { setMetaAgentServerPort: vi.fn() },
  OpenAICodexProvider: { setMetaAgentServerPort: vi.fn() },
  OpenAICodexACPProvider: { setMetaAgentServerPort: vi.fn() },
  SessionManager: class { async initialize() {} },
}));
vi.mock('@nimbalyst/runtime/ai/server/types', () => ({ ModelIdentifier: {} }));
vi.mock('@nimbalyst/runtime/ai/server/SessionStateManager', () => ({
  getSessionStateManager: () => ({ subscribe: vi.fn() }),
}));
vi.mock('../ai/providerResolution', () => ({
  resolveExtensionAgentRef: () => null,
  isExtensionAgentProvider: () => false,
}));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../SyncManager', () => ({ getSyncProvider: () => ({ pushChange: vi.fn() }) }));
vi.mock('../../utils/ipcRegistry', () => ({ safeHandle: vi.fn() }));
vi.mock('../../utils/store', () => ({ getDefaultAIModel: () => null }));
vi.mock('../../utils/timestampUtils', () => ({ toMillis: (v: unknown) => v }));
vi.mock('../WorktreeStore', () => ({ createWorktreeStore: vi.fn() }));
vi.mock('../GitWorktreeService', () => ({ GitWorktreeService: class {} }));
vi.mock('../../database/PGLiteDatabaseWorker', () => ({
  database: { query: vi.fn().mockResolvedValue({ rows: [] }) },
}));
vi.mock('../../database/initialize', () => ({ getDatabase: () => null }));
vi.mock('../../file/GitRefWatcher', () => ({ gitRefWatcher: {} }));
vi.mock('./ai/AIService', () => ({ AIService: class {} }));
vi.mock('../../mcp/metaAgentServer', () => ({ setMetaAgentToolFns: vi.fn() }));
vi.mock('../metaAgentNotificationSignature', () => ({ computeNotificationSignature: vi.fn() }));
vi.mock('../metaAgentMessageText', () => ({
  extractMessageText: vi.fn(),
  extractUserPrompts: vi.fn(),
}));
vi.mock('../ai/claudeCliLauncherSingleton', () => ({
  ClaudeCliLauncherConfig: { setMetaAgentServerPort: vi.fn() },
}));

import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import { MetaAgentService } from '../MetaAgentService';
import { captureQueueAuthorization, holdQueueAfterStop, isQueueStopped } from '../ai/stoppedQueueHold';
import { runQueueDriveAttempt } from '../ai/queueDriveAttempt';

const WORKSPACE = '/workspace/path';
const TARGET = 'target-session';

interface Harness {
  service: any;
  interruptCurrentTurn: ReturnType<typeof vi.fn>;
  driveQueuedPrompts: ReturnType<typeof vi.fn>;
  triggerQueuedPromptProcessingForSession: ReturnType<typeof vi.fn>;
}

function setup(row: { status: string; provider?: string }): Harness {
  const service = MetaAgentService.getInstance() as any;
  vi.mocked(AISessionsRepository.get).mockResolvedValue({
    id: TARGET,
    workspacePath: WORKSPACE,
    provider: row.provider ?? 'claude-code',
  } as any);
  // NODE_ENV is 'test' under vitest, which would otherwise take the
  // synthetic-message bypass and never reach the queue at all.
  vi.spyOn(service, 'shouldBypassChildAgentExecutionForTests').mockReturnValue(false);
  vi.spyOn(service, 'getSessionStatusRow').mockResolvedValue({ id: TARGET, ...row });

  const interruptCurrentTurn = vi.fn().mockResolvedValue({ success: true, method: 'interrupt' });
  const driveQueuedPrompts = vi.fn().mockResolvedValue({ kind: 'dispatched' });
  const triggerQueuedPromptProcessingForSession = vi.fn().mockResolvedValue(true);
  service.aiService = {
    queuePromptForSession: vi.fn().mockResolvedValue({ id: 'queued-1', prompt: 'do the thing' }),
    interruptCurrentTurn,
    driveQueuedPrompts,
    triggerQueuedPromptProcessingForSession,
  };

  return { service, interruptCurrentTurn, driveQueuedPrompts, triggerQueuedPromptProcessingForSession };
}

async function send(h: Harness, interrupt?: boolean) {
  const json = await h.service.sendPromptToSession('origin', TARGET, WORKSPACE, 'do the thing', interrupt);
  return JSON.parse(json);
}

describe('send_prompt interrupt', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(AISessionsRepository.get).mockReset();
    captureQueueAuthorization(TARGET)();
  });

  it('interrupts a running session and drives the queue', async () => {
    const h = setup({ status: 'running' });
    const result = await send(h, true);

    expect(h.interruptCurrentTurn).toHaveBeenCalledWith(TARGET);
    expect(h.driveQueuedPrompts).toHaveBeenCalledWith(TARGET, WORKSPACE, 'send-now');
    // Queue first, then interrupt: the drive that follows must find the row.
    expect(h.service.aiService.queuePromptForSession.mock.invocationCallOrder[0])
      .toBeLessThan(h.interruptCurrentTurn.mock.invocationCallOrder[0]);
    expect(result.interrupted).toBe(true);
    expect(result.interruptMethod).toBe('interrupt');
  });

  it('leaves a running session alone when interrupt is not requested', async () => {
    const h = setup({ status: 'running' });
    const result = await send(h);

    expect(h.interruptCurrentTurn).not.toHaveBeenCalled();
    expect(h.triggerQueuedPromptProcessingForSession).not.toHaveBeenCalled();
    expect(result.interrupted).toBe(false);
    expect(result.processingTriggered).toBe(false);
  });

  it('preserves explicit report semantics while defaulting untyped sends to instructions', async () => {
    const h = setup({ status: 'running' });
    await send(h);
    expect(h.service.aiService.queuePromptForSession).toHaveBeenLastCalledWith(TARGET, 'do the thing', undefined, {
      promptProvenance: { actor: 'agent', origin: 'session-orchestration', originSessionId: 'origin', messageKind: 'instruction' },
    });
    await h.service.sendPromptToSession('origin', TARGET, WORKSPACE, 'validation findings', false, 'report');
    expect(h.service.aiService.queuePromptForSession).toHaveBeenLastCalledWith(TARGET, 'validation findings', undefined, {
      promptProvenance: { actor: 'agent', origin: 'session-orchestration', originSessionId: 'origin', messageKind: 'report' },
    });
    expect(h.interruptCurrentTurn).not.toHaveBeenCalled();
  });

  it('does not interrupt a session waiting on an interactive prompt', async () => {
    const h = setup({ status: 'waiting_for_input' });
    const result = await send(h, true);

    expect(h.interruptCurrentTurn).not.toHaveBeenCalled();
    expect(result.interrupted).toBe(false);
    expect(result.interruptSkippedReason).toBe('waiting-for-input');
  });

  it('does not interrupt a terminal-backed CLI session', async () => {
    const h = setup({ status: 'running', provider: 'claude-code-cli' });
    const result = await send(h, true);

    expect(h.interruptCurrentTurn).not.toHaveBeenCalled();
    expect(result.interruptSkippedReason).toBe('terminal-session');
  });

  it('resumes a stopped idle queue with explicit Send Now without aborting a provider', async () => {
    const h = setup({ status: 'idle', provider: 'openai-codex' });
    holdQueueAfterStop(TARGET);
    h.driveQueuedPrompts.mockImplementation(async () => isQueueStopped(TARGET)
      ? { kind: 'deferred', reason: 'queue-stopped' }
      : { kind: 'dispatched', promptId: 'older-steering' });
    const result = await send(h, true);

    expect(h.interruptCurrentTurn).not.toHaveBeenCalled();
    expect(h.driveQueuedPrompts).toHaveBeenCalledWith(TARGET, WORKSPACE, 'send-now');
    expect(result.interrupted).toBe(false);
    expect(result.processingTriggered).toBe(true);
  });

  it('reports an ordinary idle instruction as deferred when Stop still holds it', async () => {
    const h = setup({ status: 'idle', provider: 'openai-codex' });
    holdQueueAfterStop(TARGET);
    h.driveQueuedPrompts.mockResolvedValue({ kind: 'deferred', reason: 'queue-stopped' });
    h.triggerQueuedPromptProcessingForSession.mockResolvedValue(false);
    const result = await send(h);
    expect(result).toMatchObject({ processingTriggered: false, driveOutcome: 'deferred', deferredReason: 'queue-stopped' });
    expect(isQueueStopped(TARGET)).toBe(true);
  });

  it('does not authorize a later Stop while the requested resume is saving', async () => {
    const h = setup({ status: 'idle', provider: 'openai-codex' });
    holdQueueAfterStop(TARGET);
    h.service.aiService.queuePromptForSession.mockImplementation(async () => {
      holdQueueAfterStop(TARGET);
      return { id: 'queued-1', prompt: 'do the thing' };
    });
    h.driveQueuedPrompts.mockImplementation(async () => isQueueStopped(TARGET)
      ? { kind: 'deferred', reason: 'queue-stopped' } : { kind: 'dispatched' });
    expect(await send(h, true)).toMatchObject({ processingTriggered: false, deferredReason: 'queue-stopped' });
    expect(isQueueStopped(TARGET)).toBe(true);
  });

  it('retains Stop if durable enqueue fails', async () => {
    const h = setup({ status: 'idle', provider: 'openai-codex' });
    holdQueueAfterStop(TARGET);
    h.service.aiService.queuePromptForSession.mockRejectedValue(new Error('save failed'));
    await expect(send(h, true)).rejects.toThrow('save failed');
    expect(isQueueStopped(TARGET)).toBe(true);
    expect(h.driveQueuedPrompts).not.toHaveBeenCalled();
  });

  it('does not interrupt a running target when a newer Stop superseded the saved resume', async () => {
    const h = setup({ status: 'running', provider: 'openai-codex' });
    h.service.aiService.queuePromptForSession.mockImplementation(async () => {
      holdQueueAfterStop(TARGET);
      return { id: 'new-resume', prompt: 'do the thing' };
    });
    expect(await send(h, true)).toMatchObject({ processingTriggered: false, interruptSkippedReason: 'superseded-by-stop', deferredReason: 'queue-stopped' });
    expect(h.interruptCurrentTurn).not.toHaveBeenCalled();
    expect(h.driveQueuedPrompts).not.toHaveBeenCalled();
  });

  it('explains a held instruction even while a stopped target still reports running', async () => {
    const h = setup({ status: 'running', provider: 'openai-codex' });
    holdQueueAfterStop(TARGET);
    expect(await send(h)).toMatchObject({ processingTriggered: false, deferredReason: 'queue-stopped' });
    expect(h.driveQueuedPrompts).not.toHaveBeenCalled();
  });

  it('resumes the existing oldest steering through the real drive decision', async () => {
    const h = setup({ status: 'idle', provider: 'openai-codex' });
    holdQueueAfterStop(TARGET);
    const delivered: string[] = [];
    const pending = ['existing-steering', 'existing-recovery'];
    h.service.aiService.queuePromptForSession.mockImplementation(async () => {
      pending.push('new-resume');
      return { id: 'new-resume', prompt: 'do the thing' };
    });
    h.driveQueuedPrompts.mockImplementation(async (sessionId, workspacePath, reason) => runQueueDriveAttempt({
      listPendingIds: async () => [...pending], isChainActive: () => false, isSessionBusy: () => false,
      resolveWindow: async () => ({ kind: 'window', window: {}, opened: false }),
      failAllPending: async () => 0, logWarn: vi.fn(),
      dispatch: async () => { delivered.push(pending.shift()!); return true; },
    }, { sessionId, workspacePath, reason }));
    expect(await send(h, true)).toMatchObject({ processingTriggered: true, driveOutcome: 'dispatched' });
    expect(delivered).toEqual(['existing-steering']);
    expect(pending).toEqual(['existing-recovery', 'new-resume']);
  });

  it.each(['report', 'status'] as const)('does not release Stop for an informational %s even with interrupt set', async kind => {
    const h = setup({ status: 'idle', provider: 'openai-codex' });
    holdQueueAfterStop(TARGET);
    h.driveQueuedPrompts.mockResolvedValue({ kind: 'deferred', reason: 'queue-stopped' });
    await h.service.sendPromptToSession('origin', TARGET, WORKSPACE, 'info', true, kind);
    expect(isQueueStopped(TARGET)).toBe(true);
    expect(h.interruptCurrentTurn).not.toHaveBeenCalled();
  });

  it.each(['report', 'status'] as const)('does not wake or interrupt an unheld session for an informational %s', async kind => {
    for (const status of ['idle', 'running']) {
      const h = setup({ status });
      const result = JSON.parse(await h.service.sendPromptToSession('origin', TARGET, WORKSPACE, 'info', true, kind));
      expect(result).toMatchObject({ processingTriggered: false, interruptSkippedReason: 'informational-message' });
      expect(h.interruptCurrentTurn).not.toHaveBeenCalled();
      expect(h.driveQueuedPrompts).not.toHaveBeenCalled();
    }
  });

  it('preserves a question that appeared while the prompt was being saved', async () => {
    const h = setup({ status: 'running', provider: 'openai-codex' });
    h.service.getSessionStatusRow.mockResolvedValueOnce({ status: 'running' }).mockResolvedValueOnce({ status: 'waiting_for_input' });
    const result = await send(h, true);
    expect(result).toMatchObject({ statusBeforeQueue: 'running', interruptSkippedReason: 'waiting-for-input', processingTriggered: false });
    expect(h.interruptCurrentTurn).not.toHaveBeenCalled();
    expect(h.driveQueuedPrompts).not.toHaveBeenCalled();
  });

  it('keeps the existing terminal-backed idle queue consumer', async () => {
    const h = setup({ status: 'idle', provider: 'claude-code-cli' });
    expect(await send(h, true)).toMatchObject({ processingTriggered: true, interruptSkippedReason: 'terminal-session' });
    expect(h.interruptCurrentTurn).not.toHaveBeenCalled();
    expect(h.driveQueuedPrompts).toHaveBeenCalledWith(TARGET, WORKSPACE, 'meta-agent');
  });
});
