/**
 * The daily-active heartbeat: at most one `daily_active` event per install per
 * local calendar day, emitted only when a human is actually at the app.
 *
 * Why this exists
 * ---------------
 * DAU used to be read off "any event at all", which stopped meaning anything
 * once the ingestion allow-list landed (see `posthogIngestAllowList.ts`). Two
 * separate problems showed up when that number was measured properly:
 *
 *  1. No surviving event covers the active population. `nimbalyst_session_start`
 *     fires on launch, and people leave Nimbalyst running for days, so it
 *     reaches barely half of the humans who use the app on a given day. Even
 *     ingesting every sampled event at 100% tops out around 82% coverage, for
 *     roughly ten times this event's volume.
 *  2. The old number was inflated. Roughly a third of weekday "DAU" — and MORE
 *     than half on weekends — were installs whose only events that day came
 *     from the auto-updater polling in the background. Nobody was there.
 *
 * So the heartbeat is deliberately gated on human presence rather than on the
 * process being alive: an idle install that nobody has touched is not a daily
 * active user, and counting it as one is what produced the inflated baseline.
 *
 * One event per user per day is also the cheapest place in the whole schema to
 * carry slow-moving dimensions (version, platform, install age) — they cost
 * nothing extra here and make DAU segmentable without a second event.
 */

import { bucketDaysSinceInstall } from './launchAttribution';

export interface DailyActiveState {
  /** Local calendar date, `YYYY-MM-DD`, of the last emitted heartbeat. */
  lastDailyActiveDate?: string;
}

export interface DailyActiveDecision {
  shouldEmit: boolean;
  /** What to persist back. Only meaningful when `shouldEmit` is true. */
  next: Required<DailyActiveState>;
  /** The local date this decision resolved to. */
  localDate: string;
}

/**
 * The local calendar date, as `YYYY-MM-DD`.
 *
 * Local rather than UTC or the project's timezone on purpose: the question is
 * "did this person use Nimbalyst today", and "today" is the user's day. A user
 * far from the project timezone still emits exactly one heartbeat per day of
 * their own, which is what a daily count needs; only the bucket boundary they
 * land in shifts, and that is inherent to any DAU metric over a global userbase.
 */
export function localDateKey(now: Date): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Decide whether this install still owes a heartbeat today, as a pure function
 * of (stored state, now).
 *
 * Pure for the same reason `decideLaunch` is: everything interesting here
 * happens on the SECOND call — the same day must not re-emit, a later day must,
 * and a clock that moved backwards must not wedge the install into never
 * emitting again. None of that is reachable by starting a real app once.
 */
export function decideDailyActive(stored: DailyActiveState, now: Date): DailyActiveDecision {
  const localDate = localDateKey(now);
  // A plain inequality, not `>`. If the stored date is in the future — a clock
  // that was wrong and got corrected, or a timezone move westward — comparing
  // with `>` would suppress the heartbeat until real time caught up, which for
  // a badly wrong clock could be months of silence from a live install.
  const shouldEmit = stored.lastDailyActiveDate !== localDate;

  return {
    shouldEmit,
    next: { lastDailyActiveDate: localDate },
    localDate,
  };
}

/** The parts of an Electron `BrowserWindow` this decision actually needs. */
export interface WindowPresence {
  isDestroyed(): boolean;
  isFocused(): boolean;
}

/**
 * Whether a human is plausibly at the machine right now.
 *
 * This is THE guard that keeps the heartbeat honest, and it lives here rather
 * than inline at the timer so it can be tested without an Electron app. Drop it
 * and the periodic tick fires for every install whose process happens to be
 * alive -- which is precisely the population that inflated the old DAU by a
 * third on weekdays and more than half on weekends.
 *
 * `isDestroyed()` is checked first because calling `isFocused()` on a destroyed
 * window throws, and a throw inside the interval would silently kill the
 * day-rollover catch for the rest of the process's life.
 */
export function hasFocusedWindow(windows: readonly WindowPresence[]): boolean {
  return windows.some((w) => !w.isDestroyed() && w.isFocused());
}

export interface DailyActiveProperties {
  nimbalyst_version: string;
  platform: string;
  days_since_install: string;
  local_date: string;
  $set: {
    nimbalyst_version: string;
    cpu_arch: string;
    last_session_at: string;
    has_nimbalyst_session: true;
  };
}

/**
 * The heartbeat's payload. Bucketed install age rather than a raw date, matching
 * `nimbalyst_session_start` — a precise install timestamp is close to a unique
 * key on a small cohort.
 *
 * The `$set` block is deliberate, not incidental. All four of those person
 * properties rode on events the ingestion allow-list now drops or samples:
 * `nimbalyst_version` and `cpu_arch` fell to ~10% because their only carrier was
 * the sampled `nimbalyst_session_start` (so "what version is the fleet on"
 * silently became a 12.5% estimate), and `last_session_at` /
 * `has_nimbalyst_session` went to zero with the `$set` event on 2026-09-04.
 *
 * A once-a-day event is the right home for all four: they change slowly, "last
 * session" at day granularity is what anyone actually asks for, and riding here
 * costs nothing because the event already ships. Person properties are the part
 * of the schema an event allow-list cannot describe, so they need a deliberate
 * carrier rather than whichever event happened to be passing.
 */
export function dailyActiveProperties(input: {
  version: string;
  platform: string;
  cpuArch: string;
  daysSinceInstall: number;
  localDate: string;
  nowIso: string;
}): DailyActiveProperties {
  return {
    nimbalyst_version: input.version,
    platform: input.platform,
    days_since_install: bucketDaysSinceInstall(input.daysSinceInstall),
    local_date: input.localDate,
    $set: {
      nimbalyst_version: input.version,
      cpu_arch: input.cpuArch,
      last_session_at: input.nowIso,
      has_nimbalyst_session: true,
    },
  };
}
