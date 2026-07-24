/**
 * Tip: MockupLM Discovery
 *
 * Suggests the .mockup.html visual editor to AI users who have not yet
 * opened one. The mockup format is invisible until someone names a file
 * with the right extension.
 */

import React from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';
import { FEATURE_USAGE_KEYS } from '../../../shared/featureUsage';
import type { TipDefinition } from '../types';

const MockupIcon = <MaterialSymbol icon="design_services" size={16} />;

export const mockupDiscoverTip: TipDefinition = {
  id: 'tip-mockup-discover',
  name: 'MockupLM Discovery',
  version: 1,
  trigger: {
    screen: '*',
    condition: (context) =>
      context.hasReachedCount(FEATURE_USAGE_KEYS.SESSION_COMPLETED_WITH_TOOLS, 5) &&
      !context.hasBeenUsed(FEATURE_USAGE_KEYS.MOCKUP_OPENED),
    delay: 2000,
    priority: 4,
  },
  content: {
    icon: MockupIcon,
    title: 'Plan UI in a .mockup.html file',
    body: 'Files ending in **.mockup.html** render as live, annotatable wireframes alongside source. Ask the agent to "create a mockup for X" to get a starting point you can edit visually.',
  },
};
