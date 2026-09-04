/**
 * Types for the retrieval evaluation harness.
 *
 * The harness exists because the engine has no measurement of retrieval
 * quality, which makes every retrieval change (embedder model, fusion weights,
 * page-level vectors) unfalsifiable. It scores a golden query set against the
 * real corpus and prints a side-by-side scorecard for two or more *arms*.
 *
 * An arm is a configuration of retrieval, not a code path in the runner. Adding
 * one is data: append an `ArmSpec` to the registry in `arms.ts`. Nothing in
 * `run.ts`, `scoring.ts`, or `report.ts` knows how many arms there are or what
 * they do.
 */
import type { EmbedderInfo, StoredChunk } from '../types.js';
import type { MemoryEngine } from '../engine.js';

// --- Golden set ------------------------------------------------------------

/**
 * One known-correct location for an answer, expressed the way the chunker
 * cites: a source path plus (optionally) a heading from that document.
 *
 * A hit matches when its `sourcePath` equals `path` and — when `heading` is
 * given — `heading` appears anywhere in the hit's heading breadcrumb. Omitting
 * `heading` accepts any chunk in the file, which is only appropriate for short
 * single-topic documents; `validateGoldenSet` warns when a heading is so coarse
 * that it covers most of its file, because such a target cannot discriminate
 * between a good and a bad ranking.
 */
export interface GoldenTarget {
  /** POSIX path relative to the engine root, e.g. `docs/JOTAI.md`. */
  path: string;
  /** A heading from that document's breadcrumb. Omit to accept any chunk. */
  heading?: string;
}

export interface GoldenQuestion {
  /** Stable id; used to name the question in per-question output. */
  id: string;
  /** The question, phrased the way a developer would actually ask it. */
  question: string;
  /**
   * Acceptable answers. Any one of them counts as correct — some questions are
   * legitimately answered from more than one place. The FIRST entry is the
   * primary target and determines which source class the question is filed
   * under in the per-class breakdown.
   */
  expect: GoldenTarget[];
  /**
   * Free-form facets, reported as their own scorecard rows.
   *
   * `semantic` marks a question deliberately phrased WITHOUT the target
   * section's vocabulary, so BM25 cannot reach it on term overlap alone. A
   * golden set of purely lexical questions flatters every arm equally and
   * measures nothing, so the mix is tracked rather than assumed.
   */
  tags?: string[];
}

// --- Arms ------------------------------------------------------------------

/** The minimum a ranked result needs to carry for scoring. */
export interface RankedHit {
  sourcePath: string;
  headingPath: string[];
  /** Arm-specific score, best-first. Diagnostic only; scoring uses rank. */
  score?: number;
}

/**
 * One embedding backend and the index built with it.
 *
 * Slots exist because "which embedder" and "which ranking strategy" are
 * independent axes and the plan needs both measured: open question 1 is
 * literally "choose the local model against the golden set", which is one
 * ranking strategy across several embedders, while amendment A2's page-level
 * variant is several strategies over one embedder. A run indexes once per slot
 * and every arm names the slot it ran on.
 *
 * A slot the machine cannot provide (no key, model not installed) is still
 * declared. It occupies a column in the scorecard marked unpopulated, with the
 * reason printed — which is what stops "we never measured it" from looking the
 * same as "it scored zero".
 */
export interface EmbedderSlot {
  /** Stable key used in arm ids and column labels: `sparse`, `openai`, `local`. */
  key: string;
  /** Human label, e.g. `openai/text-embedding-3-small`. */
  label: string;
  /** Null until the slot is actually constructed. */
  info: EmbedderInfo | null;
  available: boolean;
  /** Why this slot could not be built. Printed under the scorecard. */
  unavailableReason?: string;
  /** The chunk snapshot indexed with this embedder. Absent when unavailable. */
  chunks?: StoredChunk[];
  /** Memoized query embedding. Returns null for a dims-0 (keyword) slot. */
  embedQuery?: (text: string) => Promise<number[] | null>;
  /** The live engine over this slot's index, for arms needing more than chunks. */
  engine?: MemoryEngine;
}

/** Everything an arm needs. One context per (arm, slot) pair. */
export interface ArmContext {
  slot: EmbedderSlot;
  /** The full stored-chunk snapshot for this slot. */
  chunks: StoredChunk[];
  /** Embed a query with this slot's embedder. Null on a keyword-only slot. */
  embedQuery(text: string): Promise<number[] | null>;
  /** The live engine over this slot's index. */
  engine: MemoryEngine;
  /** True when this slot's index carries dense vectors. */
  hasDense: boolean;
}

