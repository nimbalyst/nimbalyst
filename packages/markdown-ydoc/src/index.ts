/**
 * `@nimbalyst/markdown-ydoc` -- markdown <-> Lexical Y.Doc conversion for
 * hosts with no editor: the collab worker, the CLI, headless nodes.
 *
 * The conversion lives in the runtime (`runtime/src/sync/markdownYDoc.ts`),
 * beside the node classes and transformers the desktop editor uses, so there
 * is one definition of each. This package bundles it into a single ESM file
 * with no React, DOM or CSS, and carries its own copies of lexical and yjs:
 * consumers exchange Yjs updates (bytes) with it, never Y.Doc instances.
 */
import type * as Api from '../types/index';
import {
  applyMarkdownReplacementsToLexicalYUpdate,
  lexicalYDocToMarkdown,
  markdownToLexicalYUpdate,
} from '../../runtime/src/sync/markdownYDoc';
// Decision and open-question marks: the same scanner the editor and the
// desktop marks list use, so the worker's marks index cannot drift from them.
import { findPageMarks } from '../../runtime/src/core/pageMarkSyntax';

// The published types are hand-written; fail the typecheck if they drift.
const _typesMatch: {
  applyMarkdownReplacementsToLexicalYUpdate: typeof Api.applyMarkdownReplacementsToLexicalYUpdate;
  markdownToLexicalYUpdate: typeof Api.markdownToLexicalYUpdate;
  lexicalYDocToMarkdown: typeof Api.lexicalYDocToMarkdown;
  findPageMarks: typeof Api.findPageMarks;
} = { applyMarkdownReplacementsToLexicalYUpdate, markdownToLexicalYUpdate, lexicalYDocToMarkdown, findPageMarks };
void _typesMatch;

export { applyMarkdownReplacementsToLexicalYUpdate, findPageMarks, lexicalYDocToMarkdown, markdownToLexicalYUpdate };
export type { MarkdownTextReplacement, MarkdownToLexicalYUpdateOptions, PageMarkKind, PageMarkOccurrence } from '../types/index';
