/**
 * Tip: Lightning Interrupt
 *
 * Surfaces the interrupt button to users who have completed enough
 * sessions that they have certainly watched at least one go sideways.
 */

import React from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';
import { FEATURE_USAGE_KEYS } from '../../../shared/featureUsage';
import type { TipDefinition } from '../types';

const BoltIcon = <MaterialSymbol icon="bolt" size={16} />;

export const lightningInterruptTip: TipDefinition = {
  id: 'tip-lightning-interrupt',
  name: 'Lightning Interrupt',
  version: 1,
  trigger: {
    screen: '*',
    condition: (context) =>
      context.hasReachedCount(FEATURE_USAGE_KEYS.SESSION_COMPLETED, 10),
    delay: 2000,
    priority: 3,
  },
  content: {
    icon: BoltIcon,
    title: 'Lightning button stops a runaway',
    body: 'If the agent is heading the wrong way, hit the **lightning bolt** next to the composer to interrupt it. Type a redirect into the composer and it resumes from there -- no need to wait the turn out.',
  },
};
