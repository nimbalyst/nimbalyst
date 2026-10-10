import { createCommand, type LexicalCommand } from 'lexical';

import type { ChartPayload } from './ChartNodeCore';

export const INSERT_CHART_COMMAND: LexicalCommand<ChartPayload | undefined> =
  createCommand('INSERT_CHART_COMMAND');
