/**
 * Public surface of the embed plugin. The Lexical extension that registers
 * the node + transformer + node-transform lives at
 * `editor/extensions/builtin/EmbedExtension.ts`.
 */

export {
  EmbeddedFileNode,
  $createEmbeddedFileNode,
  $isEmbeddedFileNode,
} from './EmbeddedFileNode';
export type {
  EmbedAttrs,
  EmbeddedFilePayload,
  SerializedEmbeddedFileNode,
} from './EmbeddedFileNode';
export { EMBED_TRANSFORMER } from './EmbedTransformer';
export { parseEmbedAttrs, serializeEmbedAttrs } from './embedAttrs';
export {
  getEmbeddableExtensions,
  isEmbeddableUrl,
  registerEmbeddableExtension,
  unregisterEmbeddableExtension,
  setEmbeddableExtensions,
  subscribeToEmbeddableExtensionsChanges,
} from './embeddableExtensions';
export {
  getEmbedPluginCallbacks,
  setEmbedPluginCallbacks,
} from './EmbedPluginCallbacks';
export type {
  EmbedFrameProps,
  EmbedPluginCallbacks,
} from './EmbedPluginCallbacks';
