import React from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';
import { FEATURE_USAGE_KEYS } from '../../../shared/featureUsage';
import { dialogRef } from '../../contexts/DialogContext';
import { DIALOG_IDS } from '../../dialogs/registry';
import type { TipDefinition } from '../types';

const KeyboardIcon = <MaterialSymbol icon="keyboard_command_key" size={16} />;

export const keyboardShortcutsTip: TipDefinition = {
  id: 'tip-keyboard-shortcuts',
  name: 'Keyboard Shortcuts Suggestion',
  version: 1,
  trigger: {
    screen: '*',
    condition: (context) =>
      context.hasReachedCount(FEATURE_USAGE_KEYS.APP_LAUNCH, 7) &&
      !context.hasBeenUsed(FEATURE_USAGE_KEYS.KEYBOARD_SHORTCUT_USED),
    delay: 2000,
    priority: 6,
  },
  content: {
    icon: KeyboardIcon,
    title: 'Learn the shortcuts that matter',
    body: 'You have used the app for a while, but have not triggered any tracked keyboard shortcuts yet. The shortcuts dialog is a fast way to find the ones you will actually use.',
    action: {
      label: 'Open Shortcuts',
      onClick: () => {
        dialogRef.current?.open(DIALOG_IDS.KEYBOARD_SHORTCUTS, {});
      },
      variant: 'primary',
    },
  },
};
