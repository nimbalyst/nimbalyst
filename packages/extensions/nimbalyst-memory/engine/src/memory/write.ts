/**
 * The memory write path: the one place a page becomes a record.
 *
 * Three gates run in a fixed order, and the order is the design:
 *
 * 1. **Redaction / blocklist.** First, because it is the only gate whose
 *    failure is unrecoverable. A page containing a credential that reaches the
 *    committed replica is permanent in git history; there is no later phase
 *    that can take it back. The plan makes this a *prerequisite* for team scope
 *    and the committed file rather than a follow-up, which only means anything
 *    if it runs before persistence rather than before export.
 *
 * 2. **Shape.** Is this a page or a sentence? The floor is above v1's 300-char
 *    candidate cap by construction, so the one-liner is not merely discouraged
 *    (see `MEMORY_PAGE_MIN_CHARS`).
 *
 * 3. **Dedup.** Last, because it is the only gate that needs to compare against
 *    stored pages, and because it must compare the text that will actually be
 *    stored — the redacted form. Screening after dedup would index one string
 *    and store another, and every later comparison would drift from the corpus.
 *
 * Note that `supersede` is a distinct outcome from `discard`. A page that
 * contains an existing one replaces it and the link is recorded; only a page
 * that *restates* an existing one is thrown away. Collapsing those two is what
 * makes a history view impossible to build later.
 *
 * Nothing here writes to a database. The gates and the record construction are
 * pure so they can be tested without a tracker, and the caller — the extension
 * backend, or phase 5's CLI — performs the actual persist.
 */
import { DedupIndex } from '../dedup/index.js';
import type { DedupMatch } from '../dedup/types.js';
import { screenMemoryText } from '../redaction/index.js';
import type { BlocklistMatch, RedactionFinding } from '../redaction/types.js';
import { sha256 } from '../hash.js';
import {
  DEFAULT_CONFIDENCE,
  MEMORY_PAGE_MIN_CHARS,
  MEMORY_PAGE_MIN_SENTENCES,
  MEMORY_PAGE_SOFT_LIMIT_BYTES,
  MEMORY_SCHEMA_VERSION,
  type MemoryProvenance,
  type MemoryRecord,
  type MemoryScope,
  type MemoryType,
} from './types.js';

export interface MemoryWriteInput {
  /** The page. Prose with its own context, not a sentence. */
  body: string;
  /** Heading for the page. Derived from the first line when omitted. */
  title?: string;
  type: MemoryType;
  scope?: MemoryScope;
  provenance: MemoryProvenance;
  /** 0–1. Defaults by provenance kind. */
  confidence?: number;
  /** When the claim started being true. Defaults to write time. */
  validFrom?: string;
  expiresAt?: string | null;
  /** Write instant, injectable so tests and migrations are deterministic. */
  now?: Date;
}

/** Why a page was refused on shape. */
export type MemoryShapeProblem = 'too-short' | 'single-sentence' | 'empty';

export interface MemoryWriteWarning {
  kind: 'oversize-page';
  message: string;
}

export type MemoryWriteOutcome =
  /** Redaction could not save the page. Nothing was stored. */
  | {
      status: 'blocked';
      blocks: BlocklistMatch[];
      redactions: RedactionFinding[];
    }
  /** Not a page. The caller should ask for context, not lower the bar. */
  | {
      status: 'rejected';
      problems: MemoryShapeProblem[];
      /** The screened text, so a caller can show what it was working with. */
      text: string;
      redactions: RedactionFinding[];
    }
  /** An existing page already says this. */
  | {
      status: 'discarded';
      duplicateOf: string;
      matches: DedupMatch[];
      redactions: RedactionFinding[];
    }
  /** Store it, and mark the listed ids superseded. */
  | {
      status: 'stored';
      record: MemoryRecord;
      /** Non-empty when this page retires existing ones. */
      supersedes: string[];
      matches: DedupMatch[];
      redactions: RedactionFinding[];
      warnings: MemoryWriteWarning[];
    }
  /** Overlaps an existing page ambiguously. Stored as a candidate; the pair
   * belongs in the review queue (phase 6). */
  | {
      status: 'review';
      record: MemoryRecord;
      matches: DedupMatch[];
      redactions: RedactionFinding[];
      warnings: MemoryWriteWarning[];
    };

export interface MemoryWriteOptions {
  /** Existing pages to dedup against. Omit to skip the dedup gate entirely
   * (a first write, or a caller that has no corpus loaded). */
  dedup?: DedupIndex;
  /** Lower the shape floor. Exposed so the bar is moved by a decision rather
   * than by an edit to the constant; the defaults are the plan's. */
  minChars?: number;
  minSentences?: number;
}

/** Sentence-ish units: terminator followed by whitespace or end of text. */
function countSentences(text: string): number {
  const matches = text.trim().match(/[^.!?\n]+(?:[.!?]+|\n|$)/g);
  return matches ? matches.filter((s) => s.trim().length > 0).length : 0;
}

