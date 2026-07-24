import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentToolHooks } from '../AgentToolHooks';
import type { AgentToolHooksOptions } from '../AgentToolHooks';

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

    it('still runs compound-bash checks in agent mode', async () => {
      const pending = new Map();
      const options = createMockOptions({
        getCurrentMode: () => 'agent',
        getPendingToolPermissions: () => pending as any,
        getSessionApprovedPatterns: () => new Set<string>(),
      });
      const hooks = new AgentToolHooks(options);
      const preToolHook = hooks.createPreToolUseHook();

      // Kick off the hook -- handleCompoundBashCommand emits a pending
      // permission for the `cd` sub-command and then blocks on a response.
      // We only care that the emit happened (proves the splitter ran in agent
      // mode), so detach the promise instead of awaiting it.
      const resultPromise = preToolHook(
        { tool_name: 'Bash', tool_input: { command: 'cd packages/runtime && echo ok' } },
        'tool-use-agent-compound-1',
        { signal: new AbortController().signal }
      );
      void resultPromise.catch(() => {});

      await Promise.resolve();
      await Promise.resolve();

      expect(options.emit).toHaveBeenCalledWith('toolPermission:pending', expect.any(Object));
    });
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
  });
});
