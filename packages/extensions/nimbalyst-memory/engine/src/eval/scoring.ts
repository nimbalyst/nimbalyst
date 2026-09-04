/**
 * Scoring for the retrieval evaluation harness: ground-truth matching,
 * recall@N, MRR, and the per-bucket breakdown.
 *
 * Kept free of I/O and of any engine dependency so it is cheap to unit-test
 * against a fixture ranking — the harness itself needs a regression test far
 * more than the corpus needs an asserted recall number.
 */
import type {
  ArmScorecard,
  CoarseTarget,
  GoldenQuestion,
  GoldenSetValidation,
  GoldenTarget,
  QuestionResult,
  RankedHit,
  ScoreBucket,
  UnresolvedTarget,
} from './types.js';

/**
 * A target accepting more than this fraction of its file's chunks is flagged as
 * coarse: it would be satisfied by almost any hit in the file, so it measures
 * "did we find the right document" rather than "did we find the right section".
 */
const COARSE_COVERAGE = 0.5;
/** Coverage is meaningless on a file too small to have sections. */
const COARSE_MIN_CHUNKS = 4;

/**
 * Does a hit satisfy a target?
 *
 * Deliberately strict on both axes. The path must match exactly, and when the
 * target names a heading it must appear in the hit's breadcrumb — a hit in the
 * right file under the wrong heading is NOT a match. Matching on the file alone
 * would make most of this golden set trivially true.
 */
export function hitMatchesTarget(hit: RankedHit, target: GoldenTarget): boolean {
  if (hit.sourcePath !== target.path) return false;
  if (!target.heading) return true;
  return hit.headingPath.includes(target.heading);
}

export function hitMatchesQuestion(hit: RankedHit, question: GoldenQuestion): boolean {
  return question.expect.some((t) => hitMatchesTarget(hit, t));
}

/** 1-based rank of the first correct hit, or null when there is none. */
export function firstCorrectRank(hits: RankedHit[], question: GoldenQuestion): number | null {
  for (let i = 0; i < hits.length; i++) {
    if (hitMatchesQuestion(hits[i], question)) return i + 1;
  }
  return null;
}

export function scoreQuestion(hits: RankedHit[], question: GoldenQuestion): QuestionResult {
  const rank = firstCorrectRank(hits, question);
  return {
    questionId: question.id,
    rank,
    ...(rank !== null ? { matched: hits[rank - 1] } : {}),
    ...(hits.length ? { top: hits[0] } : {}),
  };
}

/**
 * recall@N and MRR over a set of results.
 *
 * MRR is computed over the retrieved depth the arm was asked for: a question
 * whose answer never appears contributes 0, not an imputed tail value. That
 * makes the number comparable across arms only when they were asked for the
 * same `k`, which the runner guarantees.
 */
export function scoreBucket(label: string, results: QuestionResult[], recallAt: number): ScoreBucket {
  const n = results.length;
  if (n === 0) return { label, questions: 0, recallAtN: 0, mrr: 0 };
  let hits = 0;
  let rrSum = 0;
  for (const r of results) {
    if (r.rank === null) continue;
    if (r.rank <= recallAt) hits++;
    rrSum += 1 / r.rank;
  }
  return { label, questions: n, recallAtN: hits / n, mrr: rrSum / n };
}

/**
 * Build the full bucket list for one arm: overall, then one bucket per source
 * class, then one per tag.
 *
 * Per-class matters because the corpus is wildly unbalanced — plans alone
 * outnumber `CLAUDE.md` by two orders of magnitude — so a single aggregate
 * number will happily hide a total collapse in a small, high-value class.
 *
 * The class list is derived from `classByQuestion` (which the runner fills in
 * from the live index), never hardcoded: source classes change as the engine's
 * default source set grows.
 */