/** First non-empty line, stripped of markdown heading syntax and list bullets. */
function deriveTitle(body: string): string {
  const line = body.split('\n').find((l) => l.trim().length > 0) ?? '';
  const cleaned = line
    .replace(/^#{1,6}\s+/, '')
    .replace(/^[-*+]\s+/, '')
    .trim();
  return cleaned.length > 120 ? `${cleaned.slice(0, 117).trimEnd()}...` : cleaned;
}

/**
 * Content-derived id. Hash-based rather than sequential so two branches that
 * mine the same page produce the same `factId` and reconcile merges them,
 * instead of producing two ids for one memory that no later pass can pair up.
 */
export function memoryFactId(type: MemoryType, scope: MemoryScope, body: string): string {
  return `mem_${sha256(`${type}\n${scope}\n${body}`).slice(0, 16)}`;
}

/**
 * Run the gates and, if they all pass, build the record. Pure: the caller
 * persists, and is responsible for adding the stored page to `options.dedup`.
 */
export function writeMemoryPage(
  input: MemoryWriteInput,
  options: MemoryWriteOptions = {}
): MemoryWriteOutcome {
  // Gate 1 — redaction. Before anything else touches this text.
  const screened = screenMemoryText(input.body ?? '');
  if (!screened.ok) {
    return { status: 'blocked', blocks: screened.blocks, redactions: screened.redactions };
  }
  const text = screened.text.trim();

  // Gate 2 — shape.
  const minChars = options.minChars ?? MEMORY_PAGE_MIN_CHARS;
  const minSentences = options.minSentences ?? MEMORY_PAGE_MIN_SENTENCES;
  const problems: MemoryShapeProblem[] = [];
  if (text.length === 0) problems.push('empty');
  else {
    if (text.length < minChars) problems.push('too-short');
    if (countSentences(text) < minSentences) problems.push('single-sentence');
  }
  if (problems.length > 0) {
    return { status: 'rejected', problems, text, redactions: screened.redactions };
  }

  // Gate 3 — dedup, against the text that will actually be stored.
  const decision = options.dedup?.classify(text);
  if (decision?.action === 'discard') {
    return {
      status: 'discarded',
      duplicateOf: decision.duplicateOf ?? decision.matches[0]?.id ?? '',
      matches: decision.matches,
      redactions: screened.redactions,
    };
  }

  const matches = decision?.matches ?? [];
  const supersedes = decision?.action === 'supersede' ? decision.supersedes : [];
  const needsReview = decision?.action === 'review';

  const now = input.now ?? new Date();
  const iso = now.toISOString();
  const scope = input.scope ?? 'personal';
  const record: MemoryRecord = {
    factId: memoryFactId(input.type, scope, text),
    schemaVersion: MEMORY_SCHEMA_VERSION,
    title: input.title?.trim() || deriveTitle(text),
    body: text,
    type: input.type,
    scope,
    status: needsReview ? 'candidate' : 'active',
    confidence: input.confidence ?? DEFAULT_CONFIDENCE[input.provenance.kind],
    provenance: input.provenance,
    validFrom: input.validFrom ?? iso,
    validTo: null,
    supersedes,
    // A review pair is recorded on the incoming page so the conflicts view can
    // find it from either side without a second index.
    duplicates: needsReview ? matches.map((m) => m.id) : [],
    expiresAt: input.expiresAt ?? null,
    createdAt: iso,
    updatedAt: iso,
    deletedAt: null,
    redacted: screened.redactions.length > 0,
    recallCount: 0,
    lastRecalledAt: null,
  };

  const warnings: MemoryWriteWarning[] = [];
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MEMORY_PAGE_SOFT_LIMIT_BYTES) {
    warnings.push({
      kind: 'oversize-page',
      message:
        `page is ${bytes} bytes, past the ${MEMORY_PAGE_SOFT_LIMIT_BYTES}-byte soft limit; ` +
        'the tail will not be covered by the page-level vector',
    });
  }

  if (needsReview) {
    return { status: 'review', record, matches, redactions: screened.redactions, warnings };
  }
  return { status: 'stored', record, supersedes, matches, redactions: screened.redactions, warnings };
}

/**
 * Apply a supersede outcome to the record it retires. `validTo` is set once,
 * to the superseding page's `validFrom` — the instant the new claim started
 * being true, NOT the instant we noticed. That distinction is the whole point
 * of carrying two timelines: a history view that reports "we believed X until
 * we happened to run distillation" is reporting on our cron schedule.
 */
export function markSuperseded(record: MemoryRecord, by: MemoryRecord): MemoryRecord {
  if (record.validTo !== null) return record;
  return {
    ...record,
    status: 'superseded',
    validTo: by.validFrom,
    updatedAt: by.createdAt,
  };
}
