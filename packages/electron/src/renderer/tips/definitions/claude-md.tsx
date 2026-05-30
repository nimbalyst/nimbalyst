/**
 * Tip: CLAUDE.md Standing Instructions
 *
 * Surfaces workspace-level rules to users running many sessions in the
 * same project. Each new session re-learns the workspace without one.
 */

import React from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';
import { FEATURE_USAGE_KEYS } from '../../../shared/featureUsage';
import type { TipDefinition } from '../types';

const RulesIcon = <MaterialSymbol icon="rule" size={16} />;

export const claudeMdTip: TipDefinition = {
  id: 'tip-claude-md',
  name: 'CLAUDE.md Workspace Rules',
  version: 1,
  trigger: {
    screen: '*',
    condition: (context) =>
      context.hasReachedCount(FEATURE_USAGE_KEYS.SESSION_CREATED, 15),
    delay: 2000,
    priority: 3,
  },
  content: {
    icon: RulesIcon,
    title: 'Set standing instructions in CLAUDE.md',
    body: 'Drop a **CLAUDE.md** at the workspace root with your coding conventions, preferred tools, and tone. Every session loads it automatically -- you only have to write it once.',
  },
};
