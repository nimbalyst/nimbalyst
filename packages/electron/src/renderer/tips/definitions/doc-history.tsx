/**
 * Tip: Document History (Cmd+Y)
 *
 * Most users don't realize every save is a snapshot they can diff and
 * restore -- this surfaces the safety net.
 */

import React from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';
import { FEATURE_USAGE_KEYS } from '../../../shared/featureUsage';
import type { TipDefinition } from '../types';

const HistoryIcon = <MaterialSymbol icon="history" size={16} />;

export const docHistoryTip: TipDefinition = {
  id: 'tip-doc-history',
  name: 'Document History',
  version: 1,
  trigger: {
    screen: '*',
    condition: (context) =>
      context.hasReachedCount(FEATURE_USAGE_KEYS.FILE_CREATED, 30),
    delay: 2000,
    priority: 3,
  },
  content: {
    icon: HistoryIcon,
    title: 'Cmd+Y to scrub document history',
    body: 'Every save snapshots the file. **Cmd+Y** opens the history dialog with diffs against any earlier version -- click to restore. Hidden safety net for big edits.',
  },
};
