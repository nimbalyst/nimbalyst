/**
 * File Tree Tools Walkthrough
 *
 * A multi-step walkthrough introducing users to the file tree filter menu
 * and quick open functionality.
 */

import type { WalkthroughDefinition } from '../types';
import { getHelpContent } from '../../help';

const filterHelp = getHelpContent('file-tree-filter-button')!;
const quickOpenHelp = getHelpContent('file-tree-quick-open-button')!;

export const fileTreeTools: WalkthroughDefinition = {
  id: 'file-tree-tools',
  name: 'File Tree Tools',
  version: 1,
  trigger: {
    // Show when in files mode
    screen: 'files',
    // Only show when the filter button is visible (file tree is open)
    condition: () => {
      const filterButton = document.querySelector('[data-testid="file-tree-filter-button"]');
      return filterButton !== null;
    },
    // Delay to let the workspace fully load
    delay: 2000,
    // Lower priority than contextual guides like AI sessions
    priority: 5,
  },
  steps: [
    {
      id: 'filter-menu',
      target: {
        testId: 'file-tree-filter-button',
      },
      title: filterHelp.title,
      body: filterHelp.body,
      shortcut: filterHelp.shortcut,
      placement: 'right',
    },
    {
      id: 'quick-open',
      target: {
        testId: 'file-tree-quick-open-button',
      },
      title: quickOpenHelp.title,
      body: quickOpenHelp.body,
      shortcut: quickOpenHelp.shortcut,
      placement: 'right',
    },
  ],
};
