/**
 * Public command identity for callout insertion. Owned by `CalloutExtension`.
 */

import { createCommand, type LexicalCommand } from 'lexical';

import type { CalloutType } from './CalloutNode';

export const INSERT_CALLOUT_COMMAND: LexicalCommand<CalloutType | undefined> = createCommand(
  'INSERT_CALLOUT_COMMAND',
);
