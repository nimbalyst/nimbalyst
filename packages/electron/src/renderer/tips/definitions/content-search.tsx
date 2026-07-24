/**
 * Tip: Content Search (Cmd+Shift+F)
 *
 * Surfaces cross-file regex search to users opening many files in a row.
 */

import React from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';
import { FEATURE_USAGE_KEYS } from '../../../shared/featureUsage';
import type { TipDefinition } from '../types';

const SearchIcon = <MaterialSymbol icon="manage_search" size={16} />;

export const contentSearchTip: TipDefinition = {
  id: 'tip-content-search',
  name: 'Content Search Shortcut',
  version: 1,
  trigger: {
    screen: '*',
    condition: (context) =>
      context.hasReachedCount(FEATURE_USAGE_KEYS.APP_LAUNCH, 7) &&
      !context.hasBeenUsed(FEATURE_USAGE_KEYS.KEYBOARD_SHORTCUT_USED),
    delay: 2000,
    priority: 3,
  },
  content: {
    icon: SearchIcon,
    title: 'Cmd+Shift+F searches inside files',
    body: 'Hit **Cmd+Shift+F** for cross-file regex search across the workspace. Results group by file with one-click jump-to-line.',
  },
};
