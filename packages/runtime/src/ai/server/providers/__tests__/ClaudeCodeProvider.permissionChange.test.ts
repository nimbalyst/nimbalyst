/**
 * Mid-turn permission changes on ClaudeCodeProvider (NIM-2403).
 *
 * A turn resolves its effective session mode once and hands the derived
 * `permissionMode` to `query()` for the life of that turn. Switching the project
 * to "Allow everything" while the agent is running therefore did nothing until
 * the agent stopped — the SDK classifier kept escalating, and
 * `immediateToolDecision` deliberately refuses to let bypass-all short-circuit a
 * classifier escalation. These tests cover the push into the live query.
 */

// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => ({
  app: { ...(await import('../../../../../../electron/test-stubs/privateUserData')).testApp, isPackaged: false },
}));

vi.mock('../claudeCode/cliPathResolver', () => ({
  resolveClaudeAgentCliPath: async () => '/fake/claude',
}));

vi.mock('../../../../electron/claudeCodeEnvironment', () => ({
  setupClaudeCodeEnvironment: () => ({}),
  resolveNativeBinaryPath: () => undefined,
}));

import { ClaudeCodeProvider } from '../ClaudeCodeProvider';
import { BaseAgentProvider } from '../BaseAgentProvider';
import { TranscriptRuntime } from '../../transcript/TranscriptRuntime';
import type { RawMessage } from '../../transcript/TranscriptTransformer';

type TrustStatus = {
  trusted: boolean;
  mode: 'ask' | 'allow-all' | 'bypass-all' | null;
  allowAllUsesClassifier?: boolean;
};

/** Register a provider as mid-turn with a fake live query. */
function streamingProvider(state: {
  requestedMode: 'planning' | 'agent' | 'auto';
  currentMode: 'planning' | 'agent' | 'auto';
  setPermissionMode?: (mode: string) => Promise<void>;
}) {
  const setPermissionMode = vi.fn(state.setPermissionMode ?? (async () => {}));
  const provider = new ClaudeCodeProvider();
  Object.assign(provider as unknown as Record<string, unknown>, {
    requestedMode: state.requestedMode,
    currentMode: state.currentMode,
    pathForTrust: '/proj',
    leadQuery: { setPermissionMode },
  });
  (ClaudeCodeProvider as unknown as { streamingInstances: Set<unknown> }).streamingInstances.add(provider);
  return { provider, setPermissionMode };
}

const modeOf = (provider: ClaudeCodeProvider) =>
  (provider as unknown as { currentMode?: string }).currentMode;

function trustIs(status: TrustStatus) {
  ClaudeCodeProvider.setTrustChecker(() => status);
}

describe('ClaudeCodeProvider mid-turn permission changes', () => {
  afterEach(() => {
    (ClaudeCodeProvider as unknown as { streamingInstances: Set<unknown> }).streamingInstances.clear();
    BaseAgentProvider.setTrustChecker(null);
    vi.restoreAllMocks();
  });

  it('drops a turn out of classifier mode when the project switches to Allow everything', async () => {
    const { provider, setPermissionMode } = streamingProvider({
      requestedMode: 'agent',
      currentMode: 'auto',
    });
    trustIs({ trusted: true, mode: 'bypass-all', allowAllUsesClassifier: false });

    await ClaudeCodeProvider.applyPermissionChange();

    expect(setPermissionMode).toHaveBeenCalledWith('default');
    expect(modeOf(provider)).toBe('agent');
  });

  it('turns the classifier on mid-turn when the project switches to Agent-verified', async () => {
    const { provider, setPermissionMode } = streamingProvider({
      requestedMode: 'agent',
      currentMode: 'agent',
    });
    trustIs({ trusted: true, mode: 'bypass-all', allowAllUsesClassifier: true });

    await ClaudeCodeProvider.applyPermissionChange();

    expect(setPermissionMode).toHaveBeenCalledWith('auto');
    expect(modeOf(provider)).toBe('auto');
  });

  it('leaves an explicitly-requested auto session alone', async () => {
    const { provider, setPermissionMode } = streamingProvider({
      requestedMode: 'auto',
      currentMode: 'auto',
    });
    trustIs({ trusted: true, mode: 'bypass-all', allowAllUsesClassifier: false });

    await ClaudeCodeProvider.applyPermissionChange();

    expect(setPermissionMode).not.toHaveBeenCalled();
    expect(modeOf(provider)).toBe('auto');
  });

  it('does not touch the SDK when the effective mode is unchanged', async () => {
    const { setPermissionMode } = streamingProvider({
      requestedMode: 'agent',
      currentMode: 'agent',
    });
    trustIs({ trusted: true, mode: 'ask', allowAllUsesClassifier: false });

    await ClaudeCodeProvider.applyPermissionChange();

    expect(setPermissionMode).not.toHaveBeenCalled();
  });

  it('rolls the tracked mode back when the SDK call fails on a dead transport', async () => {
    const { provider, setPermissionMode } = streamingProvider({
      requestedMode: 'agent',
      currentMode: 'auto',
      setPermissionMode: async () => {
        throw new Error('transport closed');
      },
    });
    trustIs({ trusted: true, mode: 'bypass-all', allowAllUsesClassifier: false });

    await ClaudeCodeProvider.applyPermissionChange();

    expect(setPermissionMode).toHaveBeenCalled();
    // canUseTool must keep honouring the mode the turn actually runs under.
    expect(modeOf(provider)).toBe('auto');
  });
});

