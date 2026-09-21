export interface ClaudeUsageWindow {
  utilization: number;
  resetsAt: string | null;
}

export interface ClaudeWeeklyModelLimit extends ClaudeUsageWindow {
  model: string;
}

export interface ClaudeUsageData {
  fiveHour: ClaudeUsageWindow;
  sevenDay: ClaudeUsageWindow;
  sevenDayOpus?: ClaudeUsageWindow;
  weeklyModelLimits?: ClaudeWeeklyModelLimit[];
  lastUpdated: number;
  error?: string;
}

/** New model quotas are reported by label in limits, not legacy seven_day_* fields. */
export function parseWeeklyModelLimits(limits: unknown): ClaudeWeeklyModelLimit[] {
  if (limits == null) return [];
  if (!Array.isArray(limits)) throw new Error('Invalid Claude usage limits');
  return limits.flatMap((limit): ClaudeWeeklyModelLimit[] => {
    if (limit?.kind !== 'weekly_scoped' || !limit.scope?.model) return [];
    const model = limit.scope.model.display_name;
    if (typeof model !== 'string' || !model.trim() ||
        typeof limit.percent !== 'number' || !Number.isFinite(limit.percent) || limit.percent < 0 ||
        (limit.resets_at != null && (typeof limit.resets_at !== 'string' || !Number.isFinite(Date.parse(limit.resets_at))))) {
      throw new Error('Invalid Claude weekly model limit');
    }
    return [{ model, utilization: limit.percent, resetsAt: limit.resets_at ?? null }];
  });
}
