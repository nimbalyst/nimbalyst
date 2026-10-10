/**
 * Markdown syntax for decision and open-question marks on a sentence.
 *
 *   [Storage lives in [Flagship](nimbalyst://X).]{decided by="Greg Hinkle" email=greg@example.com on=2026-09-30 over="our own engine"}
 *   [Pricing and latency are unknown.]{open by="Spike 6"}
 *
 * The bracketed span is ordinary inline markdown (links, emphasis, code and
 * citations nest inside it). The brace block opens with the kind keyword and
 * carries optional `by`, `email`, `on` and `over` attributes. `email` is the
 * person's stable identity (marks are searched by it); `by` is the display
 * name. An open question owned by a page or a spike has no email. A value is
 * either a bare token without spaces or a double-quoted string with `\"` and
 * `\\` escapes.
 * Newlines never appear in a value: the markdown importer is line based, so a
 * newline would split the paragraph.
 *
 * Pure: no Lexical, React or DOM. Used by the editor transformer, the headless
 * body pipeline, the main-process marks index and the agent tools.
 */

import { stripCitations } from './citationSyntax';
import { codeSpanEnd, forEachProseLine } from './markdownProseLines';

export type PageMarkKind = 'decided' | 'open';

export const PAGE_MARK_KINDS: readonly PageMarkKind[] = ['decided', 'open'];

export interface PageMarkAttrs {
  kind: PageMarkKind;
  /** Who decided, or who owns the open question (free text). */
  by?: string;
  /** Email of the person in `by`; absent when the owner is not a person. */
  email?: string;
  /** ISO date `YYYY-MM-DD` (free text is kept as written). */
  on?: string;
  /** What was not chosen. Meaningful for `decided`; kept for `open` if written. */
  over?: string;
}

/** One mark found in a markdown body. */
export interface PageMarkOccurrence extends PageMarkAttrs {
  /** Inline markdown of the marked sentence, exactly as written. */
  text: string;
  /** The sentence with markdown links, emphasis and citations reduced to text. */
  plainText: string;
  /** The `{...}` block exactly as written. */
  rawAttrs: string;
  /** Offsets of the whole mark in the scanned markdown. */
  start: number;
  end: number;
  /** 1-based line of the mark's opening bracket. */
  line: number;
}

/** A mark located inside one line of inline text. */
export interface InlinePageMarkMatch {
  start: number;
  end: number;
  /** Offsets of the sentence between the brackets. */
  innerStart: number;
  innerEnd: number;
  /** The `{...}` block exactly as written. */
  rawAttrs: string;
  attrs: PageMarkAttrs;
}

const ATTR_ORDER = ['by', 'email', 'on', 'over'] as const;
type AttrName = (typeof ATTR_ORDER)[number];

export function isPageMarkKind(value: unknown): value is PageMarkKind {
  return value === 'decided' || value === 'open';
}

function isAttrName(value: string): value is AttrName {
  return (ATTR_ORDER as readonly string[]).includes(value);
}

/** Collapses newlines so a value can never split the paragraph it lives in. */
function cleanValue(value: string): string {
  return value.replace(/\s*[\r\n]+\s*/g, ' ');
}

