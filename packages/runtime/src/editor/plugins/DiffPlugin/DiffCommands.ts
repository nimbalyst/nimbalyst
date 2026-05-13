/**
 * Public command identity for applying markdown replacements. Owned by
 * `DiffExtension`; re-exported from this plugin's `index.tsx` for
 * backwards compatibility with callers.
 */

import { createCommand, type LexicalCommand } from 'lexical';

import type { TextReplacementInput } from './core/exports';

type ApplyMarkdownReplacePayload =
  | TextReplacementInput[]
  | { replacements: TextReplacementInput[]; requestId?: string };

export const APPLY_MARKDOWN_REPLACE_COMMAND: LexicalCommand<ApplyMarkdownReplacePayload> =
  createCommand<ApplyMarkdownReplacePayload>('APPLY_MARKDOWN_REPLACE_COMMAND');
