/**
 * Tip: Session Cleanup
 *
 * Surfaces the /session-cleanup workflow to users running many sessions --
 * once the Sessions board accumulates cards, the agent can re-phase finished
 * work, mark it complete, and flag old sessions to archive.
 */

import React from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';
import { FEATURE_USAGE_KEYS } from '../../../shared/featureUsage';
import type { TipDefinition } from '../types';

const CleanupIcon = <MaterialSymbol icon="cleaning_services" size={16} />;

export const sessionCleanupTip: TipDefinition = {
  id: 'tip-session-cleanup',
  name: 'Session Cleanup',
  version: 1,
  trigger: {
    screen: 'agent',
    condition: (context) =>
      context.hasReachedCount(FEATURE_USAGE_KEYS.SESSION_CREATED, 20),
    delay: 2000,
    priority: 4,
  },
  content: {
    icon: CleanupIcon,
    title: 'Let your agent tidy the Sessions board',
    body: 'Your Sessions board is filling up. Your agent can **clean it up** -- fixing each session\'s phase, marking finished work **complete**, and flagging old sessions to archive.',
    action: {
      label: 'Clean up my sessions',
      // Drops /session-cleanup into the composer (claude-code sessions only).
      insertPrompt: '/session-cleanup ',
      variant: 'primary',
    },
  },
};
