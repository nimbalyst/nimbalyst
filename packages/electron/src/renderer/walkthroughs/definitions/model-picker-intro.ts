/**
 * Model Picker Introduction Walkthrough
 *
 * Introduces users to the model selection feature in Agent Mode.
 * Shows when users first use Agent Mode.
 */

import type { WalkthroughDefinition } from '../types';
import { getHelpContent } from '../../help';
import { isTargetValid } from '../WalkthroughService';

const modelPickerHelp = getHelpContent('model-picker')!;

export const modelPickerIntro: WalkthroughDefinition = {
  id: 'model-picker-intro',
  name: 'Model Selection',
  version: 1,
  trigger: {
    // Show when in agent mode
    screen: 'agent',
    // Only show when model picker is visible
    condition: () => {
      const picker = document.querySelector('[data-testid="model-picker"]');
      return picker !== null && isTargetValid(picker as HTMLElement);
    },
    // Wait for UI to settle
    delay: 1500,
    // Medium priority
    priority: 20,
  },
  steps: [
    {
      id: 'model-picker',
      target: {
        testId: 'model-picker',
      },
      title: modelPickerHelp.title,
      body: modelPickerHelp.body,
      placement: 'bottom',
    },
  ],
};
