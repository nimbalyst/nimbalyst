/**
 * Agent Mode Welcome Introduction Walkthrough
 *
 * Welcomes new users when they first enter agent mode with no sessions.
 * Shows when session history is empty.
 */

import type { WalkthroughDefinition } from '../types';
import { getHelpContent } from '../../help';
import { isTargetValid } from '../WalkthroughService';

const agentWelcomeHelp = getHelpContent('agent-welcome')!;

export const agentWelcomeIntro: WalkthroughDefinition = {
  id: 'agent-welcome-intro',
  name: 'Agent Mode Welcome',
  version: 1,
  trigger: {
    // Show when in agent mode
    screen: 'agent',
    // Only show when there are no sessions (blank state)
    condition: () => {
      const emptyState = document.querySelector('.session-history-empty');
      const newButton = document.querySelector('[data-testid="new-dropdown-button"]');
      return emptyState !== null && newButton !== null && isTargetValid(newButton as HTMLElement);
    },
    // Show quickly for first-time users
    delay: 1000,
    // Highest priority when applicable
    priority: 50,
  },
  steps: [
    {
      id: 'welcome',
      target: {
        testId: 'new-dropdown-button',
      },
      title: agentWelcomeHelp.title,
      body: agentWelcomeHelp.body,
      placement: 'right',
    },
  ],
};
