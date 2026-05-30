/**
 * Tip: Shared Document Links
 *
 * Surfaces the shared-document feature to active document creators who may
 * still be emailing markdown files around.
 */

import React from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';
import { store } from '@nimbalyst/runtime/store';
import { FEATURE_USAGE_KEYS } from '../../../shared/featureUsage';
import { openSettingsCommandAtom } from '../../store/atoms/settingsNavigation';
import type { TipDefinition } from '../types';

const LinkIcon = <MaterialSymbol icon="link" size={16} />;

export const documentSharedTip: TipDefinition = {
  id: 'tip-document-shared',
  name: 'Shared Document Links',
  version: 1,
  trigger: {
    screen: '*',
    condition: (context) =>
      context.hasReachedCount(FEATURE_USAGE_KEYS.FILE_CREATED, 20),
    delay: 2000,
    priority: 3,
  },
  content: {
    icon: LinkIcon,
    title: 'Share documents with one link',
    body: 'Right-click a file and pick **Share** to publish an end-to-end-encrypted link. Recipients open it in a browser -- no Nimbalyst account needed.',
    action: {
      label: 'Manage Shared Links',
      onClick: () => {
        store.set(openSettingsCommandAtom, { category: 'shared-links', timestamp: Date.now() });
      },
      variant: 'primary',
    },
  },
};
