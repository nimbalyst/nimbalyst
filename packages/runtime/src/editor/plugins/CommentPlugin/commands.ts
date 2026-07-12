import { createCommand, type LexicalCommand } from 'lexical';

export const OPEN_COMMENT_COMPOSER_COMMAND: LexicalCommand<void> = createCommand(
  'OPEN_COMMENT_COMPOSER_COMMAND',
);
