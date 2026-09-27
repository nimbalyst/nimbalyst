import type { SettingValue } from '../../../shared/settings/keys';

export type BusySendBehavior = SettingValue<'ai.busySendBehavior'>;

/**
 * What Enter does while a turn is running. Steering carries text only, so a
 * draft with attachments, or a provider without mid-turn input, interrupts.
 */
export function resolveBusySendAction(
  behavior: BusySendBehavior,
  { midTurnInput, hasAttachments }: { midTurnInput: boolean; hasAttachments: boolean },
): BusySendBehavior {
  if (behavior === 'steer' && (!midTurnInput || hasAttachments)) {
    return 'interrupt';
  }
  return behavior;
}

export const BUSY_SEND_PLACEHOLDERS: Record<BusySendBehavior, string> = {
  queue: 'Agent is working... (Enter to queue for after this turn)',
  interrupt: 'Agent is working... (Enter to interrupt and send)',
  steer: 'Agent is working... (Enter to send into the running turn)',
};
