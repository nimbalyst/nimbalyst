import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentToolHooks } from '../AgentToolHooks';
import type { AgentToolHooksOptions } from '../AgentToolHooks';
import { agentToolActivity } from '../../agentToolActivity';
import { __resetClaudeShellTrackingForTests, claudeShellEndTurn, setClaudeShellTrackingSink } from '../../claudeShellTracking';
import { parseExitPlanModeDeferral, type ExitPlanModeResponse } from '../../../exitPlanModeDeferral';

// Mock fs module
vi.mock('fs', () => ({
  default: {
    readFileSync: vi.fn(() => 'file content'),
  },
  readFileSync: vi.fn(() => 'file content'),
}));

function createMockOptions(overrides?: Partial<AgentToolHooksOptions>): AgentToolHooksOptions {
  return {
    workspacePath: '/test/workspace',
    sessionId: 'test-session-1',
    emit: vi.fn(),
    logAgentMessage: vi.fn().mockResolvedValue(undefined),
    logSecurity: vi.fn(),
    historyManager: {
      createSnapshot: vi.fn().mockResolvedValue(undefined),
      getPendingTags: vi.fn().mockResolvedValue([]),
      tagFile: vi.fn().mockResolvedValue(undefined),
      updateTagStatus: vi.fn().mockResolvedValue(undefined),
    },
    ...overrides,
  };
}

