/**
 * Tip: Action Prompts Dropdown
 *
 * Surfaces the action-prompts feature (ai-actions.md) to users with lots
 * of prompts under their belt -- power-user reuse pattern they probably
 * have not found.
 */

import React from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';
import { FEATURE_USAGE_KEYS } from '../../../shared/featureUsage';
import type { TipDefinition } from '../types';

const PlaylistIcon = <MaterialSymbol icon="playlist_play" size={16} />;

export const actionPromptsTip: TipDefinition = {
  id: 'tip-action-prompts',
  name: 'Action Prompts',
  version: 1,
  trigger: {
    screen: '*',
    condition: (context) =>
      context.hasReachedCount(FEATURE_USAGE_KEYS.AI_PROMPT_SUBMITTED, 50),
    delay: 2000,
    priority: 3,
  },
  content: {
    icon: PlaylistIcon,
    title: 'Save reusable prompts as actions',
    body: 'Create **nimbalyst-local/ai-actions.md** to define one-click prompts. They show up in the composer\'s Actions dropdown -- great for recurring workflows like "review this diff" or "write release notes".',
  },
};
