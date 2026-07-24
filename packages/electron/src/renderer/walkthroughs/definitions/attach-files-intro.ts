/**
 * Attach Files Introduction Walkthrough
 *
 * Introduces users to file and image attachment features.
 * Shows when users are in agent mode and the input is visible.
 */

import type { WalkthroughDefinition } from '../types';
import { getHelpContent } from '../../help';
import { isTargetValid } from '../WalkthroughService';

const attachFilesHelp = getHelpContent('attach-files-input')!;

export const attachFilesIntro: WalkthroughDefinition = {
  id: 'attach-files-intro',
  name: 'Attach Files',
  version: 1,
  trigger: {
    // Show when in agent mode
    screen: 'agent',
    // Only show when AIInput is visible
    condition: () => {
      const input = document.querySelector('.ai-chat-input');
      return input !== null && isTargetValid(input as HTMLElement);
    },
    // Wait for UI to settle
    delay: 3000,
    // After AI sessions button, before model picker
    priority: 18,
  },
  steps: [
    {
      id: 'attach-files',
      target: {
        selector: '.ai-chat-input',
      },
      title: attachFilesHelp.title,
      body: attachFilesHelp.body,
      placement: 'top',
    },
  ],
};
