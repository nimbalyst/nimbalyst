/**
 * The one page-mark command the eager editor needs: open the mark editor.
 * Everything that changes a mark lives in `pageMarkActions.ts`, loaded on use.
 */

import { createCommand, type LexicalCommand, type NodeKey } from 'lexical';

export const OPEN_PAGE_MARK_EDITOR_COMMAND: LexicalCommand<NodeKey> = createCommand('PAGE_MARK_OPEN_EDITOR');
