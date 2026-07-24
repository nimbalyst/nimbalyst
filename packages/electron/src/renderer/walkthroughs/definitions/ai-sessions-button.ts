/**
 * AI Sessions Button Walkthrough
 *
 * Introduces users to the AI Sessions button in the unified editor header.
 * This button lets users jump to past AI sessions that edited the current document.
 */

import type { WalkthroughDefinition } from '../types';
import { getHelpContent } from '../../help';
import { isTargetValid } from '../WalkthroughService';

const aiSessionsHelp = getHelpContent('ai-sessions-button')!;

export const aiSessionsButton: WalkthroughDefinition = {
  id: 'ai-sessions-button',
  name: 'AI Sessions Button',
  version: 1,
  trigger: {
    // Show when in files mode (editor is visible)
    screen: 'files',
    // Only show when the AI sessions button is visible AND not in diff mode
    condition: () => {
      const button = document.querySelector('[data-testid="ai-sessions-button"]');
      if (!button || !isTargetValid(button as HTMLElement)) return false;

      // Don't show if in diff mode (unified diff header or monaco diff approval bar visible)
      const unifiedDiffHeader = document.querySelector('.unified-diff-header');
      const monacoDiffBar = document.querySelector('.monaco-diff-approval-bar');
      if (unifiedDiffHeader || monacoDiffBar) return false;

      return true;
    },
    // Delay to let the editor fully load
    delay: 1500,
    // Higher priority than agent-mode-intro since this is more contextual
    priority: 20,
  },
  steps: [
    {
      id: 'ai-sessions-intro',
      target: {
        testId: 'ai-sessions-button',
      },
      title: aiSessionsHelp.title,
      body: aiSessionsHelp.body,
      shortcut: aiSessionsHelp.shortcut,
      placement: 'bottom',
    },
  ],
};
