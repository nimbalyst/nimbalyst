/**
 * Markdown syntax for inline citations.
 *
 * A human citation points at a captured session input (a prompt, an answered
 * question or a comment) and snapshots who said it, when and the quote, so a
 * teammate without the session can still read it. It comes from the
 * citable-inputs tool, never typed by hand:
 *
 *   [GH](https://console.nimbalyst.com/app/cite/<session>/<prompt|answer|comment>/<key> "by='Greg Hinkle' email=greg@example.com at=2026-09-30T14:02Z quote='Let%27s not kid ourselves'")
 *
 * A source citation is an ordinary link whose title is `cite`, so an agent can
 * write one freely and any other viewer still shows a working link:
 *
 *   [TanStack Table docs](https://tanstack.com/table "cite")
 *   [Spec](collab://doc/abc123 "cite")
 *
 * Human citation URLs are console links (`@nimbalyst/collab-protocol`
 * `consoleLinks`), built and read here only through `buildHumanCitationHref` /
 * `parseHumanCitationHref`. Pages written before console links used
 * `nimbalyst://cite/...`; those still read, and an unchanged one is written
 * back as it was. Title tokens are `name=value`, space separated; a value is bare
 * when it is a plain token and otherwise single-quoted with the characters that
 * markdown or the line-based importer would read (quotes, brackets,
 * parentheses, newlines, emphasis markers, table pipes, `%`) percent-encoded.
 *
 * Pure: no Lexical, React or DOM.
 */

import { buildConsoleLink, parseConsoleLink, type ConsoleCitationAgent } from '@nimbalyst/collab-protocol';

import { forEachProseLine, maskInlineCode } from './markdownProseLines';

/** The citation URL used before console links; read, never written. */
const LEGACY_HUMAN_CITATION_BASE = 'nimbalyst://cite/';

/** The title token that makes an ordinary link a source citation. */
const SOURCE_CITATION_TITLE = 'cite';

export type CitationInputKind = 'prompt' | 'answer' | 'comment';

export const CITATION_INPUT_KINDS: readonly CitationInputKind[] = ['prompt', 'answer', 'comment'];

export interface HumanCitationRef {
  /** Absent for a Nimbalyst session; `claude-code` when `sessionId` is a terminal Claude Code session. */
  agent?: ConsoleCitationAgent;
  sessionId: string;
  inputKind: CitationInputKind;
  /** Stable key of the input inside the session (tool call id, prompt sync id, comment id). */
  key: string;
}

export interface HumanCitation extends HumanCitationRef {
  kind: 'human';
  /** Chip text, normally the person's initials. */
  label: string;
  /** Display name of the person. */
  by?: string;
  /** The person's email: the stable identity marks and citations are searched by. */
  email?: string;
  /** ISO timestamp or date of the input. */
  at?: string;
  /** Short context, e.g. `answering round 3, TD-8`. */
  context?: string;
  /** Title of the session the input came from. */
  sessionTitle?: string;
  /** The words, snapshotted when the citation was written. */
  quote?: string;
}

export interface SourceCitation {
  kind: 'source';
  /** A web URL or a document reference (`collab://...`, a workspace path). */
  target: string;
  /** Link text: the source's title. */
  label: string;
}

export type Citation = HumanCitation | SourceCitation;

export interface CitationOccurrence {
  citation: Citation;
  /** The title as written, or null. Pass back to `formatCitationMarkdown` to keep it byte-exact. */
  rawTitle: string | null;
  /** The link destination as written. Pass back to `formatCitationMarkdown` to keep it byte-exact. */
  rawHref: string;
  start: number;
  end: number;
  /** 1-based line. */
  line: number;
}

/** A citation located in one run of inline text. */
export interface InlineCitationMatch {
  citation: Citation;
  rawTitle: string | null;
  rawHref: string;
  start: number;
  end: number;
}

const TITLE_FIELDS = [
  ['by', 'by'],
  ['email', 'email'],
  ['at', 'at'],
  ['context', 'ctx'],
  ['sessionTitle', 'in'],
  ['quote', 'quote'],
] as const;

type TitleField = (typeof TITLE_FIELDS)[number][0];

