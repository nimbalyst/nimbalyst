import { errorNotificationService } from '../../services/ErrorNotificationService';

/** A rejected control must leave the queued input and authoritative state intact. */
export async function requestTurnControl(sessionId: string, action: 'stop' | 'send-now'): Promise<boolean> {
  try {
    const result = await window.electronAPI.invoke(action === 'stop' ? 'ai:cancelRequest' : 'ai:interruptCurrentTurn', sessionId);
    if (result?.success === true) return true;
    errorNotificationService.showError(
      action === 'stop' ? 'Unable to stop this turn' : 'Unable to send now',
      result?.error || 'Cancellation was not confirmed. Your queued message is retained.',
    );
  } catch (error) {
    errorNotificationService.showError(
      action === 'stop' ? 'Unable to stop this turn' : 'Unable to send now',
      error instanceof Error ? error.message : String(error),
    );
  }
  return false;
}
