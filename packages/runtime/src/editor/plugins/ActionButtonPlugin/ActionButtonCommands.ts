import { createCommand, type LexicalCommand } from 'lexical';

import type { ActionButtonPayload } from './ActionButtonNodeCore';

export const INSERT_ACTION_BUTTON_COMMAND: LexicalCommand<ActionButtonPayload> =
  createCommand('INSERT_ACTION_BUTTON_COMMAND');
