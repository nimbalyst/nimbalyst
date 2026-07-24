/**
 * Register the AI chat integration plugin as a renderer-contributed
 * Lexical UI plugin. The component uses `useDocumentPath` so it must run
 * inside the editor's React tree.
 */

import {
  AIChatIntegrationPlugin,
  registerExtensionEditorComponent,
} from '@nimbalyst/runtime';
import type { ComponentType } from 'react';

export function registerAIChatPlugin(): void {
  registerExtensionEditorComponent({
    name: 'ai-chat-integration',
    Component: AIChatIntegrationPlugin as ComponentType<unknown>,
  });
}
