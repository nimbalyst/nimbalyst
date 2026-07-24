/**
 * Session Kanban Board Introduction Walkthrough
 *
 * Introduces users to the kanban board view for organizing AI sessions by phase.
 * Shows when in agent mode and the kanban button is visible.
 */

import type { WalkthroughDefinition } from '../types';
import { getHelpContent } from '../../help';
import { isTargetValid } from '../WalkthroughService';

const kanbanHelp = getHelpContent('session-kanban-button')!;

export const sessionKanbanIntro: WalkthroughDefinition = {
  id: 'session-kanban-intro',
  name: 'Session Kanban Board',
  version: 1,
  trigger: {
    screen: 'agent',
    condition: () => {
      const button = document.querySelector('[data-testid="session-kanban-button"]');
      return button !== null && isTargetValid(button as HTMLElement);
    },
    delay: 2000,
    priority: 18,
  },
  steps: [
    {
      id: 'kanban-button',
      target: {
        testId: 'session-kanban-button',
      },
      title: kanbanHelp.title,
      body: kanbanHelp.body,
      shortcut: kanbanHelp.shortcut,
      placement: 'bottom',
    },
  ],
};
