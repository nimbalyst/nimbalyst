export interface ClaudeUsageWindow {
  utilization: number;
  resetsAt: string | null;
}

export interface ClaudeWeeklyModelLimit extends ClaudeUsageWindow {
  model: string;
}

export interface ClaudeUsageData {
  /** Null when the plan has no 5-hour session limit (the API sends `five_hour: null`). */
  fiveHour: ClaudeUsageWindow | null;
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

function parseUsageWindow(raw: any): ClaudeUsageWindow | null {
  if (raw == null) return null;
  return { utilization: raw.utilization ?? 0, resetsAt: raw.resets_at ?? null };
}

/** Maps the oauth/usage response. A null `five_hour` means the plan has no session limit, not 0% used. */
export function parseClaudeUsageResponse(data: any, now: number): ClaudeUsageData {
  return {
    fiveHour: parseUsageWindow(data.five_hour),
    sevenDay: parseUsageWindow(data.seven_day) ?? { utilization: 0, resetsAt: null },
    sevenDayOpus: parseUsageWindow(data.seven_day_opus) ?? undefined,
    weeklyModelLimits: parseWeeklyModelLimits(data.limits),
    lastUpdated: now,
  };
}

export interface ClaudeUsageHeadline extends ClaudeUsageWindow {
  label: 'Session' | 'Weekly';
}

/** The window the gutter ring shows: the session limit, or the weekly limit when the plan has none. */
export function claudeUsageHeadline(usage: ClaudeUsageData): ClaudeUsageHeadline {
  return usage.fiveHour
    ? { label: 'Session', ...usage.fiveHour }
    : { label: 'Weekly', ...usage.sevenDay };
}
