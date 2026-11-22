/**
 * Weekly usage history for the provider usage meters.
 *
 * The usage APIs only report the current window. Each poll records the latest
 * reading against the window's reset time; once that reset time passes, the
 * last reading we saw is the week's final utilization. Readings only exist
 * while Nimbalyst is running, so a week whose last reading came well before
 * its reset is a lower bound and is marked partial.
 */

import type { ClaudeUsageData } from './claudeUsage';

export interface UsageWeekSample {
  /** Stable id for the limit, e.g. `claude:weekly` or `codex:codex:secondary`. */
  meter: string;
  label: string;
  utilization: number;
  resetsAt: string | null;
}

export interface UsageWeekRecord {
  meter: string;
  label: string;
  utilization: number;
  resetsAt: string;
  /** When this reading was taken (ms since epoch). */
  lastSeenAt: number;
  /**
   * Readings through the week as [ms since epoch, utilization], added only when
   * the value changes, so the value holds until the next point (or lastSeenAt).
   * Absent on records written before points were kept.
   */
  points?: Array<[number, number]>;
}

export interface UsageWeek extends UsageWeekRecord {
  /** The reset has not happened yet. */
  inProgress: boolean;
  /** Completed, and the last reading came more than PARTIAL_GAP_MS before the reset, so the true final value may be higher. */
  partial: boolean;
}

export interface UsageWeekMeterHistory {
  meter: string;
  label: string;
  /** Newest first; the in-progress week, when recorded, is first. */
  weeks: UsageWeek[];
}

export const USAGE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/** Reset timestamps can drift between polls; readings this close belong to the same window. */
const SAME_WINDOW_TOLERANCE_MS = 60 * 60 * 1000;
const PARTIAL_GAP_MS = 6 * 60 * 60 * 1000;

/** Folds new readings into the stored history; one record per meter per window. */
export function recordUsageWeekSamples(
  records: UsageWeekRecord[],
  samples: UsageWeekSample[],
  now: number,
): UsageWeekRecord[] {
  const next = [...records];
  for (const sample of samples) {
    if (!sample.resetsAt || !Number.isFinite(sample.utilization)) continue;
    const resetMs = Date.parse(sample.resetsAt);
    // A reset in the past or more than a week out is not a live weekly window.
    if (!Number.isFinite(resetMs) || resetMs <= now || resetMs > now + USAGE_WEEK_MS + SAME_WINDOW_TOLERANCE_MS) continue;

    const utilization = Math.round(sample.utilization * 10) / 10;
    const index = next.findIndex(existing =>
      existing.meter === sample.meter &&
      Math.abs(Date.parse(existing.resetsAt) - resetMs) <= SAME_WINDOW_TOLERANCE_MS);
    const points = index === -1 ? [] : [...(next[index].points ?? [])];
    if (points.length === 0 || points[points.length - 1][1] !== utilization) points.push([now, utilization]);

    const record: UsageWeekRecord = {
      meter: sample.meter,
      label: sample.label,
      utilization,
      resetsAt: sample.resetsAt,
      lastSeenAt: now,
      points,
    };
    if (index === -1) next.push(record);
    else next[index] = record;
  }
  return next.sort((a, b) => Date.parse(a.resetsAt) - Date.parse(b.resetsAt));
}

/** Recorded weeks grouped by meter, newest week first, including the week in progress. */
export function usageWeeksByMeter(
  records: UsageWeekRecord[] | undefined,
  now: number,
): UsageWeekMeterHistory[] {
  const byMeter = new Map<string, UsageWeekMeterHistory>();
  for (const record of records ?? []) {
    const resetMs = Date.parse(record.resetsAt);
    if (!Number.isFinite(resetMs)) continue;
    let history = byMeter.get(record.meter);
    if (!history) {
      history = { meter: record.meter, label: record.label, weeks: [] };
      byMeter.set(record.meter, history);
    }
    history.label = record.label;
    const inProgress = resetMs > now;
    history.weeks.push({
      ...record,
      inProgress,
      partial: !inProgress && resetMs - record.lastSeenAt > PARTIAL_GAP_MS,
    });
  }
  for (const history of byMeter.values()) {
    history.weeks.sort((a, b) => Date.parse(b.resetsAt) - Date.parse(a.resetsAt));
  }
  // Insertion order follows reset times across all meters, so a model limit that reset
  // a moment earlier would otherwise take the chart; the account-wide meter leads.
  return [...byMeter.values()].sort((a, b) => Number(isMainMeter(b.meter)) - Number(isMainMeter(a.meter)));
}

/** The provider's account-wide weekly limit, as opposed to a per-model or secondary limit. */
function isMainMeter(meter: string): boolean {
  return meter === 'claude:weekly' || meter.startsWith('codex:codex:');
}

export function claudeUsageWeekSamples(usage: ClaudeUsageData): UsageWeekSample[] {
  if (usage.error) return [];
  const samples: UsageWeekSample[] = [
    { meter: 'claude:weekly', label: 'Weekly', ...usage.sevenDay },
  ];
  for (const limit of usage.weeklyModelLimits ?? []) {
    samples.push({
      meter: `claude:model:${limit.model.toLowerCase()}`,
      label: `${limit.model} (Weekly)`,
      utilization: limit.utilization,
      resetsAt: limit.resetsAt,
    });
  }
  // Same rule as the popover: the legacy Opus field only counts when the labelled limits don't cover it.
  if (usage.sevenDayOpus && !usage.weeklyModelLimits?.some(limit => limit.model.toLowerCase() === 'opus')) {
    samples.push({ meter: 'claude:model:opus', label: 'Opus (Weekly)', ...usage.sevenDayOpus });
  }
  return samples;
}

/** Structural subset of CodexUsageData, which is declared separately in main and the renderer. */
interface CodexUsageForHistory {
  error?: string;
  limits?: Array<{
    id: string;
    name: string | null;
    windows?: Array<{
      slot: string;
      usedPercent: number;
      windowDurationMins: number | null;
      resetsAt: string | null;
    }>;
  }>;
}

const CODEX_WEEK_MINS = 7 * 24 * 60;

export function codexUsageWeekSamples(usage: CodexUsageForHistory): UsageWeekSample[] {
  if (usage.error) return [];
  return (usage.limits ?? []).flatMap(limit => (limit.windows ?? [])
    .filter(window => window.windowDurationMins !== null &&
      Math.abs(window.windowDurationMins - CODEX_WEEK_MINS) <= CODEX_WEEK_MINS * 0.05)
    .map(window => ({
      meter: `codex:${limit.id}:${window.slot}`,
      label: limit.name ? `${limit.name} · Weekly` : 'Weekly',
      utilization: window.usedPercent,
      resetsAt: window.resetsAt,
    })));
}
