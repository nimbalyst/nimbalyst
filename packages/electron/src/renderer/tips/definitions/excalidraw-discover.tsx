/**
 * Tip: Excalidraw Discovery
 *
 * Surfaces the Excalidraw editor to active AI users who have not yet
 * opened one. Heavy tool-use sessions imply the user is building something
 * complex enough to benefit from a sketch.
 */

import React from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';
import { FEATURE_USAGE_KEYS } from '../../../shared/featureUsage';
import type { TipDefinition } from '../types';

const DrawIcon = <MaterialSymbol icon="gesture" size={16} />;

export const excalidrawDiscoverTip: TipDefinition = {
  id: 'tip-excalidraw-discover',
  name: 'Excalidraw Discovery',
  version: 1,
  trigger: {
    screen: '*',
    condition: (context) =>
      context.hasReachedCount(FEATURE_USAGE_KEYS.SESSION_COMPLETED_WITH_TOOLS, 5) &&
      !context.hasBeenUsed(FEATURE_USAGE_KEYS.EXCALIDRAW_OPENED),
    delay: 2000,
    priority: 4,
  },
  content: {
    icon: DrawIcon,
    title: 'Sketch architecture in Excalidraw',
    body: 'Create a **.excalidraw** file to draw boxes, arrows, and freeform diagrams. The agent can read and modify those drawings via tools -- great for system architecture and flow sketches.',
  },
};
