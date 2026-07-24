/**
 * Tip: Auto-Commit Mode
 *
 * Surfaces auto-commit to users with deep AI-session history -- if they
 * manually commit each turn they'll appreciate the automation.
 */

import React from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';
import { store } from '@nimbalyst/runtime/store';
import { FEATURE_USAGE_KEYS } from '../../../shared/featureUsage';
import { openSettingsCommandAtom } from '../../store/atoms/settingsNavigation';
import type { TipDefinition } from '../types';

const CommitIcon = <MaterialSymbol icon="auto_mode" size={16} />;

export const autoCommitTip: TipDefinition = {
  id: 'tip-auto-commit',
  name: 'Auto-Commit Mode',
  version: 1,
  trigger: {
    screen: '*',
    condition: (context) =>
      context.hasReachedCount(FEATURE_USAGE_KEYS.SESSION_COMPLETED, 10),
    delay: 2000,
    priority: 3,
  },
  content: {
    icon: CommitIcon,
    title: 'Auto-commit after every AI turn',
    body: 'Enable auto-commit in the Claude Code panel and every turn ends with a checkpoint commit. Easy to revert, hard to lose work to a runaway agent.',
    action: {
      label: 'Open Claude Code Settings',
      onClick: () => {
        store.set(openSettingsCommandAtom, { category: 'claude-code', timestamp: Date.now() });
      },
      variant: 'primary',
    },
  },
};