export function buildBuckets(
  results: QuestionResult[],
  questions: GoldenQuestion[],
  validation: GoldenSetValidation,
  recallAt: number
): ScoreBucket[] {
  const byId = new Map(questions.map((q) => [q.id, q]));
  const buckets: ScoreBucket[] = [scoreBucket('overall', results, recallAt)];

  const byClass = new Map<string, QuestionResult[]>();
  const byTag = new Map<string, QuestionResult[]>();
  for (const r of results) {
    const cls = validation.classByQuestion[r.questionId] ?? 'unknown';
    if (!byClass.has(cls)) byClass.set(cls, []);
    byClass.get(cls)!.push(r);
    for (const tag of byId.get(r.questionId)?.tags ?? []) {
      const key = `tag:${tag}`;
      if (!byTag.has(key)) byTag.set(key, []);
      byTag.get(key)!.push(r);
    }
  }

  for (const cls of [...byClass.keys()].sort()) {
    buckets.push(scoreBucket(cls, byClass.get(cls)!, recallAt));
  }
  for (const tag of [...byTag.keys()].sort()) {
    buckets.push(scoreBucket(tag, byTag.get(tag)!, recallAt));
  }
  return buckets;
}

export function buildScorecard(
  armId: string,
  armLabel: string,
  slotKey: string,
  results: QuestionResult[],
  questions: GoldenQuestion[],
  validation: GoldenSetValidation,
  recallAt: number,
  elapsedMs: number
): ArmScorecard {
  return {
    armId,
    armLabel,
    slotKey,
    buckets: buildBuckets(results, questions, validation, recallAt),
    results,
    elapsedMs,
  };
}

// --- Golden-set validation -------------------------------------------------

/** The corpus facts validation needs, so it can run against a fixture too. */
export interface CorpusIndex {
  /** Heading breadcrumbs of every chunk, keyed by source path. */
  headingPathsByFile: Map<string, string[][]>;
  /** Source class of each indexed file. */
  classByFile: Map<string, string>;
}

/** Reduce a chunk snapshot to what `validateGoldenSet` needs. */
export function buildCorpusIndex(
  chunks: Array<{ sourcePath: string; sourceClass: string; headingPath: string[] }>
): CorpusIndex {
  const headingPathsByFile = new Map<string, string[][]>();
  const classByFile = new Map<string, string>();
  for (const c of chunks) {
    if (!headingPathsByFile.has(c.sourcePath)) headingPathsByFile.set(c.sourcePath, []);
    headingPathsByFile.get(c.sourcePath)!.push(c.headingPath);
    classByFile.set(c.sourcePath, c.sourceClass);
  }
  return { headingPathsByFile, classByFile };
}

/**
 * Check every golden target against the indexed corpus BEFORE scoring.
 *
 * A question pointing at a file that is not indexed, or at a heading that does
 * not exist, scores zero on every arm and is indistinguishable from a genuine
 * retrieval failure. Silently averaging those in would make the whole
 * instrument untrustworthy, so they are surfaced and excluded.
 */
export function validateGoldenSet(
  questions: GoldenQuestion[],
  corpus: CorpusIndex
): GoldenSetValidation {
  const unresolved: UnresolvedTarget[] = [];
  const coarse: CoarseTarget[] = [];
  const classByQuestion: Record<string, string> = {};
  let resolved = 0;

  for (const q of questions) {
    let anyResolvable = false;
    for (const target of q.expect) {
      const paths = corpus.headingPathsByFile.get(target.path);
      if (!paths) {
        unresolved.push({ questionId: q.id, target, reason: 'file-not-indexed' });
        continue;
      }
      const accepted = target.heading
        ? paths.filter((hp) => hp.includes(target.heading!)).length
        : paths.length;
      if (accepted === 0) {
        unresolved.push({ questionId: q.id, target, reason: 'heading-not-found' });
        continue;
      }
      if (!anyResolvable) {
        anyResolvable = true;
        classByQuestion[q.id] = corpus.classByFile.get(target.path) ?? 'unknown';
      }
      const coverage = accepted / paths.length;
      if (paths.length >= COARSE_MIN_CHUNKS && coverage > COARSE_COVERAGE) {
        coarse.push({ questionId: q.id, target, coverage, fileChunks: paths.length });
      }
    }
    if (anyResolvable) resolved++;
  }

  return { total: questions.length, resolved, unresolved, coarse, classByQuestion };
}

/** Questions with at least one resolvable target — the ones worth scoring. */
export function scorableQuestions(
  questions: GoldenQuestion[],
  validation: GoldenSetValidation
): GoldenQuestion[] {
  return questions.filter((q) => validation.classByQuestion[q.id] !== undefined);
}