// #1740: an Agent-verified (auto) query's escalated call must wait for the user even in
// bypass-all, but a teammate query runs 'default' and keeps the bypass-all shortcut.
describe('ClaudeCodeProvider canUseTool under an Agent-verified lead', () => {
  afterEach(() => {
    BaseAgentProvider.setTrustChecker(null);
    vi.restoreAllMocks();
  });

  function autoLeadInBypassAll() {
    const requestToolPermission = vi.fn(async () => ({ decision: 'deny' as const, scope: 'once' as const }));
    const provider = new ClaudeCodeProvider();
    Object.assign(provider as unknown as Record<string, unknown>, {
      currentMode: 'auto',
      permissionService: { requestToolPermission },
    });
    vi.spyOn(provider as any, 'logAgentMessage').mockResolvedValue(undefined);
    trustIs({ trusted: true, mode: 'bypass-all', allowAllUsesClassifier: true });
    const handler = (...args: unknown[]) => (provider as any).createCanUseToolHandler('session', '/proj', '/proj', ...args);
    const call = (canUseTool: any) =>
      canUseTool('Bash', { command: 'touch /tmp/ask-probe-1' }, { signal: new AbortController().signal });
    return { requestToolPermission, handler, call };
  }

  it('asks the permission service to wait for the user on the lead query', async () => {
    const { requestToolPermission, handler, call } = autoLeadInBypassAll();
    expect(await call(handler())).toMatchObject({ behavior: 'deny' });
    expect(requestToolPermission).toHaveBeenCalledWith(expect.objectContaining({ requiresUserDecision: 'escalated' }));
  });

  it('keeps the bypass-all shortcut for a teammate query running in default mode', async () => {
    const { requestToolPermission, handler, call } = autoLeadInBypassAll();
    expect(await call(handler('teammate-a', 'default'))).toMatchObject({ behavior: 'allow' });
    expect(requestToolPermission).not.toHaveBeenCalled();
  });
});

// #1741: a hook "ask" on a compound command is answered as a whole. Splitting it would let
// sub-commands approved earlier this session run without the prompt the hook asked for.
describe('ClaudeCodeProvider canUseTool with a PreToolUse hook ask', () => {
  afterEach(() => {
    BaseAgentProvider.setTrustChecker(null);
    vi.restoreAllMocks();
  });

  it('prompts once for the whole compound command even when its parts are approved', async () => {
    const requestToolPermission = vi.fn(async () => ({ decision: 'deny' as const, scope: 'once' as const }));
    const provider = new ClaudeCodeProvider();
    Object.assign(provider as unknown as Record<string, unknown>, {
      currentMode: 'agent',
      permissionService: { requestToolPermission, getSessionApprovedPatterns: () => new Set(['Bash(ls:*)', 'Bash(touch:*)']) },
    });
    vi.spyOn(provider as any, 'logAgentMessage').mockResolvedValue(undefined);
    trustIs({ trusted: true, mode: 'allow-all' });
    const canUseTool = (provider as any).createCanUseToolHandler('session', '/proj', '/proj');
    const command = 'ls && touch /tmp/ask-probe-9';
    const result = await canUseTool('Bash', { command }, { signal: new AbortController().signal, decisionReasonType: 'hook' });
    expect(result).toMatchObject({ behavior: 'deny' });
    expect(requestToolPermission).toHaveBeenCalledTimes(1);
    expect(requestToolPermission).toHaveBeenCalledWith(expect.objectContaining({ toolInput: { command }, requiresUserDecision: 'hook-ask' }));
  });
});

