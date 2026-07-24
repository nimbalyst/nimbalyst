/**
 * Tip: Scheduled Wakeups
 *
 * Surfaces the schedule_wakeup MCP tool to heavy AI users who could be
 * letting the agent self-page instead of remembering to check back.
 */

import React from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';
import { FEATURE_USAGE_KEYS } from '../../../shared/featureUsage';
import type { TipDefinition } from '../types';

const ScheduleIcon = <MaterialSymbol icon="schedule" size={16} />;

export const wakeupTip: TipDefinition = {
  id: 'tip-wakeup',
  name: 'Scheduled Wakeups',
  version: 1,
  trigger: {
    screen: '*',
    condition: (context) =>
      context.hasReachedCount(FEATURE_USAGE_KEYS.AI_PROMPT_SUBMITTED, 30),
    delay: 2000,
    priority: 3,
  },
  content: {
    icon: ScheduleIcon,
    title: 'Let the agent page itself later',
    body: 'Ask the agent to **schedule a wakeup** ("check the build in 5 minutes", "poll the PR every 30s") and it self-resumes -- no need to babysit a long-running task.',
  },
};