export interface EvalArm {
  /** Rank the corpus for one query. Returns at most `k` hits, best first. */
  rank(query: string, k: number): Promise<RankedHit[]>;
}

/**
 * A retrieval configuration to score. This is the extension point: a later
 * slice adds the page-level-vector arm by appending a spec here, with no change
 * to the runner or the scorer.
 */
export interface ArmSpec {
  /** Stable id used on the command line (`--arms=sparse,rrf`). */
  id: string;
  /** Column header in the scorecard; suffixed with the slot key on multi-slot runs. */
  label: string;
  /** One line explaining what this arm is, printed above the table. */
  description: string;
  /** Only expand this arm onto slots that carry dense vectors. */
  requiresDense?: boolean;
  /**
   * The arm's ranking does not depend on the embedder, so expanding it onto
   * every slot would print the identical column N times. Expanded once, onto
   * the first available slot.
   */
  embedderAgnostic?: boolean;
  build(ctx: ArmContext): EvalArm | Promise<EvalArm>;
}

/** An `ArmSpec` bound to a slot — one column of the scorecard. */
export interface PlannedArm {
  /** `${spec.id}@${slot.key}`. */
  id: string;
  /** Column header, slot-qualified when the run has more than one slot. */
  label: string;
  spec: ArmSpec;
  slot: EmbedderSlot;
}

// --- Results ---------------------------------------------------------------

/** How one arm did on one question. */
export interface QuestionResult {
  questionId: string;
  /** 1-based rank of the first correct hit, or null when absent from the top-k. */
  rank: number | null;
  /** The hit that matched, for eyeballing near-misses. */
  matched?: RankedHit;
  /** The top hit the arm returned, correct or not. */
  top?: RankedHit;
}

/** recall@N and MRR over some subset of questions. */
export interface ScoreBucket {
  /** Bucket name: `overall`, a source class, or `tag:semantic`. */
  label: string;
  questions: number;
  /** Fraction of questions with a correct hit at rank <= recallAt. */
  recallAtN: number;
  /** Mean reciprocal rank over the retrieved top-k; 0 for a miss. */
  mrr: number;
}

export interface ArmScorecard {
  armId: string;
  armLabel: string;
  /** Which embedder slot this column ran on. */
  slotKey: string;
  /**
   * True when the column is declared but was never scored, because its slot
   * could not be built on this machine. `buckets` and `results` are empty.
   */
  declaredOnly?: boolean;
  unavailableReason?: string;
  /** `overall` first, then one per source class, then one per tag. */
  buckets: ScoreBucket[];
  results: QuestionResult[];
  /** Wall-clock milliseconds spent ranking. */
  elapsedMs: number;
}

export interface EvalRunReport {
  /** `recall@N`'s N. */
  recallAt: number;
  /** How many hits each arm was asked for. MRR is computed over this depth. */
  k: number;
  /** Every slot the run declared, populated or not. */
  slots: Array<{
    key: string;
    label: string;
    info: EmbedderInfo | null;
    available: boolean;
    unavailableReason?: string;
  }>;
  corpus: { chunks: number; sourceFiles: number; bySourceClass: Record<string, number> };
  /** Questions actually scored (unresolved targets are excluded). */
  scored: number;
  validation: GoldenSetValidation;
  arms: ArmScorecard[];
}

// --- Validation ------------------------------------------------------------

/**
 * A golden question whose target does not exist in the indexed corpus. Such a
 * question scores 0 on every arm and looks exactly like a retrieval failure,
 * so it is reported separately and excluded from the score rather than quietly
 * dragging every number down.
 */
export interface UnresolvedTarget {
  questionId: string;
  target: GoldenTarget;
  reason: 'file-not-indexed' | 'heading-not-found';
}

/** A target so broad it cannot distinguish a good ranking from a bad one. */
export interface CoarseTarget {
  questionId: string;
  target: GoldenTarget;
  /** Fraction of the file's chunks this target accepts. */
  coverage: number;
  fileChunks: number;
}

export interface GoldenSetValidation {
  total: number;
  /** Questions with at least one resolvable target. */
  resolved: number;
  unresolved: UnresolvedTarget[];
  coarse: CoarseTarget[];
  /** Source class of each question's primary target, keyed by question id. */
  classByQuestion: Record<string, string>;
}
