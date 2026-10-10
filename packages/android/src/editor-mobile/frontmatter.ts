/**
 * Keeps a document's frontmatter out of the editor. Only the body goes
 * through Lexical; the frontmatter text (and the blank lines after it) is
 * written back exactly as it was loaded, so a phone edit never re-serializes
 * the YAML that the desktop, `nim` and git diff against.
 *
 * Same block rule as `@nimbalyst/local-wiki` `parseMarkdownFile`: a leading
 * `---` line, then a closing `---` or `...` line. Without a closing line the
 * whole text is body, as before.
 *
 * Copied from packages/ios/src/editor-mobile/frontmatter.ts (the bundles do not
 * import across packages); keep the two in step.
 */

const OPEN = /^﻿?---[ \t]*\r?\n/;
const CLOSE = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m;

export interface SplitDocument {
  /** Frontmatter block plus the blank lines after it; '' when there is none. */
  prefix: string;
  body: string;
}

export function splitFrontmatter(text: string): SplitDocument {
  const open = OPEN.exec(text);
  if (!open) return { prefix: '', body: text };
  const rest = text.slice(open[0].length);
  const close = CLOSE.exec(rest);
  if (!close) return { prefix: '', body: text };
  let end = open[0].length + close.index + close[0].length;
  const blank = /^(?:[ \t]*\r?\n)+/.exec(text.slice(end));
  if (blank) end += blank[0].length;
  return { prefix: text.slice(0, end), body: text.slice(end) };
}

/** The saved file: the frontmatter as loaded, then the edited body. */
export function joinFrontmatter(prefix: string, body: string): string {
  if (!prefix) return body;
  // The exported body may start with blank lines the prefix already carries.
  const trimmed = body.replace(/^(?:[ \t]*\r?\n)+/, '');
  // A file that ended on the closing `---` has no line break after it yet.
  if (trimmed !== '' && !prefix.endsWith('\n')) return prefix + (prefix.includes('\r\n') ? '\r\n' : '\n') + trimmed;
  return prefix + trimmed;
}
