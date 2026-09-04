/**
 * The redaction pass. Finds shaped secrets and replaces them in place, keeping
 * the surrounding page.
 *
 * The "redact, don't reject" choice is load-bearing now that a memory's payload
 * is a page of prose rather than a sentence: throwing away a whole page because
 * one line held a token discards the context that made the page worth storing.
 * Blocking is a separate decision, in `blocklist.ts`, for the cases where
 * redaction is not a remedy.
 */
import { DEFAULT_DETECTORS, type Detector } from './detectors.js';
import type { RedactionFinding, RedactionResult } from './types.js';

/** The token substituted for a redacted span. */
export function redactionPlaceholder(kind: string): string {
  return `[redacted:${kind}]`;
}

/** Matches any placeholder this module writes, for residue accounting. */
export const REDACTION_PLACEHOLDER_PATTERN = /\[redacted:[a-z-]+\]/g;

interface Span {
  start: number;
  end: number;
  detector: Detector;
  secret: string;
}

/** Regexes carry `lastIndex`; clone per scan so the table stays reusable. */
function scannerFor(pattern: RegExp): RegExp {
  const flags = pattern.flags.includes('d') ? pattern.flags : `${pattern.flags}d`;
  return new RegExp(pattern.source, flags);
}

function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

/**
 * A hint that says *which* secret without reproducing any of it. Short values
 * get no prefix at all — three characters of an eight-character password is a
 * real leak, three characters of a 51-character key is the literal `sk-`.
 */
function previewOf(secret: string): string {
  if (secret.length <= 12) return `…(${secret.length} chars)`;
  return `${secret.slice(0, 3)}…(${secret.length} chars)`;
}

function collectSpans(text: string, detectors: readonly Detector[]): Span[] {
  const spans: Span[] = [];
  for (const detector of detectors) {
    const re = scannerFor(detector.pattern);
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      // A zero-length match would spin forever; step past it.
      if (match[0].length === 0) {
        re.lastIndex += 1;
        continue;
      }
      const group = detector.group ?? 0;
      const indices = match.indices?.[group];
      const secret = match[group];
      if (secret === undefined || !indices) continue;
      if (detector.validate && !detector.validate(secret, match)) continue;
      spans.push({ start: indices[0], end: indices[1], detector, secret });
    }
  }
  return spans;
}

/**
 * Overlapping claims are resolved by priority then by width, so an
 * `Authorization: Bearer eyJ…` reports as a JWT rather than a generic bearer
 * token, and a key inside a PEM block is not double-reported.
 */
function resolveOverlaps(spans: Span[]): Span[] {
  const ordered = [...spans].sort(
    (a, b) =>
      b.detector.priority - a.detector.priority ||
      b.end - b.start - (a.end - a.start) ||
      a.start - b.start
  );
  const kept: Span[] = [];
  for (const span of ordered) {
    if (kept.some((k) => span.start < k.end && k.start < span.end)) continue;
    kept.push(span);
  }
  return kept.sort((a, b) => a.start - b.start);
}

export interface RedactOptions {
  /** Override the detector table (tests, or a scope-specific policy). */
  detectors?: readonly Detector[];
}

/**
 * Scan `text` and replace every detected secret with a placeholder.
 *
 * Offsets in the returned findings are in the coordinates of the *input*, not
 * the output, so a review UI can highlight what was removed from the original.
 */
export function redactSecrets(text: string, options: RedactOptions = {}): RedactionResult {
  const detectors = options.detectors ?? DEFAULT_DETECTORS;
  const spans = resolveOverlaps(collectSpans(text, detectors));
  if (spans.length === 0) return { text, findings: [], redacted: false };

  const findings: RedactionFinding[] = [];
  const out: string[] = [];
  let cursor = 0;
  for (const span of spans) {
    out.push(text.slice(cursor, span.start));
    out.push(redactionPlaceholder(span.detector.kind));
    cursor = span.end;
    findings.push({
      kind: span.detector.kind,
      label: span.detector.label,
      start: span.start,
      end: span.end,
      line: lineOf(text, span.start),
      preview: previewOf(span.secret),
    });
  }
  out.push(text.slice(cursor));

  return { text: out.join(''), findings, redacted: true };
}

/** Convenience predicate for callers that only need the yes/no. */
export function containsSecret(text: string, options: RedactOptions = {}): boolean {
  return redactSecrets(text, options).redacted;
}
