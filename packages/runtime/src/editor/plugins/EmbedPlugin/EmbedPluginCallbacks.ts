/**
 * Module-level callback slots that let renderer-side code inject a real
 * `EmbedFrame` component without forcing the runtime package to depend on
 * Electron-only APIs (file watcher IPC, customEditorRegistry, etc.).
 *
 * Mirrors the `setImagePluginCallbacks` pattern used by `ImagesPlugin`.
 */

import type { ComponentType } from 'react';
import type { NodeKey } from 'lexical';

import type { EmbedAttrs } from './EmbeddedFileNode';

export interface EmbedFrameProps {
  /** Raw path written in the markdown link. May be relative or absolute. */
  src: string;
  /** The visible label from the markdown link. */
  label: string;
  /** Parsed attributes from the link title (height, width, caption, etc.). */
  attrs: EmbedAttrs;
  /** Lexical node key for the originating `EmbeddedFileNode`. */
  nodeKey: NodeKey;
}

export interface EmbedPluginCallbacks {
  /**
   * Renderer-side implementation that mounts the embedded extension editor
   * (header chrome, lazy editor mount, error boundary, file watcher). When
   * undefined, the node falls back to a chrome-only placeholder so the host
   * doc never crashes for missing embed support.
   */
  renderEmbed?: ComponentType<EmbedFrameProps>;
}

let callbacks: EmbedPluginCallbacks = {};

export function getEmbedPluginCallbacks(): EmbedPluginCallbacks {
  return callbacks;
}

export function setEmbedPluginCallbacks(next: EmbedPluginCallbacks): void {
  callbacks = next;
}
