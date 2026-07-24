/**
 * Git Commit Mode Introduction Walkthrough
 *
 * Introduces users to the Manual and Smart commit modes in the Git Operations panel.
 * Only shows when the commit mode toggle is visible (meaning there are uncommitted changes).
 */

import type { WalkthroughDefinition } from '../types';
import { getHelpContent } from '../../help';
import { isTargetValid } from '../WalkthroughService';

const gitCommitModeHelp = getHelpContent('git-commit-mode-toggle')!;

export const gitCommitModeIntro: WalkthroughDefinition = {
  id: 'git-commit-mode-intro',
  name: 'Git Commit Modes',
  version: 1,
  trigger: {
    // Show when in agent mode (where Git Operations panel lives)
    screen: 'agent',
    // Only show when commit mode toggle is visible (has uncommitted changes)
    condition: () => {
      const toggle = document.querySelector('[data-testid="git-commit-mode-toggle"]');
      return toggle !== null && isTargetValid(toggle as HTMLElement);
    },
    // Wait for Git panel to fully render
    delay: 2000,
    // Medium priority - after basic onboarding but contextually important
    priority: 15,
  },
  steps: [
    {
      id: 'commit-mode-toggle',
      target: {
        testId: 'git-commit-mode-toggle',
      },
      title: gitCommitModeHelp.title,
      body: gitCommitModeHelp.body,
      placement: 'left',
    },
  ],
};
