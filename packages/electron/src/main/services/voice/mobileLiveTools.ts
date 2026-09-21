import { handleMobileVoiceEvent } from './mobileVoiceEvents';
import { handleMobileVoicePrompt } from './mobileVoicePromptAnswers';
import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import Store from '../../utils/privateSettingsStore';
import { isSessionInWorkspace } from './voiceIpcAuthorization';
import { handleMobileVoiceToolCall } from './mobileVoiceToolHandler';
import { MobileLiveActions, type MobileLiveRequest, type MobileLiveResult } from './mobileLiveRelay';

// Account/host is part of each key. Only opaque action identities are retained.
let reservations: Store<Record<string, string[]>> | undefined;
function actionStore(): Store<Record<string, string[]>> {
  return reservations ??= new Store<Record<string, string[]>>({ name: 'mobile-live-actions' });
}
const actions = new MobileLiveActions(
  key => actionStore().get('reserved', []).includes(key),
  key => {
    const ids = actionStore().get('reserved', []);
    if (ids.length >= 50000) throw new Error('Voice action history is full; use the session UI.');
    actionStore().set('reserved', [...ids, key]);
  },
);

export async function handleMobileLiveTool(request: MobileLiveRequest): Promise<MobileLiveResult> {
  const { scope, tool } = request;
  if (scope.sessionId) {
    const session = await AISessionsRepository.get(scope.sessionId);
    if (!isSessionInWorkspace(session, scope.projectId) || session?.metadata?.hostDeviceId !== scope.hostDeviceId) {
      return { success: false, error: 'The session is not owned by this computer in this workspace.' };
    }
  }
  if (['voice_events', 'voice_event_claim', 'voice_event_presented'].includes(tool)) return handleMobileVoiceEvent(request);
  if (tool === 'capabilities') return { success: true, result: JSON.stringify({ version: 1, targetedTools: true, voiceApprovals: true, promptAnswersVersion: 1 }) };
  if (['voice_prompt_prepare', 'voice_prompt_presented', 'voice_prompt_answer', 'voice_prompt_status'].includes(tool)) return handleMobileVoicePrompt(request);
  // Ungated legacy answers are never an alternative to the versioned prompt contract.
  if (tool === 'answer_prompt') return { success: false, error: 'Use the question or approval card in the app.' };
  const run = () => handleMobileVoiceToolCall(tool, request.arguments, scope.projectId, scope.sessionId ?? undefined);
  if (['list_sessions', 'get_session_summary', 'search_project_knowledge', 'recall'].includes(tool)) return run();
  return actions.run(request, run);
}
