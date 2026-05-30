/**
 * Tip: Mobile Pairing
 *
 * Surfaces iOS pairing to heavy desktop users who could be driving
 * sessions from their phone instead.
 */

import React from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';
import { store } from '@nimbalyst/runtime/store';
import { FEATURE_USAGE_KEYS } from '../../../shared/featureUsage';
import { openSettingsCommandAtom } from '../../store/atoms/settingsNavigation';
import type { TipDefinition } from '../types';

const PhoneIcon = <MaterialSymbol icon="phone_iphone" size={16} />;

export const mobilePairedTip: TipDefinition = {
  id: 'tip-mobile-paired',
  name: 'Mobile Pairing',
  version: 1,
  trigger: {
    screen: '*',
    condition: (context) =>
      context.hasReachedCount(FEATURE_USAGE_KEYS.SESSION_CREATED, 30),
    delay: 2000,
    priority: 3,
  },
  content: {
    icon: PhoneIcon,
    title: 'Drive sessions from your phone',
    body: 'Pair the iOS app and prompt your Mac\'s agents from anywhere. The desktop runs the heavy work; you steer it from the couch or the road.',
    action: {
      label: 'Open Sync Settings',
      onClick: () => {
        store.set(openSettingsCommandAtom, { category: 'sync', timestamp: Date.now() });
      },
      variant: 'primary',
    },
  },
};