/** Characters percent-encoded inside a quoted title value. */
const QUOTED_ENCODE = /[%'"\\\r\n[\]()`*_~|<>]/g;
const BARE_VALUE = /^[\w.:+@,/-]+$/;
/** Characters a link destination cannot hold; encoded on write, decoded on read. */
const TARGET_ENCODE = /[\s()"<>]/g;
const TARGET_DECODE = /%(20|28|29|22|3C|3E|09|0A|0D)/gi;

/** Any inline link: label, destination, optional double-quoted title. Not exported: citations are recognized by `findInlineCitation`. */
const INLINE_LINK = /(?<!!)\[([^[\]\n]*)\]\(([^\s()"]+)(?:\s+"([^"\n]*)")?\)/g;

export function isCitationInputKind(value: unknown): value is CitationInputKind {
  return value === 'prompt' || value === 'answer' || value === 'comment';
}

function percent(ch: string): string {
  return `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`;
}

function encodeQuoted(value: string): string {
  return value.replace(QUOTED_ENCODE, percent);
}

function decodeValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function formatTitleValue(value: string): string {
  return BARE_VALUE.test(value) ? value : `'${encodeQuoted(value)}'`;
}

/** Link text must not contain brackets or a line break. */
function cleanLabel(label: string): string {
  return label.replace(/[[\]\r\n]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** `Greg Hinkle` -> `GH`, `greg` -> `G`. */
export function citationInitials(name: string | undefined): string {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const letters = words.length === 1 ? words[0].slice(0, 1) : words[0].slice(0, 1) + words[words.length - 1].slice(0, 1);
  return letters.toUpperCase();
}

/** The URL of a human citation: a console link. The only place one is built. */
export function buildHumanCitationHref(ref: HumanCitationRef): string {
  return buildConsoleLink({
    kind: 'citation',
    ...(ref.agent ? { agent: ref.agent } : {}),
    sessionId: ref.sessionId,
    inputKind: ref.inputKind,
    key: ref.key,
  });
}

/**
 * The input a human citation URL points at, or null when `href` is not one: a
 * console citation link or the legacy `nimbalyst://cite/` form. The only place
 * one is read.
 */
export function parseHumanCitationHref(href: string): HumanCitationRef | null {
  const target = parseConsoleLink(href);
  if (target?.kind === 'citation') {
    return { ...(target.agent ? { agent: target.agent } : {}), sessionId: target.sessionId, inputKind: target.inputKind, key: target.key };
  }
  if (!href.startsWith(LEGACY_HUMAN_CITATION_BASE)) return null;
  const segments = href.slice(LEGACY_HUMAN_CITATION_BASE.length).split('/');
  if (segments.length !== 3) return null;
  const [sessionId, inputKind, key] = segments.map(decodeValue);
  if (!sessionId || !key || !isCitationInputKind(inputKind)) return null;
  return { sessionId, inputKind, key };
}

function encodeTarget(target: string): string {
  return target.replace(TARGET_ENCODE, percent);
}

function decodeTarget(destination: string): string {
  return destination.replace(TARGET_DECODE, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

function isSourceTitle(title: string | null | undefined): boolean {
  return title?.trim().split(/\s+/)[0] === SOURCE_CITATION_TITLE;
}

/** The link destination for a citation. */
export function buildCitationHref(citation: Citation): string {
  return citation.kind === 'source' ? encodeTarget(citation.target) : buildHumanCitationHref(citation);
}

/** Canonical title: `cite` for a source, the snapshot tokens (or null) for a human citation. */
export function formatCitationTitle(citation: Citation): string | null {
  if (citation.kind === 'source') return SOURCE_CITATION_TITLE;
  const tokens: string[] = [];
  for (const [field, name] of TITLE_FIELDS) {
    const value = citation[field];
    if (typeof value === 'string' && value !== '') tokens.push(`${name}=${formatTitleValue(value)}`);
  }
  return tokens.length > 0 ? tokens.join(' ') : null;
}

/** Reads `name=value` tokens from a citation title. Unknown names are ignored. */
export function parseCitationTitle(title: string): Partial<Record<TitleField, string>> {
  const out: Partial<Record<TitleField, string>> = {};
  const tokenPattern = /([A-Za-z][\w-]*)=(?:'([^']*)'|(\S+))/g;
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(title)) !== null) {
    const field = TITLE_FIELDS.find(([, name]) => name === match![1])?.[0];
    if (!field) continue;
    out[field] = decodeValue(match[2] ?? match[3] ?? '');
  }
  return out;
}

/** The citation a link stands for, or null when the link is not a citation. */
export function parseCitationLink(label: string, href: string, title?: string | null): Citation | null {
  const ref = parseHumanCitationHref(href);
  if (ref) return { kind: 'human', ...ref, label, ...(title ? parseCitationTitle(title) : {}) };
  if (isSourceTitle(title)) {
    const target = decodeTarget(href);
    return target ? { kind: 'source', target, label } : null;
  }
  return null;
}

export function citationsEqual(a: Citation, b: Citation): boolean {
  if (a.kind !== b.kind || a.label !== b.label) return false;
  if (a.kind === 'source' || b.kind === 'source') {
    return a.kind === 'source' && b.kind === 'source' && a.target === b.target;
  }
  return sameHumanTarget(a, b) && TITLE_FIELDS.every(([field]) => (a[field] ?? '') === (b[field] ?? ''));
}

function sameHumanTarget(a: HumanCitationRef, b: HumanCitationRef): boolean {
  return a.agent === b.agent && a.sessionId === b.sessionId && a.inputKind === b.inputKind && a.key === b.key;
}

function sameTarget(a: Citation, b: Citation): boolean {
  if (a.kind === 'source' || b.kind === 'source') {
    return a.kind === 'source' && b.kind === 'source' && a.target === b.target;
  }
  return sameHumanTarget(a, b);
}

/**
 * Markdown for a citation. When `rawHref` / `rawTitle` (as they were read)
 * still describe the same citation, they are written back unchanged so the
 * body round-trips byte for byte, including a legacy `nimbalyst://cite/` link.
 */
export function formatCitationMarkdown(citation: Citation, rawTitle?: string | null, rawHref?: string | null): string {
  const label = cleanLabel(citation.label) || (citation.kind === 'human' ? citationInitials(citation.by) : 'source');
  const normalized = { ...citation, label } as Citation;
  let href = buildCitationHref(normalized);
  if (rawHref && rawHref !== href) {
    const reread = parseCitationLink(label, rawHref, formatCitationTitle(normalized));
    if (reread && sameTarget(reread, normalized)) href = rawHref;
  }
  let title = formatCitationTitle(normalized);
  if (rawTitle != null) {
    const reparsed = parseCitationLink(label, href, rawTitle);
    if (reparsed && citationsEqual(reparsed, normalized)) title = rawTitle;
  }
  return `[${label}](${href}${title ? ` "${title}"` : ''})`;
}

/** A human citation with its chip label derived from `by` when none is given. */
export function createHumanCitation(input: Omit<HumanCitation, 'kind' | 'label'> & { label?: string }): HumanCitation {
  return { ...input, kind: 'human', label: input.label ?? citationInitials(input.by) };
}

/** The first citation at or after `from` in a run of inline text. Ordinary links are skipped. */
export function findInlineCitation(text: string, from = 0): InlineCitationMatch | null {
  const pattern = new RegExp(INLINE_LINK.source, 'g');
  pattern.lastIndex = from;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const citation = parseCitationLink(match[1], match[2], match[3]);
    if (citation) {
      return { citation, rawTitle: match[3] ?? null, rawHref: match[2], start: match.index, end: match.index + match[0].length };
    }
  }
  return null;
}

/** `markdown` with every citation link removed. */
export function stripCitations(markdown: string): string {
  let out = '';
  let from = 0;
  for (let match = findInlineCitation(markdown); match; match = findInlineCitation(markdown, from)) {
    out += markdown.slice(from, match.start);
    from = match.end;
  }
  return out + markdown.slice(from);
}

/** Every citation in a markdown body, in order, skipping frontmatter, fenced code and inline code. */
export function findCitations(markdown: string): CitationOccurrence[] {
  const out: CitationOccurrence[] = [];
  forEachProseLine(markdown, (line, lineStart, index) => {
    const masked = maskInlineCode(line);
    for (let match = findInlineCitation(masked); match; match = findInlineCitation(masked, match.end)) {
      out.push({
        citation: match.citation,
        rawTitle: match.rawTitle,
        rawHref: match.rawHref,
        start: lineStart + match.start,
        end: lineStart + match.end,
        line: index + 1,
      });
    }
  });
  return out;
}

export function isWebSource(target: string): boolean {
  return /^https?:\/\//i.test(target);
}

export interface CitationSummary {
  /** Human citations per person, in first-cited order. */
  people: Array<{ by: string; count: number }>;
  documents: number;
  links: number;
}

export function summarizeCitations(citations: readonly Citation[]): CitationSummary {
  // One person per email, so a renamed display name still counts once; a
  // citation without an email (older pages) joins the person with that name.
  const people: Array<{ by: string; email: string | null; count: number }> = [];
  let documents = 0;
  let links = 0;
  for (const citation of citations) {
    if (citation.kind === 'human') {
      const by = citation.by?.trim() || citation.label;
      const email = citation.email?.trim().toLowerCase() || null;
      const entry = people.find((person) => (email && person.email === email)
        || (person.by === by && (!email || !person.email)));
      if (entry) {
        entry.count += 1;
        entry.email ??= email;
      } else {
        people.push({ by, email, count: 1 });
      }
    } else if (isWebSource(citation.target)) {
      links += 1;
    } else {
      documents += 1;
    }
  }
  return { people: people.map(({ by, count }) => ({ by, count })), documents, links };
}

/** The parts of the Sources line after the label: `3 from Greg Hinkle`, `1 document`, `2 links`. */
export function formatCitationSummaryParts(summary: CitationSummary): string[] {
  const parts = summary.people.map(({ by, count }) => `${count} from ${by}`);
  if (summary.documents > 0) parts.push(`${summary.documents} ${summary.documents === 1 ? 'document' : 'documents'}`);
  if (summary.links > 0) parts.push(`${summary.links} ${summary.links === 1 ? 'link' : 'links'}`);
  return parts;
}
