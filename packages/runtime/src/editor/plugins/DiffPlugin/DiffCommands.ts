/**
 * Public command identity for applying markdown replacements. Owned by
 * `DiffExtension`; re-exported from this plugin's `index.tsx` for
 * backwards compatibility with callers.
 */

import { createCommand, type LexicalCommand } from 'lexical';

import type { TextReplacementInput } from './core/exports';

/**
 * Synchronous outcome of one APPLY_MARKDOWN_REPLACE_COMMAND. Lexical swallows a
 * throw from a command listener, so a caller that needs to tell "too large to
 * diff" apart from a real failure reads it here. `errorType` is the DiffError
 * type, e.g. `DIFF_TOO_LARGE`.
 */
export type ApplyMarkdownReplaceResult =
  | { ok: true }
  | { ok: false; errorType?: string; message: string };

export type ApplyMarkdownReplacePayload =
  | TextReplacementInput[]
  | {
      replacements: TextReplacementInput[];
      requestId?: string;
      onResult?: (result: ApplyMarkdownReplaceResult) => void;
      /** Land as final text with no pending diff. See `agentEditsApplyDirectly`. */
      acceptChanges?: boolean;
    };

export const APPLY_MARKDOWN_REPLACE_COMMAND: LexicalCommand<ApplyMarkdownReplacePayload> =
  createCommand<ApplyMarkdownReplacePayload>('APPLY_MARKDOWN_REPLACE_COMMAND');
