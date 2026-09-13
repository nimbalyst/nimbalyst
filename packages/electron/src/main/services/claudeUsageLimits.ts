/**
 * Pure parsing helpers for the Claude usage API payload.
 *
 * Deliberately dependency-free: ClaudeUsageService reaches for electron, the
 * runtime's Claude config-dir resolvers, and the shell-environment manager, so
 * importing it just to exercise a pure reducer drags in the whole main-process
 * graph. Keeping the payload shape here lets the parsing rules be unit-tested
 * on their own.
 */

export type ClaudeUsageSeverity = 'normal' | 'warning' | 'critical';

/**
 * A weekly limit that applies to one model rather than the whole account —
 * "Fable (Weekly)", "Opus (Weekly)", and whatever the API scopes next.
 *
 * These arrive in the `limits[]` array as `kind: "weekly_scoped"` entries
 * carrying `scope.model.display_name`. The older dedicated `seven_day_opus`
 * field is still in the payload but now reports `null`, so a client that only
 * reads that field silently shows no per-model limit at all.
 */
export interface ClaudeScopedLimit {
  id: string; // stable key for React lists, e.g. "weekly_scoped:fable:2"
  label: string; // model display name, e.g. "Fable"
  utilization: number; // 0-100 percentage
  resetsAt: string | null; // ISO timestamp
  severity: ClaudeUsageSeverity;
}

/** Shape of one entry in the usage API's `limits[]` array. */
interface RawUsageLimit {
  kind?: string;
  group?: string;
  percent?: number;
  severity?: string;
  resets_at?: string | null;
  scope?: {
    model?: { id?: string | null; display_name?: string | null } | null;
    surface?: unknown;
  } | null;
}

interface RawUsagePayload {
  limits?: unknown;
  seven_day_opus?: { utilization?: number; resets_at?: string | null } | null;
}

const USAGE_SEVERITIES: ClaudeUsageSeverity[] = ['normal', 'warning', 'critical'];

function normalizeSeverity(value: unknown): ClaudeUsageSeverity | null {
  return USAGE_SEVERITIES.includes(value as ClaudeUsageSeverity)
    ? (value as ClaudeUsageSeverity)
    : null;
}

/** Fallback for payloads that omit `severity`, matching the popover's thresholds. */
function severityFromUtilization(utilization: number): ClaudeUsageSeverity {
  if (utilization >= 80) return 'critical';
  if (utilization >= 50) return 'warning';
  return 'normal';
}

/**
 * Pull the per-model weekly limits out of a usage API response.
 *
 * Falls back to synthesising an Opus entry from the legacy `seven_day_opus`
 * field so older server payloads (and anyone pinned to them) keep their bar.
 */
export function extractScopedLimits(data: unknown): ClaudeScopedLimit[] {
  const payload = (data ?? {}) as RawUsagePayload;
  const rawLimits = Array.isArray(payload.limits) ? (payload.limits as RawUsageLimit[]) : [];

  const scoped = rawLimits
    .filter((limit) => limit?.kind === 'weekly_scoped' && Boolean(limit?.scope?.model?.display_name))
    .map((limit, index) => {
      const label = limit.scope!.model!.display_name as string;
      const utilization = typeof limit.percent === 'number' ? limit.percent : 0;
      return {
        id: `weekly_scoped:${limit.scope?.model?.id || label.toLowerCase()}:${index}`,
        label,
        utilization,
        resetsAt: limit.resets_at ?? null,
        severity: normalizeSeverity(limit.severity) ?? severityFromUtilization(utilization),
      };
    });

  if (scoped.length > 0) return scoped;

  const legacyOpus = payload.seven_day_opus;
  if (legacyOpus) {
    const utilization = legacyOpus.utilization ?? 0;
    return [
      {
        id: 'weekly_scoped:opus:legacy',
        label: 'Opus',
        utilization,
        resetsAt: legacyOpus.resets_at ?? null,
        severity: severityFromUtilization(utilization),
      },
    ];
  }

  return [];
}
