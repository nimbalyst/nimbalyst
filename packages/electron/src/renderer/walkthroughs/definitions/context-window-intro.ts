/**
 * Context Window Introduction Walkthrough
 *
 * Helps users understand the context window indicator and what it means.
 * Shows when the context indicator is visible (in files or agent mode with AI active).
 */

import type { WalkthroughDefinition } from '../types';
import { getHelpContent } from '../../help';
import { isTargetValid } from '../WalkthroughService';

const contextHelp = getHelpContent('context-indicator')!;

export const contextWindowIntro: WalkthroughDefinition = {
  id: 'context-window-intro',
  name: 'Context Window',
  version: 1,
  trigger: {
    // Show in any mode - the context indicator appears in both
    screen: '*',
    // Only show when the context indicator is visible AND has context window data (from /context)
    condition: () => {
      // Find ALL context indicators and check if ANY is visible with context data
      const indicators = document.querySelectorAll('[data-testid="context-indicator"]');
      for (const indicator of indicators) {
        if (isTargetValid(indicator as HTMLElement)) {
          // Check if the indicator shows context window data (contains %)
          // This means /context has successfully run, not just token counting
          const usageText = indicator.querySelector('.usage-text');
          if (usageText && usageText.textContent?.includes('%')) {
            return true;
          }
        }
      }
      return false;
    },
    // Wait for UI to settle and some activity
    delay: 2000,
    // Slightly lower priority than model picker
    priority: 25,
  },
  steps: [
    {
      id: 'context-indicator',
      target: {
        testId: 'context-indicator',
      },
      title: contextHelp.title,
      body: contextHelp.body,
      placement: 'bottom',
    },
  ],
};
