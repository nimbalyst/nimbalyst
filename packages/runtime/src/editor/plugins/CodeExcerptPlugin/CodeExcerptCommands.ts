import { createCommand, type LexicalCommand } from 'lexical';

import type { CodeExcerptPayload } from './CodeExcerptNodeCore';

export const INSERT_CODE_EXCERPT_COMMAND: LexicalCommand<CodeExcerptPayload | undefined> =
  createCommand('INSERT_CODE_EXCERPT_COMMAND');
