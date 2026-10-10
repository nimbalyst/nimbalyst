/**
 * Public types for `@nimbalyst/markdown-ydoc`. Hand-written so the package's
 * surface is these functions, not the runtime graph behind them;
 * `src/index.ts` asserts the implementation matches.
 */

export interface MarkdownToLexicalYUpdateOptions {
  /**
   * The room's current state (`Y.encodeStateAsUpdate(doc)`). When given, the
   * markdown replaces the existing body in one transaction and the result is
   * the delta against this state. Deciding whether a non-empty body may be
   * replaced is the caller's job.
   */
  existingState?: Uint8Array;
}

/**
 * Convert markdown into a Yjs update for a Lexical collaborative document
 * (root `'main'`). Without `existingState` the update is the whole document;
 * with it, only what the replacement changed.
 */
export declare function markdownToLexicalYUpdate(
  markdown: string,
  opts?: MarkdownToLexicalYUpdateOptions,
): Uint8Array;

export interface MarkdownTextReplacement {
  /** Exact text in the body's markdown; never empty. */
  oldText: string;
  newText: string;
}

/**
 * Apply exact text replacements to a Lexical collaborative document, as the
 * desktop editor applies an agent's edit, and return only what changed, so a
 * concurrent edit elsewhere and comment anchors survive. Throws when any
 * `oldText` is empty or not in the body; nothing is applied then.
 */
export declare function applyMarkdownReplacementsToLexicalYUpdate(
  state: Uint8Array,
  replacements: readonly MarkdownTextReplacement[],
): Uint8Array;

/** Read a Lexical collaborative document's state back out as markdown. */
export declare function lexicalYDocToMarkdown(state: Uint8Array): string;

export type PageMarkKind = 'decided' | 'open';

/** One decision or open-question mark (`[sentence]{decided by=...}`) in a markdown body. */
export interface PageMarkOccurrence {
  kind: PageMarkKind;
  by?: string;
  email?: string;
  on?: string;
  over?: string;
  /** Inline markdown of the marked sentence, exactly as written. */
  text: string;
  /** The sentence with links, emphasis and citations reduced to text. */
  plainText: string;
  /** The `{...}` block exactly as written. */
  rawAttrs: string;
  start: number;
  end: number;
  /** 1-based line of the mark's opening bracket. */
  line: number;
}

/**
 * Every mark in a markdown body, in document order; fenced code, inline code
 * and frontmatter are skipped. The runtime's `pageMarkSyntax` scanner.
 */
export declare function findPageMarks(markdown: string): PageMarkOccurrence[];
