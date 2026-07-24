import React from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';
import { store } from '@nimbalyst/runtime/store';
import { FEATURE_USAGE_KEYS } from '../../../shared/featureUsage';
import { setWindowModeAtom } from '../../store/atoms/windowMode';
import type { TipDefinition } from '../types';

const TrackerIcon = <MaterialSymbol icon="assignment" size={16} />;

export const trackerModeTip: TipDefinition = {
  id: 'tip-tracker-mode',
  name: 'Tracker Mode Suggestion',
  version: 1,
  trigger: {
    screen: '*',
    condition: (context) =>
      context.currentMode !== 'tracker' &&
      context.hasReachedCount(FEATURE_USAGE_KEYS.SESSION_CREATED, 5) &&
      !context.hasBeenUsed(FEATURE_USAGE_KEYS.TRACKER_USED),
    delay: 2500,
    priority: 8,
  },
  content: {
    icon: TrackerIcon,
    title: 'Track work alongside your sessions',
    body: 'You have been using AI sessions heavily, but **Tracker Mode** gives you a durable place to manage bugs, tasks, and decisions across those sessions.',
    action: {
      label: 'Open Tracker',
      onClick: () => {
        store.set(setWindowModeAtom, 'tracker');
      },
      variant: 'primary',
    },
  },
};
