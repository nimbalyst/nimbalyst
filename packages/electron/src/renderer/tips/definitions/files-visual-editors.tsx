import React from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';
import type { TipDefinition } from '../types';

const VisualEditorsIcon = <MaterialSymbol icon="lightbulb" size={20} />;

export const filesVisualEditorsTip: TipDefinition = {
  id: 'tip-files-visual-editors',
  name: 'Files Visual Editors',
  version: 1,
  trigger: {
    screen: 'files-empty',
    condition: () => true,
    priority: 10,
  },
  content: {
    icon: VisualEditorsIcon,
    title: 'Preview mockups and diagrams instantly',
    body: 'Files like **.mockup.html**, **.excalidraw**, and **.mindmap** open in visual editors. Ask the agent to create one and it renders live as it writes.',
    action: {
      label: 'Try it',
      insertPrompt: 'Create a visual mockup for ',
      variant: 'primary',
    },
  },
};
