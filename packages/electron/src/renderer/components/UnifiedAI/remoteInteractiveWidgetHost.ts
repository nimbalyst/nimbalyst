import {
  noopInteractiveWidgetHost,
  type InteractiveWidgetHost,
} from '@nimbalyst/runtime/ui/AgentTranscript/components/CustomToolWidgets/InteractiveWidgetHost';
import type { RemotePromptResponse } from '../../../shared/remoteSessions';

/** Sends prompt answers from a remote session's transcript to the machine that runs it. */
export function createRemoteInteractiveWidgetHost(
  sessionId: string,
  workspacePath: string,
  onError: (message: string) => void,
): InteractiveWidgetHost {
  const send = async (answer: RemotePromptResponse): Promise<void> => {
    try {
      await window.electronAPI.invoke('ai:respondRemotePrompt', sessionId, workspacePath, answer);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
      throw error;
    }
  };
  const refuse = (message: string): never => {
    onError(message);
    throw new Error(message);
  };

  return {
    ...noopInteractiveWidgetHost,
    sessionId,
    workspacePath,
    worktreeId: null,
    askUserQuestionSubmit: (promptId, answers) =>
      send({ promptType: 'ask_user_question', promptId, response: { answers } }),
    askUserQuestionCancel: (promptId) =>
      send({ promptType: 'ask_user_question', promptId, response: { answers: {}, cancelled: true } }),
    requestUserInputSubmit: (promptId, answers) =>
      send({ promptType: 'request_user_input', promptId, response: { answers } }),
    requestUserInputCancel: (promptId) =>
      send({ promptType: 'request_user_input', promptId, response: { answers: {}, cancelled: true } }),
    exitPlanModeApprove: (promptId) =>
      send({ promptType: 'exit_plan_mode', promptId, response: { approved: true } }),
    exitPlanModeDeny: (promptId, feedback) =>
      send({ promptType: 'exit_plan_mode', promptId, response: { approved: false, feedback } }),
    exitPlanModeCancel: async (promptId) => {
      // Stop first so the host never resolves the denial into a resumed planning turn.
      try {
        await window.electronAPI.invoke('ai:cancelRemoteSession', sessionId, workspacePath);
      } catch (error) {
        onError(error instanceof Error ? error.message : String(error));
        throw error;
      }
      await send({ promptType: 'exit_plan_mode', promptId, response: { approved: false } });
    },
    exitPlanModeStartNewSession: async () =>
      refuse('Starting the implementation in a new session is only available on the machine running this session.'),
    toolPermissionSubmit: (promptId, response) =>
      send({ promptType: 'tool_permission', promptId, response }),
    toolPermissionCancel: (promptId) =>
      send({ promptType: 'tool_permission', promptId, response: { decision: 'deny', scope: 'once' } }),
    gitCommit: async (promptId, files, message, hunkSelections) => {
      if (hunkSelections?.length) refuse('Partial file commits are only available on the machine running this session.');
      await send({ promptType: 'git_commit', promptId, response: { action: 'committed', files, message } });
      // The commit runs on the host; its result arrives with the synced transcript.
      return { success: true, pending: true };
    },
    gitCommitCancel: (promptId) =>
      send({ promptType: 'git_commit', promptId, response: { action: 'cancelled' } }),
    // The file lives on the host machine, not this one.
    openFile: async () => {},
    trackEvent: () => {},
  };
}
