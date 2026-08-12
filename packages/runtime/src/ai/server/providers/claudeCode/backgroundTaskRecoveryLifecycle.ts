import {
  BackgroundAgentRecoveryCoordinator,
  buildBackgroundAgentRecoveryInstruction,
  type BackgroundAgentRecoveryDispatch,
  type BackgroundAgentRecoveryNotice
} from './backgroundTaskRecovery';

type ClaimResumeInput = Parameters<
  BackgroundAgentRecoveryCoordinator['claimResumeDispatches']
>[0];

export interface PreparedClaudeBackgroundAgentRecoveryTurn {
  dispatches: BackgroundAgentRecoveryDispatch[];
  notices: BackgroundAgentRecoveryNotice[];
  plannedGenerations: string[];
  systemInstruction: string;
}

export async function prepareClaudeBackgroundAgentRecoveryTurn(
  coordinator: BackgroundAgentRecoveryCoordinator,
  input: ClaimResumeInput
): Promise<PreparedClaudeBackgroundAgentRecoveryTurn> {
  const recovery = await coordinator.claimResumeDispatches(input);
  return {
    ...recovery,
    plannedGenerations: recovery.dispatches.map(
      (dispatch) => dispatch.generation
    ),
    systemInstruction: buildBackgroundAgentRecoveryInstruction(
      recovery.dispatches,
      recovery.notices
    )
  };
}

interface RecoveryToolGuardInput {
  toolName: string;
  sessionId?: string;
  turnId?: string;
  toolUseId?: string;
  toolInput?: Record<string, unknown>;
  plannedGenerations?: readonly string[];
}

export type ClaudeBackgroundAgentRecoveryToolGuardResult =
  | { handled: false }
  | {
      handled: true;
      result: {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse';
          permissionDecision: 'deny';
          permissionDecisionReason?: string;
        };
      };
    };

export async function guardClaudeBackgroundAgentRecoveryTool(
  coordinator: BackgroundAgentRecoveryCoordinator,
  input: RecoveryToolGuardInput
): Promise<ClaudeBackgroundAgentRecoveryToolGuardResult> {
  if (
    input.toolName !== 'SendMessage' ||
    !input.sessionId ||
    !input.turnId ||
    !input.toolUseId
  ) {
    return { handled: false };
  }

  const decision = await coordinator.guardNativeSendMessage({
    sessionId: input.sessionId,
    turnId: input.turnId,
    toolUseId: input.toolUseId,
    input: input.toolInput ?? {},
    plannedGenerations: input.plannedGenerations
  });
  if (!decision.matched || decision.allow) return { handled: false };

  return {
    handled: true,
    result: {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: decision.reason
      }
    }
  };
}

export function getClaudeTaskStopTarget(
  toolName: string,
  toolArguments: Record<string, unknown> | undefined,
  isError: boolean
): string | undefined {
  if (toolName !== 'TaskStop' || isError) return undefined;
  if (typeof toolArguments?.task_id === 'string') {
    return toolArguments.task_id;
  }
  return typeof toolArguments?.shell_id === 'string'
    ? toolArguments.shell_id
    : undefined;
}

interface RecoveryToolResultInput {
  sessionId?: string;
  turnId: string;
  toolName: string;
  toolUseId?: string;
  toolArguments?: Record<string, unknown>;
  isError: boolean;
  content?: unknown;
}

export async function observeClaudeBackgroundAgentRecoveryToolResult(
  coordinator: BackgroundAgentRecoveryCoordinator,
  input: RecoveryToolResultInput
): Promise<{ stoppedTaskId?: string }> {
  const stoppedTaskId = getClaudeTaskStopTarget(
    input.toolName,
    input.toolArguments,
    input.isError
  );

  if (input.sessionId && input.toolName === 'SendMessage' && input.toolUseId) {
    await coordinator.observeNativeSendMessageResult({
      sessionId: input.sessionId,
      turnId: input.turnId,
      toolUseId: input.toolUseId,
      isError: input.isError,
      content: input.content
    });
  }
  if (input.sessionId && stoppedTaskId) {
    await coordinator.observeExplicitTaskStop({
      sessionId: input.sessionId,
      taskId: stoppedTaskId
    });
  }

  return { stoppedTaskId };
}
