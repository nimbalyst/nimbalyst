/**
 * Public command identity for inserting an inline table of contents. Owned by
 * `TocExtension`.
 */

import { createCommand, type LexicalCommand } from 'lexical';

export const INSERT_TOC_COMMAND: LexicalCommand<void> = createCommand('INSERT_TOC_COMMAND');
