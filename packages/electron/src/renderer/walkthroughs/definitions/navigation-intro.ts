/**
 * Navigation Introduction Walkthroughs
 *
 * Two context-aware walkthroughs that introduce users to the OTHER mode:
 * - In Files mode: introduces Agent Mode
 * - In Agent mode: introduces Files Mode
 */

import type { WalkthroughDefinition } from '../types';

/**
 * Shown in Files mode to introduce Agent Mode.
 */
export const agentModeIntro: WalkthroughDefinition = {
  id: 'agent-mode-intro',
  name: 'Agent Mode Introduction',
  version: 1,
  trigger: {
    screen: 'files',
    delay: 500,
    priority: 5,
  },
  steps: [
    {
      id: 'agent-mode',
      target: {
        testId: 'agent-mode-button',
      },
      title: 'Agent Mode',
      body: 'A focused coding agent management interface. Manage many running AI agent sessions, track their execution, control their commits and organize them with a Kanban board. Pick your agent, give instructions, and the AI agent will write code, run commands, and make changes across your project.',
      placement: 'right',
      shortcut: 'Cmd+2',
    },
  ],
};

/**
 * Shown in Agent mode to introduce Files Mode.
 */
export const filesModeIntro: WalkthroughDefinition = {
  id: 'files-mode-intro',
  name: 'Files Mode Introduction',
  version: 1,
  trigger: {
    screen: 'agent',
    delay: 500,
    priority: 5,
  },
  steps: [
    {
      id: 'files-mode',
      target: {
        testId: 'files-mode-button',
      },
      title: 'Files Mode',
      body: 'Browse and edit your project files. Open markdown documents, code files, and more. The AI assistant sidebar is available here too.',
      placement: 'right',
      shortcut: 'Cmd+1',
    },
  ],
};
