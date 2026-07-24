/**
 * Renderer-side registration for the embed plugin.
 *
 * Two responsibilities:
 *
 *   1. Inject the concrete `EmbedFrame` component into the runtime so
 *      `EmbeddedFileNode.decorate()` can render it. The runtime stays free
 *      of Electron-only concerns (file watcher IPC, customEditorRegistry).
 *
 *   2. Keep the runtime's set of embeddable file extensions in sync with
 *      whatever extensions have a custom editor registered. The auto-
 *      upgrade transform and the @ picker both read this set, so it must
 *      include every type any installed extension can render. Done as a
 *      live subscription against `customEditorRegistry.onChange`, not a
 *      hardcoded list.
 *
 * Phase 2 will narrow this to extensions that explicitly opt in via a
 * manifest field (e.g. `customEditors[].embeddable: true`) so heavy
 * editors can stay tab-only. Until then, every custom-editor file
 * extension is treated as embeddable.
 */

import {
  setEmbedPluginCallbacks,
  setEmbeddableExtensions,
} from '@nimbalyst/runtime';

import { customEditorRegistry } from '../CustomEditors/registry';
import { EmbedFrame } from './EmbedFrame';

export { EmbedFrame } from './EmbedFrame';
export { createEmbeddedFileHost } from './createEmbeddedFileHost';

function syncEmbeddableExtensions(): void {
  setEmbeddableExtensions(customEditorRegistry.getRegisteredExtensions());
}

export function registerEmbedFrame(): void {
  setEmbedPluginCallbacks({ renderEmbed: EmbedFrame });
  syncEmbeddableExtensions();
  customEditorRegistry.onChange(syncEmbeddableExtensions);
}
