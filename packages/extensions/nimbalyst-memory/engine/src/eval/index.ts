/**
 * Retrieval evaluation harness — public surface.
 *
 * Import from here rather than from the individual modules: a later slice
 * adding an arm (the page-level-vector variant from memory-v3 amendment A2)
 * needs `ArmSpec`, `ArmContext`, and `BUILT_IN_ARMS`, and nothing else.
 */
export * from './types.js';
export { BUILT_IN_ARMS, planArms, selectArms } from './arms.js';
export { buildSlots, closeSlots, type BuildSlotsOptions, type SlotRequest } from './slots.js';
export { DEFAULT_KEY_FIELD, resolveApiKey, readDotted } from './keySource.js';
export { GOLDEN_SET } from './goldenSet.js';
export { EVAL_EXCLUDE, EVAL_FACTS_DIR, evalSources, findRepoRoot } from './corpus.js';
export { runEvaluation, type RunOptions } from './run.js';
export {
  buildCorpusIndex,
  buildBuckets,
  buildScorecard,
  firstCorrectRank,
  hitMatchesQuestion,
  hitMatchesTarget,
  scorableQuestions,
  scoreBucket,
  scoreQuestion,
  validateGoldenSet,
  type CorpusIndex,
} from './scoring.js';
export { formatCorpus, formatPerQuestion, formatScorecard, formatValidation } from './report.js';