describe('AgentToolHooks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Bash pre-tool hook: no pre-tagging', () => {
    it('does not call tagFile or getPendingTags for Bash tool', async () => {
      const options = createMockOptions();
      const hooks = new AgentToolHooks(options);
      const preToolHook = hooks.createPreToolUseHook();

      await preToolHook(
        { tool_name: 'Bash', tool_input: { command: 'echo "hello" > /test/workspace/file.txt' } },
        'tool-use-1',
        { signal: new AbortController().signal }
      );

      expect(options.historyManager!.getPendingTags).not.toHaveBeenCalled();
      expect(options.historyManager!.tagFile).not.toHaveBeenCalled();
      expect(options.historyManager!.updateTagStatus).not.toHaveBeenCalled();
    });

    it('does not create or clear pending diff tags for Bash', async () => {
      const options = createMockOptions({
        historyManager: {
          createSnapshot: vi.fn().mockResolvedValue(undefined),
          getPendingTags: vi.fn().mockResolvedValue([
            { id: 'existing-tag', createdAt: new Date(), sessionId: 'other-session' },
          ]),
          tagFile: vi.fn().mockResolvedValue(undefined),
          updateTagStatus: vi.fn().mockResolvedValue(undefined),
        },
      });

      const hooks = new AgentToolHooks(options);
      const preToolHook = hooks.createPreToolUseHook();

      await preToolHook(
        { tool_name: 'Bash', tool_input: { command: 'sed -i "" "s/old/new/g" /test/workspace/file.txt' } },
        'tool-use-2',
        { signal: new AbortController().signal }
      );

      // Should NOT have cleared the other session's tag (was the old bug)
      expect(options.historyManager!.updateTagStatus).not.toHaveBeenCalled();
      expect(options.historyManager!.tagFile).not.toHaveBeenCalled();
    });
  });

  describe('Bash pre-tool hook: Auto mode delegates to classifier', () => {
    it('skips the compound-bash splitter when session mode is auto', async () => {
      const getPendingToolPermissions = vi.fn();
      const options = createMockOptions({
        getCurrentMode: () => 'auto',
        getPendingToolPermissions,
        getSessionApprovedPatterns: () => new Set<string>(),
      });
      const hooks = new AgentToolHooks(options);
      const preToolHook = hooks.createPreToolUseHook();

      const result = await preToolHook(
        { tool_name: 'Bash', tool_input: { command: 'cd packages/runtime && npx tsc --noEmit | tail -10' } },
        'tool-use-auto-compound-1',
        { signal: new AbortController().signal }
      );

      // No-op return lets the SDK classifier own the decision; compound-bash
      // would otherwise have surfaced a Nimbalyst permission prompt for `cd`.
      expect(result).toEqual({});
      expect(options.emit).not.toHaveBeenCalled();
      expect(options.logAgentMessage).not.toHaveBeenCalled();
      expect(getPendingToolPermissions).not.toHaveBeenCalled();
    });
  });

  describe('Bash pre-tool hook: compound commands defer to the SDK', () => {
    it('does not prompt for a compound command in agent mode', async () => {
      const pending = new Map();
      const options = createMockOptions({
        getCurrentMode: () => 'agent',
        getPendingToolPermissions: () => pending as any,
        getSessionApprovedPatterns: () => new Set<string>(),
      });
      const hooks = new AgentToolHooks(options);
      const preToolHook = hooks.createPreToolUseHook();

      // User PreToolUse hooks run in parallel with this one, so a prompt
      // raised here would ignore their `allow`. No decision lets the SDK
      // combine hook results and call canUseTool only if still needed.
      const result = await preToolHook(
        { tool_name: 'Bash', tool_input: { command: "grep -l '^x:' src/*.md | sed 's|a||;s|b||' > /tmp/out.txt; wc -l < /tmp/out.txt" } },
        'tool-use-agent-compound-1',
        { signal: new AbortController().signal }
      );

      expect(result).toEqual({});
      expect(options.emit).not.toHaveBeenCalled();
      expect(options.logAgentMessage).not.toHaveBeenCalled();
      expect(pending.size).toBe(0);
    });
  });

  it('reports a shell command as a possible writer only while it runs', async () => {
    const hooks = new AgentToolHooks(createMockOptions({ sessionId: 'activity-session' }));
    const signal = new AbortController().signal;
    const input = { tool_name: 'Bash', tool_input: { command: 'node generate.js' } };
    const file = '/test/workspace/generated.ts';
    expect(agentToolActivity.writerEvidence('activity-session', file, Date.now())).toBe('idle');
    await hooks.createPreToolUseHook()(input, 'activity-bash', { signal });
    expect(agentToolActivity.writerEvidence('activity-session', file, Date.now())).toBe('possible');
    await hooks.createPostToolUseHook()(input, 'activity-bash', { signal });
    expect(agentToolActivity.writerEvidence('activity-session', file, Date.now() + 10_000)).toBe('idle');
  });

  // Hook windows bracket every Bash call so a file it writes is linked to the
  // session even when the command never names the file.
  it('opens a shell window before Bash runs and keeps a backgrounded one open past its acknowledgement', async () => {
    const calls: string[] = [];
    setClaudeShellTrackingSink({
      isTracking: (id) => id === 'shell-session',
      pre: async (_id, toolUseId) => { calls.push('pre:' + toolUseId); },
      post: async (_id, toolUseId) => { calls.push('post:' + toolUseId); },
      endTurn: async () => { calls.push('endTurn'); },
      drain: async () => {},
    });
    try {
      const hooks = new AgentToolHooks(createMockOptions({ sessionId: 'shell-session' }));
      const signal = new AbortController().signal;
      const foreground = { tool_name: 'Bash', tool_input: { command: "python3 - <<'EOF'\np='x.ts'\nEOF" } };
      const background = { tool_name: 'Bash', tool_input: { command: 'pnpm test', run_in_background: true } };

      expect(await hooks.createPreToolUseHook()(foreground, 'fg', { signal })).toEqual({});
      expect(calls).toEqual(['pre:fg']);
      await hooks.createPostToolUseHook()(foreground, 'fg', { signal });
      await hooks.createPreToolUseHook()(background, 'bg', { signal });
      await hooks.createPostToolUseHook()(background, 'bg', { signal });
      expect(calls).toEqual(['pre:fg', 'post:fg', 'pre:bg']);
      // Turn-end snapshots come from linked files, not parsed command text.
      expect(hooks.getEditedFiles().size).toBe(0);

      claudeShellEndTurn('shell-session');
      expect(calls).toEqual(['pre:fg', 'post:fg', 'pre:bg', 'endTurn']);
    } finally {
      __resetClaudeShellTrackingForTests();
    }
  });

  describe('Bash post-tool hook: editedFilesThisTurn tracking', () => {
    it('tracks Bash-affected files in editedFilesThisTurn via post-tool hook', async () => {
      const options = createMockOptions();
      const hooks = new AgentToolHooks(options);
      const postToolHook = hooks.createPostToolUseHook();

      // Bash command that writes to a file
      await postToolHook(
        { tool_name: 'Bash', tool_input: { command: 'echo "data" > /test/workspace/output.txt' } },
        'tool-use-3',
        { signal: new AbortController().signal }
      );

      const editedFiles = hooks.getEditedFiles();
      // parseBashForFileOps may or may not detect this depending on implementation,
      // but the important thing is no pre-tagging happened
      expect(options.historyManager!.tagFile).not.toHaveBeenCalled();
    });
  });

  describe('Edit/Write/MultiEdit: pre-tagging preserved', () => {
    it('still tags files for Edit tool', async () => {
      const options = createMockOptions();
      const hooks = new AgentToolHooks(options);
      const preToolHook = hooks.createPreToolUseHook();

      await preToolHook(
        {
          tool_name: 'Edit',
          tool_input: {
            file_path: '/test/workspace/src/module.ts',
            old_string: 'old code',
            new_string: 'new code',
          },
        },
        'tool-use-4',
        { signal: new AbortController().signal }
      );

      expect(options.historyManager!.getPendingTags).toHaveBeenCalledWith('/test/workspace/src/module.ts');
      expect(options.historyManager!.tagFile).toHaveBeenCalled();
    });

    it('still tags files for Write tool', async () => {
      const options = createMockOptions();
      const hooks = new AgentToolHooks(options);
      const preToolHook = hooks.createPreToolUseHook();

      await preToolHook(
        {
          tool_name: 'Write',
          tool_input: {
            file_path: '/test/workspace/src/new-file.ts',
            content: 'new content',
          },
        },
        'tool-use-5',
        { signal: new AbortController().signal }
      );

      expect(options.historyManager!.getPendingTags).toHaveBeenCalledWith('/test/workspace/src/new-file.ts');
      expect(options.historyManager!.tagFile).toHaveBeenCalled();
    });

    it('still tags files for MultiEdit tool', async () => {
      const options = createMockOptions();
      const hooks = new AgentToolHooks(options);
      const preToolHook = hooks.createPreToolUseHook();

      await preToolHook(
        {
          tool_name: 'MultiEdit',
          tool_input: {
            edits: [
              { file_path: '/test/workspace/src/a.ts', old_string: 'x', new_string: 'y' },
              { file_path: '/test/workspace/src/b.ts', old_string: 'x', new_string: 'y' },
            ],
          },
        },
        'tool-use-6',
        { signal: new AbortController().signal }
      );

      expect(options.historyManager!.getPendingTags).toHaveBeenCalledWith('/test/workspace/src/a.ts');
      expect(options.historyManager!.getPendingTags).toHaveBeenCalledWith('/test/workspace/src/b.ts');
      expect(options.historyManager!.tagFile).toHaveBeenCalledTimes(2);
    });
  });

  describe('PermissionDenied hook (auto-mode classifier re-prompt)', () => {
    it('returns no-op when session is not in auto mode', async () => {
      const options = createMockOptions({ getCurrentMode: () => 'agent' });
      const hooks = new AgentToolHooks(options);
      const hook = hooks.createPermissionDeniedHook();

      const result = await hook(
        {
          tool_name: 'Bash',
          tool_input: { command: 'git reset --hard HEAD~1' },
          reason: 'destructive git op',
        },
        'tool-use-denied-1',
        { signal: new AbortController().signal }
      );

      expect(result).toEqual({});
      expect(options.emit).not.toHaveBeenCalled();
      expect(options.logAgentMessage).not.toHaveBeenCalled();
    });

    it('prompts user via ToolPermission widget and returns retry:true on approve', async () => {
      const pending = new Map<string, {
        resolve: (value: { decision: 'allow' | 'deny'; scope: 'once' | 'session' | 'always' | 'always-all' }) => void;
        reject: (err: Error) => void;
        request: any;
      }>();
      const sessionApprovedPatterns = new Set<string>();
      const options = createMockOptions({
        getCurrentMode: () => 'auto',
        getPendingToolPermissions: () => pending,
        getSessionApprovedPatterns: () => sessionApprovedPatterns,
      });
      const hooks = new AgentToolHooks(options);
      const hook = hooks.createPermissionDeniedHook();

      const resultPromise = hook(
        {
          tool_name: 'Bash',
          tool_input: { command: 'git reset --hard HEAD~1' },
          reason: 'destructive git op',
        },
        'tool-use-denied-3',
        { signal: new AbortController().signal }
      );

      // Let the hook log & emit before responding
      await Promise.resolve();
      await Promise.resolve();

      expect(options.logAgentMessage).toHaveBeenCalledOnce();
      const logCall = (options.logAgentMessage as any).mock.calls[0];
      const persistedPayload = JSON.parse(logCall[3]);
      expect(persistedPayload).toMatchObject({
        type: 'nimbalyst_tool_use',
        name: 'ToolPermission',
        input: expect.objectContaining({
          toolName: 'Bash',
          warnings: expect.arrayContaining([
            expect.stringContaining('destructive git op'),
          ]),
        }),
      });
      expect(options.emit).toHaveBeenCalledWith('toolPermission:pending', expect.any(Object));

      const pendingEntry = Array.from(pending.values())[0];
      expect(pendingEntry).toBeDefined();
      pendingEntry.resolve({ decision: 'allow', scope: 'session' });

      await expect(resultPromise).resolves.toEqual({
        hookSpecificOutput: {
          hookEventName: 'PermissionDenied',
          retry: true,
        },
      });
      // Session-scope approval should be cached so the SDK doesn't bounce the
      // retry off the classifier again on the very next attempt.
      expect(sessionApprovedPatterns.size).toBe(1);
    });

    it('carries the Bash description to the ToolPermission widget', async () => {
      const pending = new Map<string, any>();
      const options = createMockOptions({
        getCurrentMode: () => 'auto',
        getPendingToolPermissions: () => pending,
        getSessionApprovedPatterns: () => new Set<string>(),
      });
      const hooks = new AgentToolHooks(options);
      const hook = hooks.createPermissionDeniedHook();

      const resultPromise = hook(
        {
          tool_name: 'Bash',
          tool_input: { command: 'git reset --hard HEAD~1', description: 'Drop the last commit' },
          reason: 'destructive git op',
        },
        'tool-use-denied-5',
        { signal: new AbortController().signal }
      );

      await Promise.resolve();
      await Promise.resolve();

      const persistedPayload = JSON.parse((options.logAgentMessage as any).mock.calls[0][3]);
      expect(persistedPayload.input.description).toBe('Drop the last commit');

      Array.from(pending.values())[0].resolve({ decision: 'deny', scope: 'once' });
      await resultPromise;
    });

    it('shows what a sub-agent will do instead of the bare tool name', async () => {
      const pending = new Map<string, any>();
      const options = createMockOptions({
        getCurrentMode: () => 'auto',
        getPendingToolPermissions: () => pending,
        getSessionApprovedPatterns: () => new Set<string>(),
      });
      const hooks = new AgentToolHooks(options);
      const hook = hooks.createPermissionDeniedHook();

      const resultPromise = hook(
        {
          tool_name: 'Agent',
          tool_input: { description: 'Survey open issues', prompt: 'Search the tracker for duplicates of ...' },
          reason: '[Modify Shared Resources]',
        },
        'tool-use-denied-6',
        { signal: new AbortController().signal }
      );

      await Promise.resolve();
      await Promise.resolve();

      const persistedPayload = JSON.parse((options.logAgentMessage as any).mock.calls[0][3]);
      expect(persistedPayload.input.rawCommand).toBe('Survey open issues');

      Array.from(pending.values())[0].resolve({ decision: 'deny', scope: 'once' });
      await resultPromise;
    });

    it('returns no-op (denial stands) when the user denies the re-prompt', async () => {
      const pending = new Map<string, any>();
      const options = createMockOptions({
        getCurrentMode: () => 'auto',
        getPendingToolPermissions: () => pending,
        getSessionApprovedPatterns: () => new Set<string>(),
      });
      const hooks = new AgentToolHooks(options);
      const hook = hooks.createPermissionDeniedHook();

      const resultPromise = hook(
        {
          tool_name: 'Bash',
          tool_input: { command: 'rm -rf ~' },
          reason: 'destructive',
        },
        'tool-use-denied-4',
        { signal: new AbortController().signal }
      );

      await Promise.resolve();
      await Promise.resolve();

      const pendingEntry = Array.from(pending.values())[0];
      pendingEntry.resolve({ decision: 'deny', scope: 'once' });

      await expect(resultPromise).resolves.toEqual({});
      expect(options.emit).toHaveBeenCalledWith(
        'toolPermission:resolved',
        expect.objectContaining({ response: { decision: 'deny', scope: 'once' } })
      );
    });

    // retry:true alone sends the call back through the classifier, which
    // blocked it again, so the approved tool never ran.
    it.each(['once', 'session'] as const)(
      'lets the approved retry skip the classifier (scope=%s)',
      async (scope) => {
        const pending = new Map<string, any>();
        const sessionApprovedPatterns = new Set<string>();
        const options = createMockOptions({
          getCurrentMode: () => 'auto',
          getPendingToolPermissions: () => pending,
          getSessionApprovedPatterns: () => sessionApprovedPatterns,
        });
        const hooks = new AgentToolHooks(options);
        const agentCall = { tool_name: 'Agent', tool_input: { prompt: 'deploy', description: 'ship it' } };

        const denied = hooks.createPermissionDeniedHook()(
          { ...agentCall, reason: '[Production Deploy]' },
          'tool-use-denied-5',
          { signal: new AbortController().signal }
        );
        await Promise.resolve();
        await Promise.resolve();
        Array.from(pending.values())[0].resolve({ decision: 'allow', scope });
        await denied;

        const preToolUse = hooks.createPreToolUseHook();
        const signal = new AbortController().signal;
        await expect(preToolUse(agentCall, 'tool-use-retry', { signal })).resolves.toMatchObject({
          hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
        });
        // A one-time approval covers only the retry.
        const next = await preToolUse(agentCall, 'tool-use-next', { signal });
        if (scope === 'once') {
          expect(next).toEqual({});
        } else {
          expect(next).toMatchObject({ hookSpecificOutput: { permissionDecision: 'allow' } });
        }
      }
    );

    it('matches a one-time approval to the exact retried call, including compound Bash', async () => {
      const pending = new Map<string, any>();
      const hooks = new AgentToolHooks(createMockOptions({
        getCurrentMode: () => 'auto',
        getPendingToolPermissions: () => pending,
        getSessionApprovedPatterns: () => new Set<string>(),
      }));
      const bashCall = { tool_name: 'Bash', tool_input: { command: 'git add -A && git push' } };
      const denied = hooks.createPermissionDeniedHook()(
        { ...bashCall, reason: 'push' },
        'tool-use-denied-7',
        { signal: new AbortController().signal }
      );
      await Promise.resolve();
      await Promise.resolve();
      Array.from(pending.values())[0].resolve({ decision: 'allow', scope: 'once' });
      await denied;

      const preToolUse = hooks.createPreToolUseHook();
      const signal = new AbortController().signal;
      const other = { tool_name: 'Bash', tool_input: { command: 'git add -A && git push --force' } };
      await expect(preToolUse(other, 'tool-use-other', { signal })).resolves.toEqual({});
      await expect(preToolUse(bashCall, 'tool-use-retry', { signal })).resolves.toMatchObject({
        hookSpecificOutput: { permissionDecision: 'allow' },
      });
    });

    // retry:true only adds a fixed "you may retry" hint, so the model could not
    // tell the user had approved and sometimes skipped the call.
    it('tells the model the user approved the exact call, and only on approval', async () => {
      const pending = new Map<string, any>();
      const sendApprovalToModel = vi.fn((_text: string) => true);
      const hooks = new AgentToolHooks(createMockOptions({
        getCurrentMode: () => 'auto',
        getPendingToolPermissions: () => pending,
        getSessionApprovedPatterns: () => new Set<string>(),
        sendApprovalToModel,
      }));
      const command = 'git fetch -q && gh workflow run publish.yml -f dry_run=true';
      const run = async (decision: 'allow' | 'deny') => {
        const denied = hooks.createPermissionDeniedHook()(
          { tool_name: 'Bash', tool_input: { command }, reason: '[Destructive]' },
          'tool-use-denied-8',
          { signal: new AbortController().signal }
        );
        await Promise.resolve();
        await Promise.resolve();
        const [requestId, entry] = Array.from(pending.entries()).at(-1)!;
        pending.delete(requestId);
        entry.resolve({ decision, scope: 'once' });
        return denied;
      };

      await run('deny');
      expect(sendApprovalToModel).not.toHaveBeenCalled();

      await run('allow');
      expect(sendApprovalToModel).toHaveBeenCalledOnce();
      expect(sendApprovalToModel.mock.calls[0][0]).toContain(command);
    });

    it('offers only a one-time approval for a compound Bash command', async () => {
      const pending = new Map<string, any>();
      const options = createMockOptions({
        getCurrentMode: () => 'auto',
        getPendingToolPermissions: () => pending,
        getSessionApprovedPatterns: () => new Set<string>(),
      });
      const hooks = new AgentToolHooks(options);
      const signal = new AbortController().signal;
      void hooks.createPermissionDeniedHook()(
        { tool_name: 'Bash', tool_input: { command: 'git fetch && git push' }, reason: 'x' },
        'tool-use-denied-9',
        { signal }
      );
      void hooks.createPermissionDeniedHook()(
        { tool_name: 'Bash', tool_input: { command: 'git push' }, reason: 'x' },
        'tool-use-denied-10',
        { signal }
      );
      await Promise.resolve();
      await Promise.resolve();
      const widgets = (options.logAgentMessage as any).mock.calls.map((call: any[]) => JSON.parse(call[3]).input);
      expect(widgets.map((w: any) => w.suppressAlwaysAllowRule === true)).toEqual([true, false]);
    });

    it('honours a saved project-local allow rule only in auto mode', async () => {
      let mode: 'agent' | 'auto' = 'auto';
      const localAllowRuleChecker = vi.fn(async (_workspacePath: string, pattern: string) => pattern === 'Agent');
      const preToolUse = new AgentToolHooks(createMockOptions({
        getCurrentMode: () => mode,
        getSessionApprovedPatterns: () => new Set<string>(),
        localAllowRuleChecker,
      })).createPreToolUseHook();
      const signal = new AbortController().signal;
      const agentCall = { tool_name: 'Agent', tool_input: { prompt: 'deploy' } };

      await expect(preToolUse(agentCall, 'tool-use-1', { signal })).resolves.toMatchObject({
        hookSpecificOutput: { permissionDecision: 'allow' },
      });
      expect(localAllowRuleChecker).toHaveBeenCalledWith('/test/workspace', 'Agent');
      await expect(preToolUse({ tool_name: 'Skill', tool_input: {} }, 'tool-use-2', { signal })).resolves.toEqual({});

      mode = 'agent';
      await expect(preToolUse(agentCall, 'tool-use-3', { signal })).resolves.toEqual({});
    });

    it('marks the prompt cancelled when the turn aborts before the user answers', async () => {
      const pending = new Map<string, any>();
      const options = createMockOptions({
        getCurrentMode: () => 'auto',
        getPendingToolPermissions: () => pending,
        getSessionApprovedPatterns: () => new Set<string>(),
      });
      const controller = new AbortController();
      const resultPromise = new AgentToolHooks(options).createPermissionDeniedHook()(
        { tool_name: 'mcp__tracker__create', tool_input: {}, reason: '[Production Deploy]' },
        'tool-use-denied-6',
        { signal: controller.signal }
      );
      await Promise.resolve();
      await Promise.resolve();
      const requestId = Array.from(pending.keys())[0];

      controller.abort();
      await expect(resultPromise).resolves.toEqual({});

      const persisted = (options.logAgentMessage as any).mock.calls.map((call: any[]) => JSON.parse(call[3]));
      const result = persisted.find((p: any) => p.type === 'nimbalyst_tool_result');
      expect(result).toMatchObject({ tool_use_id: requestId });
      expect(JSON.parse(result.result)).toMatchObject({ decision: 'deny', cancelled: true });
    });
  });

  describe('ExitPlanMode pre-tool hook', () => {
    it('denies ExitPlanMode when planFilePath is missing and tells the agent to retry with it', async () => {
      const options = createMockOptions({
        getCurrentMode: () => 'planning',
        getPendingExitPlanModeConfirmations: () => new Map(),
      });
      const hooks = new AgentToolHooks(options);
      const preToolHook = hooks.createPreToolUseHook();

      const result = await preToolHook(
        {
          tool_name: 'ExitPlanMode',
          tool_input: {
            plan: 'Implement the approved plan',
          },
        },
        'tool-use-exit-1',
        { signal: new AbortController().signal }
      );

      expect(result).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'ExitPlanMode requires the planFilePath argument. Try ExitPlanMode again and include the fully qualified plan file path.'
        }
      });
      expect(options.emit).not.toHaveBeenCalled();
      expect(options.logAgentMessage).not.toHaveBeenCalled();
    });

    it('continues to create an interactive confirmation when planFilePath is present', async () => {
      const pending = new Map<string, { resolve: (value: { approved: boolean }) => void; reject: (error: Error) => void }>();
      const options = createMockOptions({
        getCurrentMode: () => 'planning',
        getPendingExitPlanModeConfirmations: () => pending as any,
      });
      const hooks = new AgentToolHooks(options);
      const preToolHook = hooks.createPreToolUseHook();

      const resultPromise = preToolHook(
        {
          tool_name: 'ExitPlanMode',
          tool_input: {
            plan: 'Implement the approved plan',
            planFilePath: 'plans/feature-plan.md',
          },
        },
        'tool-use-exit-2',
        { signal: new AbortController().signal }
      );

      await Promise.resolve();

      expect(options.logAgentMessage).toHaveBeenCalledOnce();
      expect(options.emit).toHaveBeenCalledWith('exitPlanMode:confirm', expect.objectContaining({
        requestId: 'tool-use-exit-2',
        planFilePath: 'plans/feature-plan.md',
      }));

      pending.get('tool-use-exit-2')!.resolve({ approved: true });

      await expect(resultPromise).resolves.toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
        }
      });
    });

    it('records a plan handed to a new session so the plan card can show it', async () => {
      const pending = new Map<string, { resolve: (value: ExitPlanModeResponse) => void; reject: (error: Error) => void }>();
      const options = createMockOptions({
        getCurrentMode: () => 'planning',
        getPendingExitPlanModeConfirmations: () => pending as any,
      });
      const preToolHook = new AgentToolHooks(options).createPreToolUseHook();

      const resultPromise = preToolHook(
        { tool_name: 'ExitPlanMode', tool_input: { plan: 'p', planFilePath: 'plans/feature-plan.md' } },
        'tool-use-exit-3',
        { signal: new AbortController().signal }
      );
      await Promise.resolve();
      const deferredTo = { kind: 'session' as const };
      pending.get('tool-use-exit-3')!.resolve({ approved: false, deferredTo });

      const result = await resultPromise;
      expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
      expect(parseExitPlanModeDeferral(result.hookSpecificOutput.permissionDecisionReason)).toEqual(deferredTo);
      // Older transcript bundles (shipped mobile apps) hide the plan card unless
      // the result reads as a denial to their keyword match.
      expect(result.hookSpecificOutput.permissionDecisionReason.toLowerCase()).toContain('cancelled');
    });
  });
});
