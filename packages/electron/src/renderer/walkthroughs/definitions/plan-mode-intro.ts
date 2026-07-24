/**
 * Plan Mode Introduction Walkthrough
 *
 * Introduces users to the Plan vs Agent mode toggle.
 * Shows when users are in agent mode and the toggle is visible.
 */

import type { WalkthroughDefinition } from '../types';
import { getHelpContent } from '../../help';
import { isTargetValid } from '../WalkthroughService';

const planModeHelp = getHelpContent('plan-mode-toggle')!;

export const planModeIntro: WalkthroughDefinition = {
  id: 'plan-mode-intro',
  name: 'Plan Mode',
  version: 1,
  trigger: {
    // Show when in agent mode
    screen: 'agent',
    // Only show when ModeTag toggle is visible
    condition: () => {
      const modeTag = document.querySelector('[data-testid="plan-mode-toggle"]');
      return modeTag !== null && isTargetValid(modeTag as HTMLElement);
    },
    // Wait for UI to settle
    delay: 2000,
    // After model-picker, before context-window
    priority: 22,
  },
  steps: [
    {
      id: 'plan-mode-toggle',
      target: {
        testId: 'plan-mode-toggle',
      },
      title: planModeHelp.title,
      body: planModeHelp.body,
      placement: 'bottom',
    },
  ],
};
