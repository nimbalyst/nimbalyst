import React from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';
import { FEATURE_USAGE_KEYS } from '../../../shared/featureUsage';
import { KeyboardShortcuts } from '../../../shared/KeyboardShortcuts';
import { dialogRef } from '../../contexts/DialogContext';
import { DIALOG_IDS } from '../../dialogs/registry';
import type { TipDefinition } from '../types';

const KeyboardIcon = <MaterialSymbol icon="keyboard_command_key" size={16} />;

export const keyboardShortcutsTip: TipDefinition = {
  id: 'tip-keyboard-shortcuts',
  name: 'Keyboard Shortcuts Suggestion',
  version: 2,
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
    body: `Press **${KeyboardShortcuts.file.sessionLaunchPopup}** anywhere in Nimbalyst to open the session launcher. The shortcuts dialog is a fast way to find the other shortcuts you will actually use.`,
    action: {
      label: 'Open Shortcuts',
      onClick: () => {
        dialogRef.current?.open(DIALOG_IDS.KEYBOARD_SHORTCUTS, {});
      },
      variant: 'primary',
    },
  },
};
