/**
 * Prose-aware near-duplicate detection for memory pages. Lexical only, by
 * design: a keyless install has to dedup, so nothing here needs an embedder.
 * When one is available its cosine enters through `SimilaritySignals.semantic`
 * and no caller changes.
 */
export { DedupIndex } from './dedupIndex.js';
export type { DedupIndexOptions, QueryOptions } from './dedupIndex.js';
export {
  compareProse,
  decideVerdict,
  similaritySignals,
  DEFAULT_DEDUP_POLICY,
} from './compare.js';
export type { CompareOptions } from './compare.js';
export { profileText, tokenize, normalizeProse, shingle, jaccard } from './normalize.js';
export type { TextProfile } from './normalize.js';
export { minhashSignature, bandKeys } from './minhash.js';
export type {
  DedupVerdict,
  DedupAction,
  DedupDecision,
  DedupMatch,
  DedupComparison,
  DedupPolicy,
  SimilaritySignals,
} from './types.js';