// #375: reconstruct the prompt from raw provider rows, including after cache eviction.
describe('ClaudeCodeProvider approvals during settings lookup', () => {
  afterEach(() => {
    BaseAgentProvider.setTrustChecker(null);
    ClaudeCodeProvider.setClaudeSettingsPatternSaver(null);
    ClaudeCodeProvider.setClaudeSettingsPatternChecker(null);
    vi.restoreAllMocks();
  });

  it('records the released approval so the waiting prompt stays answered after reload', async () => {
    let releaseLookup!: (approved: boolean) => void;
    const checker = vi.fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockImplementationOnce(() => new Promise(resolve => { releaseLookup = resolve; }));
    trustIs({ trusted: true, mode: 'ask' });
    ClaudeCodeProvider.setClaudeSettingsPatternSaver(async () => {});
    ClaudeCodeProvider.setClaudeSettingsPatternChecker(checker);
    const provider = new ClaudeCodeProvider();
    vi.spyOn((provider as any).permissionService, 'pollForPermissionResponse').mockResolvedValue(undefined);
    const rows: RawMessage[] = [];
    vi.spyOn(provider as any, 'logAgentMessage').mockImplementation(async (...args: unknown[]) => {
      const [sessionId, source, direction, content] = args as [string, RawMessage['source'], RawMessage['direction'], string];
      rows.push({ id: rows.length + 1, sessionId, source, direction, content, createdAt: new Date() });
    });
    const pending = vi.fn();
    provider.on('toolPermission:pending', pending);
    const ask = () => (provider as any).handleToolPermissionWithService(
      'mcp__serena__find_symbol', {}, { signal: new AbortController().signal },
      'session', '/project', '/project', undefined, undefined, false,
    );
    const first = ask();
    await vi.waitFor(() => expect(pending).toHaveBeenCalledTimes(1));
    const second = ask();
    await vi.waitFor(() => expect(checker).toHaveBeenCalledTimes(2));
    const prompts = rows.map(row => JSON.parse(row.content));
    expect(prompts).toHaveLength(2);
    const releasedId = prompts[1].id;
    const runtime = new TranscriptRuntime({
      getMessages: async (sessionId, afterId = 0) => rows.filter(row => row.sessionId === sessionId && row.id > afterId),
    });
    await runtime.getCanonicalEvents('session', 'claude-code');
    provider.resolveToolPermission(prompts[0].id, { decision: 'allow', scope: 'always' }, 'session');
    await first;
    releaseLookup(false);
    expect(await second).toMatchObject({ behavior: 'allow' });
    expect(pending).toHaveBeenCalledTimes(1);

    await runtime.processNewMessages('session', 'claude-code');
    for (const reload of [false, true]) {
      if (reload) await runtime.forceReparseSession('session', 'claude-code');
      const events = await runtime.getCanonicalEvents('session', 'claude-code');
      const released = events.find(event => event.eventType === 'tool_call' && event.providerToolCallId === releasedId);
      expect(released?.payload).toMatchObject({ status: 'completed' });
      expect(JSON.parse((released?.payload as any).result)).toMatchObject({ decision: 'allow', scope: 'session' });
    }
    expect(rows.filter(row => {
      const message = JSON.parse(row.content);
      return message.type === 'nimbalyst_tool_result' && message.tool_use_id === releasedId;
    })).toHaveLength(1);
  });
});

describe('ClaudeCodeProvider AskUserQuestion dismissal', () => {
  type AskInternals = {
    handleSystemInit: (chunk: unknown, sessionId: string | undefined, hideMessages: boolean) => Generator<unknown>;
    handleAskUserQuestion: (
      sessionId: string | undefined,
      input: unknown,
      options: { signal: AbortSignal },
      toolUseID?: string,
    ) => Promise<{ behavior: string; updatedInput?: any; message?: string }>;
    pendingAskUserQuestions: Map<string, unknown>;
  };

  async function dismissAfterInit(capabilities: string[] | undefined) {
    const provider = new ClaudeCodeProvider();
    const internals = provider as unknown as AskInternals;
    [...internals.handleSystemInit({ type: 'system', subtype: 'init', capabilities }, undefined, true)];
    const result = internals.handleAskUserQuestion(
      undefined,
      { questions: [{ question: 'Ship it?', header: 'Ship', options: [], multiSelect: false }] },
      { signal: new AbortController().signal },
      'toolu_dismiss',
    );
    await vi.waitFor(() => expect(internals.pendingAskUserQuestions.has('toolu_dismiss')).toBe(true));
    const rejected = provider.rejectAskUserQuestion('toolu_dismiss', new Error('User cancelled'));
    return Object.assign(await result, { rejected });
  }

  it('answers a cancelled question with unanswered=dismissed when init advertises the capability', async () => {
    const result = await dismissAfterInit(['interrupt_receipt_v1', 'ask_user_question_unanswered_v1']);
    expect(result.behavior).toBe('allow');
    expect(result.updatedInput.annotations).toEqual({ 'Ship it?': { unanswered: 'dismissed' } });
    // Tells the cancel IPC not to abort the turn that will read this answer.
    expect(result.rejected).toBe('dismissed');
  });

  it('keeps denying a cancelled question on a CLI whose init has no capabilities', async () => {
    const result = await dismissAfterInit(undefined);
    expect(result.behavior).toBe('deny');
    expect(result.message).toBe('User cancelled');
    expect(result.rejected).toBeUndefined();
  });
});
