import { createCommand, type LexicalCommand } from 'lexical';

import type { QuadrantPayload } from './QuadrantNodeCore';

export const INSERT_QUADRANT_COMMAND: LexicalCommand<QuadrantPayload | undefined> =
  createCommand('INSERT_QUADRANT_COMMAND');
