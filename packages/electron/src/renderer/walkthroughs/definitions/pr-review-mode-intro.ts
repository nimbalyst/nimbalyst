/**
 * PR Review Mode Introduction
 *
 * Introduces the Pull Requests mode by pointing at its navigation-gutter
 * button. Only eligible when the active project has a GitHub remote (the
 * button is rendered), mirroring the gutter's own visibility gating.
 */

import type { WalkthroughDefinition } from '../types';
import { getHelpContent } from '../../help';

const prReviewHelp = getHelpContent('pr-review-mode-button')!;

export const prReviewModeIntro: WalkthroughDefinition = {
  id: 'pr-review-mode-intro',
  name: 'Pull Requests Mode',
  version: 1,
  trigger: {
    screen: '*',
    delay: 600,
    priority: 8,
    condition: () =>
      document.querySelector('[data-testid="pr-review-mode-button"]') !== null,
  },
  steps: [
    {
      id: 'pr-review-mode',
      target: { testId: 'pr-review-mode-button' },
      title: prReviewHelp.title,
      body: prReviewHelp.body,
      shortcut: prReviewHelp.shortcut,
      placement: 'right',
    },
  ],
};
