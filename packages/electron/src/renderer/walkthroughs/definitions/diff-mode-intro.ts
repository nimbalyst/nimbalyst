/**
 * Diff Mode Introduction Walkthrough
 *
 * Helps users understand how to review and approve/reject AI changes.
 * Shows when the diff approval bar appears.
 */

import type { WalkthroughDefinition } from '../types';
import { getHelpContent } from '../../help';
import { isTargetValid } from '../WalkthroughService';

const keepAllHelp = getHelpContent('diff-keep-all-button')!;
const revertAllHelp = getHelpContent('diff-revert-all-button')!;

export const diffModeIntro: WalkthroughDefinition = {
  id: 'diff-mode-intro',
  name: 'Reviewing AI Changes',
  version: 1,
  trigger: {
    // Show when viewing files (where diff mode appears)
    screen: 'files',
    // Only show when diff approval bar is actually visible
    condition: () => {
      const diffBar = document.querySelector('[data-testid="diff-keep-all-button"]');
      return diffBar !== null && isTargetValid(diffBar as HTMLElement);
    },
    // Wait for diff bar to render
    delay: 500,
    // Medium priority
    priority: 15,
  },
  steps: [
    {
      id: 'diff-keep-all',
      target: {
        testId: 'diff-keep-all-button',
      },
      title: keepAllHelp.title,
      body: keepAllHelp.body,
      placement: 'bottom',
    },
    {
      id: 'diff-revert-all',
      target: {
        testId: 'diff-revert-all-button',
      },
      title: revertAllHelp.title,
      body: revertAllHelp.body,
      placement: 'bottom',
    },
  ],
};
