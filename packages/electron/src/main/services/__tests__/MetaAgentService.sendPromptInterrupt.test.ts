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

  it('skips the interrupt on an idle session and uses the normal idle drive', async () => {
    const h = setup({ status: 'idle' });
    const result = await send(h, true);

    expect(h.interruptCurrentTurn).not.toHaveBeenCalled();
    expect(h.triggerQueuedPromptProcessingForSession).toHaveBeenCalledWith(TARGET, WORKSPACE, 'meta-agent');
    expect(result.interrupted).toBe(false);
    expect(result.processingTriggered).toBe(true);
  });
});
