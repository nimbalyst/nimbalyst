import React from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';
import { store } from '@nimbalyst/runtime/store';
import { FEATURE_USAGE_KEYS } from '../../../shared/featureUsage';
import { openSettingsCommandAtom } from '../../store/atoms/settingsNavigation';
import type { TipDefinition } from '../types';

const PaletteIcon = <MaterialSymbol icon="palette" size={16} />;

export const themeExploreTip: TipDefinition = {
  id: 'tip-theme-explore',
  name: 'Theme Exploration Suggestion',
  version: 1,
  trigger: {
    screen: '*',
    condition: (context) =>
      context.hasReachedCount(FEATURE_USAGE_KEYS.APP_LAUNCH, 5) &&
      !context.hasBeenUsed(FEATURE_USAGE_KEYS.THEME_CHANGED),
    delay: 2000,
    priority: 5,
  },
  content: {
    icon: PaletteIcon,
    title: 'Try a different theme',
    body: 'You have been back a few times without changing the look of the app. **Themes** are already built in, and the settings panel shows the full set at once.',
    action: {
      label: 'Open Themes',
      onClick: () => {
        store.set(openSettingsCommandAtom, {
          category: 'themes',
          timestamp: Date.now(),
        });
      },
      variant: 'primary',
    },
  },
};
