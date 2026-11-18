/** Historical elapsed-time fraction divided by consumed fraction; not a forecast. */
export function limitRatio(elapsed: number | null, usage: number): number | null {
  if (elapsed === null || !Number.isFinite(elapsed) || elapsed < 0 || elapsed > 100 ||
      !Number.isFinite(usage) || usage < 0) return null;
  if (usage === 0) return elapsed === 0 ? null : Infinity;
  return elapsed / usage;
}

export function formatLimitRatio(ratio: number | null): string {
  return ratio === null ? 'unavailable' : ratio === Infinity ? '∞' : `${ratio.toFixed(1)}×`;
}

export const LIMIT_RATIO_EXPLANATION = 'Elapsed time divided by usage. Above 1 means below linear consumption pace; below 1 means above pace. This is historical, not a forecast.';
