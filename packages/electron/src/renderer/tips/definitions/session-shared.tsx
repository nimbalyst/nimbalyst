/**
 * Tip: Shared Session Links
 *
 * Suggests sharing a session via an end-to-end-encrypted link instead of
 * screenshots. Users with meaningful sessions are the right audience.
 */

import React from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';
import { store } from '@nimbalyst/runtime/store';
import { FEATURE_USAGE_KEYS } from '../../../shared/featureUsage';
import { openSettingsCommandAtom } from '../../store/atoms/settingsNavigation';
import type { TipDefinition } from '../types';

const ShareIcon = <MaterialSymbol icon="share" size={16} />;

export const sessionSharedTip: TipDefinition = {
  id: 'tip-session-shared',
  name: 'Shared Session Links',
  version: 1,
  trigger: {
    screen: '*',
    condition: (context) =>
      context.hasReachedCount(FEATURE_USAGE_KEYS.SESSION_COMPLETED_WITH_TOOLS, 5),
    delay: 2000,
    priority: 3,
  },
  content: {
    icon: ShareIcon,
    title: 'Share a session, not a screenshot',
    body: 'Sessions can be published as **end-to-end-encrypted links** with 1, 7, or 30 day expiry. Use the share button on a session to send the full transcript to a teammate.',
    action: {
      label: 'Manage Shared Links',
      onClick: () => {
        store.set(openSettingsCommandAtom, { category: 'shared-links', timestamp: Date.now() });
      },
      variant: 'primary',
    },
  },
};
