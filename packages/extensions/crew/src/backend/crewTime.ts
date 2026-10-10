/**
 * Pure calendar decisions for Crew: when a schedule next runs, whether an
 * instant falls in quiet hours, what a launch catch-up should enqueue, and
 * whether a member's self-made schedule change stays inside its bounds.
 * Ported from the first (core) Crew build; schedules now live only in the
 * definition file, so a "row" here is one frontmatter entry.
 *
 * Everything takes an explicit IANA time zone so the DST cases are testable
 * without touching `process.env.TZ`. Local `HH:mm` times are host wall-clock
 * times. DST policy: a wall time that does not exist (spring-forward gap)
 * runs at the same offset from midnight after the jump (02:30 -> 03:30); a
 * wall time that occurs twice (fall-back) runs once, at the first occurrence.
 */

import type { CrewScheduleSpec, CrewWeekday } from '../shared/types';

export type CrewScheduleRecurrence = 'daily' | 'weekly' | 'interval';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export const CREW_WEEKDAYS: readonly CrewWeekday[] = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
];

export function hostTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** Epoch ms of a wire ISO timestamp, or null when absent or unparseable. */
export function isoToMs(iso: string | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

// ─── Wall-clock <-> instant ──────────────────────────────────────────────

export interface LocalDate {
  year: number;
  month: number; // 1-12
  day: number;
}

interface LocalParts extends LocalDate {
  hour: number;
  minute: number;
  second: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

function localParts(instantMs: number, timeZone: string): LocalParts {
  const parts: Record<string, number> = {};
  for (const part of formatterFor(timeZone).formatToParts(new Date(instantMs))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour === 24 ? 0 : parts.hour,
    minute: parts.minute,
    second: parts.second,
  };
}

/** Local minus UTC, in ms, at the given instant. */
function zoneOffsetMs(instantMs: number, timeZone: string): number {
  const flooredMs = Math.floor(instantMs / 1000) * 1000;
  const p = localParts(flooredMs, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - flooredMs;
}

export function localDateOf(instantMs: number, timeZone: string): LocalDate {
  const { year, month, day } = localParts(instantMs, timeZone);
  return { year, month, day };
}

export function addLocalDays(date: LocalDate, days: number): LocalDate {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

export function weekdayOf(date: LocalDate): CrewWeekday {
  return CREW_WEEKDAYS[new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay()];
}

/** The instant a local wall time happens, with the DST policy described above. */
export function zonedWallTimeToInstant(
  date: LocalDate,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  const asUtc = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  const offsetBefore = zoneOffsetMs(asUtc - 12 * HOUR_MS, timeZone);
  const offsetAfter = zoneOffsetMs(asUtc + 12 * HOUR_MS, timeZone);
  const matches = (instant: number) => {
    const p = localParts(instant, timeZone);
    return p.year === date.year && p.month === date.month && p.day === date.day
      && p.hour === hour && p.minute === minute;
  };
  const candidates = [asUtc - offsetBefore, asUtc - offsetAfter].filter(matches);
  if (candidates.length > 0) return Math.min(...candidates);
  // Gap: the wall time was skipped. Using the pre-transition offset lands the
  // same distance past the jump (02:30 EST-intent -> 03:30 EDT).
  return asUtc - offsetBefore;
}

export function startOfLocalDay(instantMs: number, timeZone: string): number {
  return zonedWallTimeToInstant(localDateOf(instantMs, timeZone), 0, 0, timeZone);
}

export function nextLocalMidnight(instantMs: number, timeZone: string): number {
  return zonedWallTimeToInstant(addLocalDays(localDateOf(instantMs, timeZone), 1), 0, 0, timeZone);
}

// ─── HH:mm and quiet hours ────────────────────────────────────────────────

const HHMM_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

export function parseLocalTime(value: string): { hour: number; minute: number } | null {
  const match = HHMM_RE.exec(value.trim());
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

export interface QuietHours {
  startMinute: number;
  endMinute: number;
}

/** Parses `"22:00-08:00"`. The window may wrap midnight. Equal ends means no quiet hours. */
export function parseQuietHours(value: string | undefined): QuietHours | null {
  if (!value) return null;
  const [start, end] = value.split('-');
  if (start === undefined || end === undefined) return null;
  const s = parseLocalTime(start);
  const e = parseLocalTime(end);
  if (!s || !e) return null;
  const startMinute = s.hour * 60 + s.minute;
  const endMinute = e.hour * 60 + e.minute;
  if (startMinute === endMinute) return null;
  return { startMinute, endMinute };
}

function minuteInWindow(minuteOfDay: number, q: QuietHours): boolean {
  return q.startMinute < q.endMinute
    ? minuteOfDay >= q.startMinute && minuteOfDay < q.endMinute
    : minuteOfDay >= q.startMinute || minuteOfDay < q.endMinute;
}

export function isInQuietHours(instantMs: number, quietHours: string | undefined, timeZone: string): boolean {
  const q = parseQuietHours(quietHours);
  if (!q) return false;
  const p = localParts(instantMs, timeZone);
  return minuteInWindow(p.hour * 60 + p.minute, q);
}

/** When the quiet window containing `instantMs` ends, or null if not in quiet hours. */
export function quietHoursEnd(instantMs: number, quietHours: string | undefined, timeZone: string): number | null {
  const q = parseQuietHours(quietHours);
  if (!q || !isInQuietHours(instantMs, quietHours, timeZone)) return null;
  const today = localDateOf(instantMs, timeZone);
  const hour = Math.floor(q.endMinute / 60);
  const minute = q.endMinute % 60;
  for (let offset = 0; offset <= 1; offset += 1) {
    const end = zonedWallTimeToInstant(addLocalDays(today, offset), hour, minute, timeZone);
    if (end > instantMs) return end;
  }
  return null;
}

// ─── Schedule specs ───────────────────────────────────────────────────────

export function scheduleShape(spec: CrewScheduleSpec):
  | { kind: 'recurring'; recurrence: CrewScheduleRecurrence }
  | { kind: 'one-shot' } {
  if ('at' in spec && spec.at !== undefined) return { kind: 'one-shot' };
  if ('weekly' in spec && spec.weekly !== undefined) return { kind: 'recurring', recurrence: 'weekly' };
  if ('interval' in spec && spec.interval !== undefined) return { kind: 'recurring', recurrence: 'interval' };
  return { kind: 'recurring', recurrence: 'daily' };
}

/**
 * The first run strictly after `afterMs`. `afterMs` is the reference point:
 * the last run for an existing schedule, or "now" for a new one. Interval
 * schedules are anchored on it; a one-shot has no run after its own time.
 */
export function computeNextRunAt(spec: CrewScheduleSpec, afterMs: number, timeZone: string): number | null {
  if (spec.at !== undefined) {
    const at = Date.parse(spec.at);
    return Number.isFinite(at) && at > afterMs ? at : null;
  }
  if (spec.interval !== undefined) {
    const minutes = spec.interval.minutes;
    return minutes > 0 ? afterMs + minutes * MINUTE_MS : null;
  }
  const time = spec.daily !== undefined ? spec.daily : spec.weekly?.time;
  const parsed = time ? parseLocalTime(time) : null;
  if (!parsed) return null;
  const days = spec.weekly ? new Set(spec.weekly.days) : null;
  if (days && days.size === 0) return null;
  const today = localDateOf(afterMs, timeZone);
  // Nine days covers a weekly schedule whose only day is today, already passed.
  for (let offset = 0; offset <= 8; offset += 1) {
    const date = addLocalDays(today, offset);
    if (days && !days.has(weekdayOf(date))) continue;
    const candidate = zonedWallTimeToInstant(date, parsed.hour, parsed.minute, timeZone);
    if (candidate > afterMs) return candidate;
  }
  return null;
}

/**
 * First run for a newly created or re-timed schedule. A one-shot whose time
 * already passed still runs once (a late wake beats a silently dropped one);
 * recurring schedules start from now.
 */
export function initialNextRunAt(spec: CrewScheduleSpec, nowMs: number, timeZone: string): number | null {
  if (spec.at !== undefined) {
    const at = Date.parse(spec.at);
    return Number.isFinite(at) ? at : null;
  }
  return computeNextRunAt(spec, nowMs, timeZone);
}

/** Run instants in `[fromMs, toMs)`, capped at `limit` so a tiny interval cannot blow up. */
export function runsBetween(
  spec: CrewScheduleSpec,
  fromMs: number,
  toMs: number,
  timeZone: string,
  limit: number,
): number[] {
  const runs: number[] = [];
  if (spec.at !== undefined) {
    const at = Date.parse(spec.at);
    if (Number.isFinite(at) && at >= fromMs && at < toMs) runs.push(at);
    return runs;
  }
  let cursor = fromMs - 1;
  while (runs.length < limit) {
    const next = spec.interval !== undefined
      ? (runs.length === 0 ? fromMs : cursor + spec.interval.minutes * MINUTE_MS)
      : computeNextRunAt(spec, cursor, timeZone);
    if (next === null || next >= toMs) break;
    runs.push(next);
    cursor = next;
  }
  return runs;
}

// ─── Due schedules and launch catch-up ────────────────────────────────────

export interface DueScheduleInput {
  id: string;
  workspaceId: string;
  memberSlug: string;
  spec: CrewScheduleSpec;
  prompt: string;
  enabled: boolean;
  nextRunAtMs: number | null;
}

export interface PlannedInbox {
  workspaceId: string;
  memberSlug: string;
  trigger: 'schedule' | 'launch-catchup';
  prompt: string;
  scheduleIds: string[];
  /** How many occurrences this one event stands in for (1 unless the app was closed). */
  missedOccurrences: number;
}

export interface PlannedScheduleUpdate {
  id: string;
  nextRunAtMs: number | null;
  lastRunAtMs: number;
}

export interface DuePlan {
  inbox: PlannedInbox[];
  updates: PlannedScheduleUpdate[];
}

/**
 * Turns due schedule rows into inbox events and schedule advances.
 *
 * Every due row advances past `nowMs`, never to the next missed occurrence,
 * so a member asleep for a week gets one run, not seven. At launch all of a
 * member's due rows collapse into one `launch-catchup` event; during normal
 * running each row becomes its own `schedule` event (and the shift runner
 * still consumes a member's whole inbox in one shift). Paused or unknown
 * members advance without an event.
 */
export function planDueSchedules(
  rows: readonly DueScheduleInput[],
  nowMs: number,
  timeZone: string,
  options: { atLaunch: boolean; isRunnable: (workspaceId: string, memberSlug: string) => boolean },
): DuePlan {
  const updates: PlannedScheduleUpdate[] = [];
  const grouped = new Map<string, PlannedInbox>();
  const inbox: PlannedInbox[] = [];

  for (const row of rows) {
    if (!row.enabled || row.nextRunAtMs === null || row.nextRunAtMs > nowMs) continue;
    const missed = Math.max(1, runsBetween(row.spec, row.nextRunAtMs, nowMs + 1, timeZone, 1000).length);
    updates.push({ id: row.id, nextRunAtMs: computeNextRunAt(row.spec, nowMs, timeZone), lastRunAtMs: nowMs });
    if (!options.isRunnable(row.workspaceId, row.memberSlug)) continue;

    if (!options.atLaunch) {
      inbox.push({
        workspaceId: row.workspaceId,
        memberSlug: row.memberSlug,
        trigger: 'schedule',
        prompt: row.prompt,
        scheduleIds: [row.id],
        missedOccurrences: missed,
      });
      continue;
    }
    const key = JSON.stringify([row.workspaceId, row.memberSlug]);
    const existing = grouped.get(key);
    if (existing) {
      existing.scheduleIds.push(row.id);
      existing.missedOccurrences += missed;
      if (!existing.prompt.split('\n\n').includes(row.prompt)) {
        existing.prompt = `${existing.prompt}\n\n${row.prompt}`;
      }
    } else {
      const planned: PlannedInbox = {
        workspaceId: row.workspaceId,
        memberSlug: row.memberSlug,
        trigger: 'launch-catchup',
        prompt: row.prompt,
        scheduleIds: [row.id],
        missedOccurrences: missed,
      };
      grouped.set(key, planned);
      inbox.push(planned);
    }
  }
  return { inbox, updates };
}

// ─── Self-scheduling bounds ───────────────────────────────────────────────

export interface SelfScheduleCheckInput {
  /** The proposed spec. */
  spec: CrewScheduleSpec;
  /** Every other enabled schedule the member would still have after the change. */
  otherSpecs: readonly CrewScheduleSpec[];
  shiftsPerDay: number;
  quietHours?: string;
  nowMs: number;
  timeZone: string;
}

export type SelfScheduleVerdict = { ok: true } | { ok: false; reason: string };

/**
 * A member may move and add runs, but may not schedule inside quiet hours and
 * may not exceed `shiftsPerDay` on any of the next seven local days.
 */
export function checkSelfSchedule(input: SelfScheduleCheckInput): SelfScheduleVerdict {
  const { spec, timeZone, nowMs, quietHours, shiftsPerDay } = input;
  if (spec.at !== undefined) {
    const at = Date.parse(spec.at);
    if (!Number.isFinite(at)) return { ok: false, reason: `"${spec.at}" is not a valid time.` };
    if (at <= nowMs) return { ok: false, reason: 'A one-off wake must be in the future.' };
  }
  const horizonStart = startOfLocalDay(nowMs, timeZone);
  const horizonEnd = zonedWallTimeToInstant(addLocalDays(localDateOf(nowMs, timeZone), 7), 0, 0, timeZone);

  const ownRuns = runsBetween(spec, Math.max(nowMs, horizonStart), horizonEnd, timeZone, shiftsPerDay * 8 + 1);
  if (spec.interval === undefined && spec.at === undefined && ownRuns.length === 0) {
    return { ok: false, reason: 'The schedule never runs.' };
  }
  const quietRun = ownRuns.find((run) => isInQuietHours(run, quietHours, timeZone));
  if (quietRun !== undefined) {
    return { ok: false, reason: `Runs inside quiet hours (${quietHours}).` };
  }

  const perDay = new Map<number, number>();
  const count = (run: number) => {
    const day = startOfLocalDay(run, timeZone);
    perDay.set(day, (perDay.get(day) ?? 0) + 1);
  };
  ownRuns.forEach(count);
  for (const other of input.otherSpecs) {
    runsBetween(other, horizonStart, horizonEnd, timeZone, shiftsPerDay * 8 + 1).forEach(count);
  }
  for (const [day, runs] of perDay) {
    if (runs > shiftsPerDay) {
      const date = localDateOf(day + HOUR_MS * 12, timeZone);
      return {
        ok: false,
        reason: `Would schedule ${runs} runs on ${date.year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}; the limit is ${shiftsPerDay} per day.`,
      };
    }
  }
  return { ok: true };
}

const WEEKDAY_SET = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];

/** Plain-language schedule, e.g. "Weekdays at 09:00" or "Once, Sep 28 15:00". */
export function describeSchedule(spec: CrewScheduleSpec, timeZone: string): string {
  if (spec.at !== undefined) {
    const at = Date.parse(spec.at);
    if (!Number.isFinite(at)) return `Once, at ${spec.at}`;
    const text = new Intl.DateTimeFormat('en-US', {
      timeZone, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).format(new Date(at));
    return `Once, ${text}`;
  }
  if (spec.interval !== undefined) {
    const minutes = spec.interval.minutes;
    return minutes % 60 === 0 ? `Every ${minutes / 60} h` : `Every ${minutes} min`;
  }
  if (spec.weekly !== undefined) {
    const days = spec.weekly.days;
    const label = days.length === 5 && WEEKDAY_SET.every((day) => days.includes(day as CrewWeekday))
      ? 'Weekdays'
      : days.length === 7
        ? 'Every day'
        : days.map((day) => day.slice(0, 1).toUpperCase() + day.slice(1, 3)).join(', ');
    return `${label} at ${spec.weekly.time}`;
  }
  return `Daily at ${spec.daily}`;
}

export const CREW_TIME = { MINUTE_MS, HOUR_MS, DAY_MS } as const;
