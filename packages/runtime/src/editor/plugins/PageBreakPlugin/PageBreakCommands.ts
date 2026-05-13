/**
 * Public command identity for page-break insertion. Owned by
 * `PageBreakExtension` and re-exported from the plugin's `index.tsx`
 * for backwards compatibility with callers.
 */

import { createCommand, type LexicalCommand } from 'lexical';

export const INSERT_PAGE_BREAK: LexicalCommand<undefined> = createCommand(
  'INSERT_PAGE_BREAK',
);