function formatValue(value: string): string {
  const clean = cleanValue(value);
  return `"${clean.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function normalizedAttrs(attrs: PageMarkAttrs): PageMarkAttrs {
  const out: PageMarkAttrs = { kind: attrs.kind };
  for (const name of ATTR_ORDER) {
    const value = attrs[name];
    if (typeof value === 'string') {
      const clean = cleanValue(value).trim();
      if (clean) out[name] = clean;
    }
  }
  return out;
}

function bareOrQuoted(value: string): string {
  return /^[^\s"\\{}]+$/.test(value) ? value : formatValue(value);
}

/** Canonical `{kind by="..." email=... on=... over="..."}` block for the attributes. */
export function formatPageMarkAttrs(attrs: PageMarkAttrs): string {
  const clean = normalizedAttrs(attrs);
  const parts: string[] = [clean.kind];
  if (clean.by) parts.push(`by=${formatValue(clean.by)}`);
  if (clean.email) parts.push(`email=${bareOrQuoted(clean.email)}`);
  if (clean.on) parts.push(`on=${bareOrQuoted(clean.on)}`);
  if (clean.over) parts.push(`over=${formatValue(clean.over)}`);
  return `{${parts.join(' ')}}`;
}

export function pageMarkAttrsEqual(a: PageMarkAttrs, b: PageMarkAttrs): boolean {
  const left = normalizedAttrs(a);
  const right = normalizedAttrs(b);
  return left.kind === right.kind && ATTR_ORDER.every((name) => left[name] === right[name]);
}

/**
 * The block to write for `attrs`. When the attributes are unchanged from what
 * was parsed out of `rawAttrs`, the original text is returned so a hand- or
 * agent-written mark (other attribute order, bare values, unknown attributes)
 * round-trips byte for byte.
 */
export function serializePageMarkAttrs(attrs: PageMarkAttrs, rawAttrs?: string | null): string {
  if (rawAttrs) {
    const parsed = parsePageMarkAttrs(rawAttrs);
    if (parsed && pageMarkAttrsEqual(parsed.attrs, attrs)) return rawAttrs;
  }
  return formatPageMarkAttrs(attrs);
}

/** Full mark markdown for an inline sentence and its attributes. */
export function formatPageMarkMarkdown(innerMarkdown: string, attrs: PageMarkAttrs, rawAttrs?: string | null): string {
  return `[${innerMarkdown}]${serializePageMarkAttrs(attrs, rawAttrs)}`;
}

/**
 * Reads a `{...}` block that starts at `from` in `text`. Returns null when the
 * text there is not a mark attribute block.
 */
function readAttrBlock(text: string, from: number): { attrs: PageMarkAttrs; end: number } | null {
  if (text[from] !== '{') return null;
  let i = from + 1;
  const kindMatch = /^(decided|open)(?=[\s}])/.exec(text.slice(i, i + 8));
  if (!kindMatch) return null;
  const attrs: PageMarkAttrs = { kind: kindMatch[1] as PageMarkKind };
  i += kindMatch[1].length;
  while (i < text.length) {
    while (text[i] === ' ' || text[i] === '\t') i++;
    if (text[i] === '}') return { attrs, end: i + 1 };
    const nameMatch = /^([A-Za-z][\w-]*)=/.exec(text.slice(i, i + 40));
    if (!nameMatch) return null;
    const name = nameMatch[1];
    i += nameMatch[0].length;
    let value = '';
    if (text[i] === '"') {
      i++;
      let closed = false;
      while (i < text.length) {
        const ch = text[i];
        if (ch === '\n' || ch === '\r') return null;
        if (ch === '\\' && i + 1 < text.length && text[i + 1] !== '\n') {
          value += text[i + 1];
          i += 2;
          continue;
        }
        if (ch === '"') {
          closed = true;
          i++;
          break;
        }
        value += ch;
        i++;
      }
      if (!closed) return null;
    } else {
      const bare = /^[^\s"}]+/.exec(text.slice(i));
      if (!bare) return null;
      value = bare[0];
      i += value.length;
    }
    if (text[i] !== ' ' && text[i] !== '\t' && text[i] !== '}') return null;
    if (isAttrName(name)) attrs[name] = value;
  }
  return null;
}

/** Parses a `{decided by="..." ...}` block (braces included). */
export function parsePageMarkAttrs(raw: string): { attrs: PageMarkAttrs } | null {
  const block = readAttrBlock(raw, 0);
  if (!block || block.end !== raw.length) return null;
  return { attrs: block.attrs };
}

/**
 * Offset of the `]` matching the `[` at `open`, skipping escapes and code
 * spans, without crossing a line break. -1 when unbalanced.
 */
function matchingBracket(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\n') return -1;
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '`') {
      const end = codeSpanEnd(text, i);
      if (end !== -1) {
        i = end - 1;
        continue;
      }
      while (text[i + 1] === '`') i++;
      continue;
    }
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * The first mark at or after `from` in a run of inline text. Brackets inside
 * code spans or escaped with a backslash never open a mark. Image syntax
 * (`![...]`) is not a mark.
 */
export function findInlinePageMark(text: string, from = 0): InlinePageMarkMatch | null {
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '`') {
      const end = codeSpanEnd(text, i);
      if (end !== -1) {
        i = end - 1;
        continue;
      }
      while (text[i + 1] === '`') i++;
      continue;
    }
    if (ch !== '[' || text[i - 1] === '!') continue;
    const close = matchingBracket(text, i);
    if (close === -1) continue;
    const block = readAttrBlock(text, close + 1);
    if (!block) continue;
    return {
      start: i,
      end: block.end,
      innerStart: i + 1,
      innerEnd: close,
      rawAttrs: text.slice(close + 1, block.end),
      attrs: block.attrs,
    };
  }
  return null;
}

/**
 * Inline markdown reduced to readable text: links and citations become their
 * label (citations are dropped), emphasis and code markers are removed.
 */
export function inlineMarkdownToPlainText(markdown: string): string {
  return stripCitations(markdown)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__|~~|==)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])[*_](?=\S)(.+?)(?<=\S)[*_](?![\w*])/g, '$1$2')
    .replace(/\\([!-/:-@[-`{-~])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Every mark in a markdown body, in document order. Fenced code blocks, inline
 * code and frontmatter are skipped. Marks are matched one line at a time, the
 * same way the editor imports them.
 */
export function findPageMarks(markdown: string): PageMarkOccurrence[] {
  const out: PageMarkOccurrence[] = [];
  forEachProseLine(markdown, (line, lineStart, index) => {
    let from = 0;
    for (;;) {
      const match = findInlinePageMark(line, from);
      if (!match) break;
      const text = line.slice(match.innerStart, match.innerEnd);
      out.push({
        ...match.attrs,
        text,
        plainText: inlineMarkdownToPlainText(text),
        rawAttrs: match.rawAttrs,
        start: lineStart + match.start,
        end: lineStart + match.end,
        line: index + 1,
      });
      from = match.end;
    }
  });
  return out;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `2026-09-30` as `Sep 30` (or `Sep 30, 2025` outside `currentYear`). Other text is returned as is. */
export function formatPageMarkDate(on: string, currentYear?: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(on);
  if (!match) return on;
  const month = MONTHS[Number(match[2]) - 1];
  if (!month) return on;
  const day = String(Number(match[3]));
  const year = Number(match[1]);
  return currentYear !== undefined && year !== currentYear ? `${month} ${day}, ${year}` : `${month} ${day}`;
}

/** The faint line after a mark: `Greg, Sep 30, over our own engine`. Empty when there is nothing to say. */
export function describePageMark(attrs: PageMarkAttrs, currentYear?: number): string {
  const parts: string[] = [];
  if (attrs.by) parts.push(attrs.by);
  if (attrs.on) parts.push(formatPageMarkDate(attrs.on, currentYear));
  if (attrs.over && attrs.kind === 'decided') parts.push(`over ${attrs.over}`);
  return parts.join(', ');
}
