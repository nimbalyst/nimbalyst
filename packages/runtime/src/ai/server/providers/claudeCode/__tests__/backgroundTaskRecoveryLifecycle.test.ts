import { describe, expect, it, vi } from 'vitest';
import type { BackgroundAgentRecoveryCoordinator } from '../backgroundTaskRecovery';
import {
  guardClaudeBackgroundAgentRecoveryTool,
  observeClaudeBackgroundAgentRecoveryToolResult,
  prepareClaudeBackgroundAgentRecoveryTurn
} from '../backgroundTaskRecoveryLifecycle';

describe('Claude background-agent recovery provider lifecycle', () => {
  it('wires claim, system instruction, native guard, result, and recycled TaskStop persistence', async () => {
    const generation = 'provider-session:toolu_agent:g1';
    const coordinator = {
      claimResumeDispatches: vi.fn(async () => ({
        dispatches: [
          {
            generation,
            taskId: 'task-agent-1',
            agentId: 'toolu_agent',
            providerSessionId: 'provider-session',
            recipient: 'toolu_agent',
            priorState: 'running' as const,
            transcript: {
              relativePath:
                'workspace/provider-session/subagents/agent-toolu_agent.jsonl',
              parentRelativePath: 'workspace/provider-session.jsonl',
              sizeBytes: 100,
              mtimeMs: 200,
              fingerprint: '100:200:last-entry'
            }
          }
        ],
        notices: []
      })),
      guardNativeSendMessage: vi.fn(async () => ({
        matched: true,
        allow: true
      })),
      observeNativeSendMessageResult: vi.fn(async () => undefined),
      observeExplicitTaskStop: vi.fn(async () => true)
    } as unknown as BackgroundAgentRecoveryCoordinator;

    const prepared = await prepareClaudeBackgroundAgentRecoveryTurn(
      coordinator,
      {
        sessionId: 'session-1',
        workspacePath: 'D:\\workspace',
        providerSessionId: 'provider-session',
        turnId: 'provider-b:turn-1',
        isResume: true
      }
    );
    expect(prepared.plannedGenerations).toEqual([generation]);
    expect(prepared.systemInstruction).toContain(
      "call native SendMessage exactly once with to: 'toolu_agent'"
    );

    const preTool = await guardClaudeBackgroundAgentRecoveryTool(coordinator, {
      toolName: 'SendMessage',
      sessionId: 'session-1',
      turnId: 'provider-b:turn-1',
      toolUseId: 'native-send-1',
      toolInput: { to: 'toolu_agent', summary: 'Continue original work' },
      plannedGenerations: prepared.plannedGenerations
    });
    expect(preTool).toEqual({ handled: false });
    expect(coordinator.guardNativeSendMessage).toHaveBeenCalledWith({
      sessionId: 'session-1',
      turnId: 'provider-b:turn-1',
      toolUseId: 'native-send-1',
      input: { to: 'toolu_agent', summary: 'Continue original work' },
      plannedGenerations: [generation]
    });

    await observeClaudeBackgroundAgentRecoveryToolResult(coordinator, {
      sessionId: 'session-1',
      turnId: 'provider-b:turn-1',
      toolName: 'SendMessage',
      toolUseId: 'native-send-1',
      toolArguments: { to: 'toolu_agent' },
      isError: false,
      content: 'delivered'
    });
    expect(coordinator.observeNativeSendMessageResult).toHaveBeenCalledWith({
      sessionId: 'session-1',
      turnId: 'provider-b:turn-1',
      toolUseId: 'native-send-1',
      isError: false,
      content: 'delivered'
    });

    const stopped = await observeClaudeBackgroundAgentRecoveryToolResult(
      coordinator,
      {
        sessionId: 'session-1',
        turnId: 'provider-b:turn-1',
        toolName: 'TaskStop',
        toolUseId: 'native-task-stop-1',
        toolArguments: { task_id: 'task-agent-1' },
        isError: false,
        content: 'stopped'
      }
    );
    expect(stopped).toEqual({ stoppedTaskId: 'task-agent-1' });
    expect(coordinator.observeExplicitTaskStop).toHaveBeenCalledWith({
      sessionId: 'session-1',
      taskId: 'task-agent-1'
    });
  });

  it('maps a missing-session recovery denial to the provider pre-tool hook boundary', async () => {
    const coordinator = {
      guardNativeSendMessage: vi.fn(async () => ({
        matched: true,
        allow: false,
        reason: 'background-agent-recovery-session-missing'
      }))
    } as unknown as BackgroundAgentRecoveryCoordinator;

    await expect(
      guardClaudeBackgroundAgentRecoveryTool(coordinator, {
        toolName: 'SendMessage',
        sessionId: 'deleted-session',
        turnId: 'provider-b:turn-1',
        toolUseId: 'native-send-1',
        toolInput: { to: 'toolu_agent' },
        plannedGenerations: ['provider-session:toolu_agent:g1']
      })
    ).resolves.toEqual({
      handled: true,
      result: {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'background-agent-recovery-session-missing'
        }
      }
    });
  });
});
