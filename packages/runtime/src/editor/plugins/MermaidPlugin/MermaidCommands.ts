/**
 * Commands exposed by the Mermaid extension. Lives in its own module so
 * `MermaidExtension` (under `editor/extensions/builtin/`) and the legacy
 * `editor/plugins/MermaidPlugin/index.ts` re-export can both reference the
 * same `LexicalCommand` identity without depending on each other.
 */

import { createCommand, type LexicalCommand } from 'lexical';

import type { MermaidPayload } from './MermaidNode';

export const INSERT_MERMAID_COMMAND: LexicalCommand<MermaidPayload> =
  createCommand('INSERT_MERMAID_COMMAND');
