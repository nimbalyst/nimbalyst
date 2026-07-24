/**
 * Public command identity for collapsible insertion. Owned by
 * `CollapsibleExtension`; re-exported from this plugin's `index.ts` for
 * backwards compatibility with callers that still import from the plugin
 * path.
 */

import { createCommand, type LexicalCommand } from 'lexical';

export const INSERT_COLLAPSIBLE_COMMAND: LexicalCommand<void> = createCommand(
  'INSERT_COLLAPSIBLE_COMMAND',
);
