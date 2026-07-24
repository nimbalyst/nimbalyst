import type { WalkthroughState } from '../walkthroughs/types';
import { shouldShowTip } from './TipService';
import type { TipDefinition, TipScreen, TipTriggerContext } from './types';

export function tipTargetsScreen(
  tip: TipDefinition,
  screen: TipScreen,
  includeWildcard = true,
): boolean {
  const target = tip.trigger.screen;
  if (target === '*') return includeWildcard;
  if (Array.isArray(target)) {
    return target.includes(screen) || (includeWildcard && target.includes('*'));
  }
  return target === screen;
}

export function getEligibleFilesEmptyTips(
  definitions: readonly TipDefinition[],
  state: WalkthroughState,
  context: TipTriggerContext,
): TipDefinition[] {
  return definitions
    .filter((tip) => tipTargetsScreen(tip, 'files-empty', false))
    .filter((tip) => shouldShowTip(state, tip))
    .filter((tip) => tip.trigger.condition(context))
    .sort((a, b) => (b.trigger.priority ?? 0) - (a.trigger.priority ?? 0));
}

export function getNextTip(
  orderedTips: readonly TipDefinition[],
  currentTipId: string | null,
): TipDefinition | null {
  if (orderedTips.length === 0) return null;
  if (!currentTipId) return orderedTips[0];

  const currentIndex = orderedTips.findIndex((tip) => tip.id === currentTipId);
  if (currentIndex < 0) return orderedTips[0];
  return orderedTips[(currentIndex + 1) % orderedTips.length];
}
