/**
 * Tip: Session Launch Shortcut
 *
 * Surfaces the global session launcher to people who already use agent
 * sessions but have not started using keyboard shortcuts.
 */

import React from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';
import { FEATURE_USAGE_KEYS } from '../../../shared/featureUsage';
import type { TipDefinition } from '../types';

const SessionLaunchIcon = <MaterialSymbol icon="add_comment" size={16} />;

export const sessionLaunchShortcutTip: TipDefinition = {
  id: 'tip-session-launch-shortcut',
  name: 'Session Launch Shortcut',
  version: 1,
  trigger: {
    screen: 'agent',
    condition: (context) =>
      context.hasReachedCount(FEATURE_USAGE_KEYS.SESSION_CREATED, 3) &&
      !context.hasBeenUsed(FEATURE_USAGE_KEYS.KEYBOARD_SHORTCUT_USED),
    delay: 2000,
    priority: 6,
  },
  content: {
    icon: SessionLaunchIcon,
    title: 'Start sessions without losing your place',
    body: 'Press **Cmd+Shift+N** anywhere in Nimbalyst to open the session launcher. Submit your prompt and the session starts in the background, so you stay right where you are.',
  },
};
