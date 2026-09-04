/**
 * Promotion: the one-way door from a mined memory to a repository convention.
 *
 * A memory that has earned its keep becomes a `.claude/rules/*.md` file and
 * therefore a normal, reviewable diff. Nothing here decides to promote and
 * nothing here writes on its own — `planPromotion` renders, a human reads, and
 * `writePromotionPlan` writes exactly what they read.
 *
 * Dependency-free and Node-stdlib only, so it runs wherever the engine does.
 */
export { planPromotion, writePromotionPlan } from './promote.js';
export type {
  PlanPromotionInput,
  PromotionPlan,
  PromotionPlanStatus,
  PromotionWriteResult,
  WritePromotionOptions,
} from './promote.js';
export { computePromotionSignal, DEFAULT_PROMOTION_THRESHOLDS } from './signal.js';
export type { PromotionSignal, PromotionThresholds } from './signal.js';
export { renderRuleMarkdown, ruleFileNameFor } from './render.js';
export type { RenderRuleOptions, RenderedRule } from './render.js';
export {
  assertNoTrackerKeys,
  formatIssueCitation,
  stripTrackerKeys,
  DEFAULT_TRACKER_KEY_PREFIXES,
} from './provenance.js';
export type { StripResult, TrackerKeyRemoval } from './provenance.js';
export type { MemoryRecallStats, MemoryStandingState, PromotableMemory } from './types.js';
