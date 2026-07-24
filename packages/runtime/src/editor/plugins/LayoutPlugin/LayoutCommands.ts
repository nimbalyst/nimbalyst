/**
 * Public command identities for column-layout insertion and updates.
 * Owned by `LayoutExtension`; re-exported from `LayoutPlugin.tsx` for
 * backwards compatibility with callers that still import from the plugin
 * path.
 */

import { createCommand, type LexicalCommand, type NodeKey } from 'lexical';

export const INSERT_LAYOUT_COMMAND: LexicalCommand<string> =
  createCommand<string>('INSERT_LAYOUT_COMMAND');

export const UPDATE_LAYOUT_COMMAND: LexicalCommand<{
  template: string;
  nodeKey: NodeKey;
}> = createCommand<{ template: string; nodeKey: NodeKey }>(
  'UPDATE_LAYOUT_COMMAND',
);
