/**
 * Signals in, verdict out.
 *
 * The split is the point. `similaritySignals` measures; `decideVerdict` judges.
 * A semantic arm added later fills in `signals.semantic` and changes nothing
 * else — no caller, no return type, no threshold that is not already named in
 * the policy.
 *
 * **Known limit, stated rather than hidden.** A purely lexical measure cannot
 * confidently call a true paraphrase a duplicate: "we chose Postgres over MySQL
 * for JSONB" and "the decision was Postgres rather than MySQL, driven by JSONB
 * support" share four content tokens out of nine and score around 0.45. The
 * thresholds here are therefore set for *precision* on `duplicate` — a
 * near-restatement, reordered or lightly edited, is caught; a genuine reword
 * lands in `related` and goes to the review queue. That is the honest ceiling
 * for a keyless install, and it is exactly the gap `semantic` closes: when an
 * embedder is available it promotes those `related` pairs to `duplicate`
 * without touching the lexical arms.
 */
import { intersectionSize, jaccard, profileText, type TextProfile } from './normalize.js';
import type { DedupComparison, DedupPolicy, SimilaritySignals } from './types.js';

export const DEFAULT_DEDUP_POLICY: DedupPolicy = {
  shingleSize: 3,
  duplicateTokenJaccard: 0.65,
  duplicateShingleJaccard: 0.45,
  duplicateSemantic: 0.9,
  supersedeContainment: 0.75,
  supersedeLengthRatio: 1.2,
  subsumeContainment: 0.75,
  subsumeLengthRatio: 0.8,
  relatedThreshold: 0.35,
};

/** Measure `next` (the incoming page) against `existing` (the stored one). */
export function similaritySignals(
  next: TextProfile,
  existing: TextProfile,
  semantic?: number
): SimilaritySignals {
  const shared = intersectionSize(next.tokens, existing.tokens);
  return {
    tokenJaccard: jaccard(next.tokens, existing.tokens),
    shingleJaccard: jaccard(next.shingles, existing.shingles),
    containmentNewInExisting: next.size === 0 ? 0 : shared / next.size,
    containmentExistingInNew: existing.size === 0 ? 0 : shared / existing.size,
    lengthRatio: existing.size === 0 ? Infinity : next.size / existing.size,
    ...(semantic === undefined ? {} : { semantic }),
  };
}

/**
 * Judge measured signals.
 *
 * Containment is checked **before** restatement, and the length guards are what
 * make that safe. A page that extends another also overlaps it heavily — a
 * 1.75x superset scores a Jaccard around 0.57, comfortably over the duplicate
 * thresholds — so testing `duplicate` first would discard genuinely new
 * material as a repeat. Running containment first cannot steal a true
 * restatement in the other direction, because a restatement carries roughly the
 * same distinct vocabulary and its `lengthRatio` sits inside the [0.8, 1.2]
 * band that both containment rules exclude.
 *
 * `lengthRatio` is over *distinct* tokens for exactly this reason: padding the
 * same claim with more words does not move it, only new vocabulary does.
 */
export function decideVerdict(
  signals: SimilaritySignals,
  policy: DedupPolicy = DEFAULT_DEDUP_POLICY
): Pick<DedupComparison, 'verdict' | 'score' | 'rationale'> {
  const semantic = signals.semantic ?? 0;

  if (
    signals.containmentExistingInNew >= policy.supersedeContainment &&
    signals.lengthRatio >= policy.supersedeLengthRatio
  ) {
    return {
      verdict: 'supersedes',
      score: signals.containmentExistingInNew,
      rationale: 'covers the existing memory and adds to it',
    };
  }

  if (
    signals.containmentNewInExisting >= policy.subsumeContainment &&
    signals.lengthRatio <= policy.subsumeLengthRatio
  ) {
    return {
      verdict: 'subsumed',
      score: signals.containmentNewInExisting,
      rationale: 'is already covered by a longer existing memory',
    };
  }

  if (
    signals.tokenJaccard >= policy.duplicateTokenJaccard ||
    signals.shingleJaccard >= policy.duplicateShingleJaccard ||
    semantic >= policy.duplicateSemantic
  ) {
    return {
      verdict: 'duplicate',
      score: Math.max(signals.tokenJaccard, signals.shingleJaccard, semantic),
      rationale: 'restates an existing memory',
    };
  }

  const best = Math.max(
    signals.tokenJaccard,
    signals.shingleJaccard,
    signals.containmentNewInExisting,
    signals.containmentExistingInNew,
    semantic
  );
  if (best >= policy.relatedThreshold) {
    return { verdict: 'related', score: best, rationale: 'overlaps an existing memory' };
  }
  return { verdict: 'distinct', score: best, rationale: 'no meaningful overlap' };
}

export interface CompareOptions {
  policy?: DedupPolicy;
  /** Cosine from an embedder, when one is configured. */
  semantic?: number;
}

/** Convenience: profile both sides and compare. */
export function compareProse(
  nextText: string,
  existingText: string,
  options: CompareOptions = {}
): DedupComparison {
  const policy = options.policy ?? DEFAULT_DEDUP_POLICY;
  const signals = similaritySignals(
    profileText(nextText, policy.shingleSize),
    profileText(existingText, policy.shingleSize),
    options.semantic
  );
  return { ...decideVerdict(signals, policy), signals };
}
