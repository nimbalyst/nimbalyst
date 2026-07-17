import { afterEach, describe, expect, it, vi } from 'vitest';
import { store } from '@nimbalyst/runtime/store';
import {
  refreshSessionListAtom,
  refreshPendingPromptsAtom,
  sessionHasPendingInteractivePromptAtom,
  sessionListWorkspaceAtom,
  sessionStoreAtom,
  sessionPendingPromptsAtom,
  sessionUnreadAtom,
} from '../sessions';

const workspacePath = '/workspace/refresh-state';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('refreshSessionListAtom authoritative flags', () => {
  it('rehydrates unread and pending-input flags in both directions', async () => {
    const sessionId = `refresh-state-${Date.now()}`;
    store.set(sessionListWorkspaceAtom, workspacePath);
    store.set(sessionUnreadAtom(sessionId), true);
    store.set(sessionHasPendingInteractivePromptAtom(sessionId), true);
    store.set(sessionPendingPromptsAtom(sessionId), [{
      id: 'stale-prompt',
      sessionId,
      promptType: 'permission_request',
      promptId: 'stale-prompt',
      data: {},
      createdAt: 1,
    }]);

    const invoke = vi.fn().mockResolvedValue({
      success: true,
      sessions: [{
        id: sessionId,
        title: 'Refresh state test',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        hasUnread: false,
        hasPendingInteractivePrompt: false,
      }],
    });
    vi.stubGlobal('window', { electronAPI: { invoke } });

    await store.set(refreshSessionListAtom);

    expect(invoke).toHaveBeenCalledWith('sessions:list', workspacePath, {
      includeArchived: false,
    });
    expect(store.get(sessionUnreadAtom(sessionId))).toBe(false);
    expect(store.get(sessionHasPendingInteractivePromptAtom(sessionId))).toBe(false);
    expect(store.get(sessionPendingPromptsAtom(sessionId))).toEqual([]);
  });
});

describe('refreshPendingPromptsAtom canonical identities', () => {
  it('rehydrates exact prompt identities and ignores completed interactive tools', () => {
    const sessionId = `refresh-prompts-${Date.now()}`;
    const createdAt = new Date();
    store.set(sessionStoreAtom(sessionId), {
      id: sessionId,
      messages: [
        {
          id: 1,
          sequence: 1,
          createdAt,
          type: 'interactive_prompt',
          subagentId: null,
          interactivePrompt: {
            promptType: 'permission_request',
            requestId: 'permission-1',
            status: 'pending',
            toolName: 'Bash',
            rawCommand: 'npm test',
            pattern: 'npm test',
            patternDisplayName: 'npm test',
            isDestructive: false,
            warnings: [],
          },
        },
        {
          id: 2,
          sequence: 2,
          createdAt,
          type: 'tool_call',
          subagentId: null,
          toolCall: {
            toolName: 'mcp__nimbalyst__PromptForUserInput',
            toolDisplayName: 'PromptForUserInput',
            status: 'running',
            description: null,
            arguments: { title: 'Choose' },
            targetFilePath: null,
            mcpServer: 'nimbalyst',
            mcpTool: 'PromptForUserInput',
            providerToolCallId: 'input-2',
            progress: [],
          },
        },
        {
          id: 3,
          sequence: 3,
          createdAt,
          type: 'tool_call',
          subagentId: null,
          toolCall: {
            toolName: 'AskUserQuestion',
            toolDisplayName: 'AskUserQuestion',
            status: 'completed',
            description: null,
            arguments: {},
            targetFilePath: null,
            mcpServer: null,
            mcpTool: null,
            providerToolCallId: 'answered-3',
            progress: [],
          },
        },
      ],
    } as any);

    store.set(refreshPendingPromptsAtom, sessionId);

    expect(store.get(sessionHasPendingInteractivePromptAtom(sessionId))).toBe(true);
    expect(store.get(sessionPendingPromptsAtom(sessionId))).toEqual([
      expect.objectContaining({
        promptType: 'permission_request',
        promptId: 'permission-1',
      }),
      expect.objectContaining({
        promptType: 'request_user_input_request',
        promptId: 'input-2',
      }),
    ]);
  });
});
