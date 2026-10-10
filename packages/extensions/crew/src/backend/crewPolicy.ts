/**
 * Pure Crew decisions: budget verdicts, chapter roll, whether a member's held
 * wakes should start a shift now, the notification ladder, roster status, and
 * the prompts a shift sends. No timers, no host calls, no files.
 */

import type {
  CrewLevel,
  CrewUsageSource,
  CrewMemberDefinition,
  CrewMemberStatus,
  CrewShiftTrigger,
  CrewUsageSummary,
} from '../shared/types';
import { CREW_TIME, isInQuietHours, nextLocalMidnight, quietHoursEnd } from './crewTime';

export const CREW_POLICY = {
  /** Coalescing window for wakes that arrive in bursts (delegated sessions settling). */
  COALESCE_WINDOW_MS: 10 * CREW_TIME.MINUTE_MS,
  /** A chapter rolls after this long even if its context is small. */
  CHAPTER_MAX_AGE_MS: 7 * CREW_TIME.DAY_MS,
  /** A chapter rolls once measured context crosses this fraction of the window. */
  CHAPTER_CONTEXT_ROLL_FRACTION: 0.7,
  /** Rolling-window caps are rechecked this often while a member waits. */
  ROLLING_RECHECK_MS: CREW_TIME.HOUR_MS,
  /**
   * Crew-wide rolling seven-day cap (all tokens) until it is user-configurable.
   * Slightly above the six starter members' caps combined (560M), so it only
   * binds when the whole crew runs away at once.
   */
  DEFAULT_CREW_TOKENS_PER_WEEK: 600_000_000,
} as const;

// ─── Budget ───────────────────────────────────────────────────────────────

export interface BudgetInput {
  memberTokensWeek: number;
  memberTokensToday: number;
  shiftsToday: number;
  tokensPerWeek: number;
  shiftsPerDay: number;
  crewTokensWeek: number;
  crewTokensPerWeek: number;
  nowMs: number;
  timeZone: string;
}

export type BudgetReason = 'weekly-tokens' | 'daily-tokens' | 'shifts-per-day' | 'crew-weekly-tokens';

export interface BudgetVerdict {
  overBudget: boolean;
  reasons: BudgetReason[];
  dailyCeiling: number;
  /** When a waiting member should be rechecked; null when within budget. */
  retryAtMs: number | null;
}

/** The daily ceiling is derived, never stored: a third of the weekly cap. */
export function dailyCeilingFor(tokensPerWeek: number): number {
  return Math.floor(tokensPerWeek / 3);
}

export function computeBudgetVerdict(input: BudgetInput): BudgetVerdict {
  const dailyCeiling = dailyCeilingFor(input.tokensPerWeek);
  const reasons: BudgetReason[] = [];
  if (input.memberTokensWeek >= input.tokensPerWeek) reasons.push('weekly-tokens');
  if (input.memberTokensToday >= dailyCeiling) reasons.push('daily-tokens');
  if (input.shiftsToday >= input.shiftsPerDay) reasons.push('shifts-per-day');
  if (input.crewTokensWeek >= input.crewTokensPerWeek) reasons.push('crew-weekly-tokens');
  if (reasons.length === 0) {
    return { overBudget: false, reasons, dailyCeiling, retryAtMs: null };
  }
  // A calendar-day cap clears at local midnight; a rolling-week cap clears as
  // old usage ages out, which only a recheck can see.
  const rolling = reasons.includes('weekly-tokens') || reasons.includes('crew-weekly-tokens');
  const midnight = nextLocalMidnight(input.nowMs, input.timeZone);
  const retryAtMs = rolling
    ? Math.min(input.nowMs + CREW_POLICY.ROLLING_RECHECK_MS, midnight)
    : midnight;
  return { overBudget: true, reasons, dailyCeiling, retryAtMs };
}

export function describeBudgetReasons(reasons: readonly BudgetReason[]): string {
  const text: Record<BudgetReason, string> = {
    'weekly-tokens': 'weekly token budget used',
    'daily-tokens': "today's token ceiling reached",
    'shifts-per-day': "today's shift limit reached",
    'crew-weekly-tokens': "the crew's weekly token budget used",
  };
  return reasons.map((reason) => text[reason]).join('; ');
}

export function buildUsageSummary(input: BudgetInput, verdict: BudgetVerdict, source: CrewUsageSource): CrewUsageSummary {
  return {
    source,
    tokensThisWeek: input.memberTokensWeek,
    tokensToday: input.memberTokensToday,
    tokensPerWeekLimit: input.tokensPerWeek,
    dailyCeiling: verdict.dailyCeiling,
    shiftsToday: input.shiftsToday,
    shiftsPerDayLimit: input.shiftsPerDay,
    overBudget: verdict.overBudget,
    ...(verdict.overBudget ? { overBudgetReason: describeBudgetReasons(verdict.reasons) } : {}),
  };
}

// ─── Chapters ─────────────────────────────────────────────────────────────

export interface ChapterRollInput {
  chapterStartedAtMs: number;
  nowMs: number;
  contextTokens?: number | null;
  contextWindow?: number | null;
}

export type ChapterRollVerdict =
  | { roll: false }
  | { roll: true; reason: 'age' | 'context'; detail: string };

/**
 * A chapter ends when it is a week old or when measured context crosses 70%
 * of the window. There is no compaction step.
 */
export function decideChapterRoll(input: ChapterRollInput): ChapterRollVerdict {
  const tokens = input.contextTokens ?? 0;
  const window = input.contextWindow ?? 0;
  if (window > 0 && tokens / window >= CREW_POLICY.CHAPTER_CONTEXT_ROLL_FRACTION) {
    return {
      roll: true,
      reason: 'context',
      detail: `context is ${Math.round((tokens / window) * 100)}% full`,
    };
  }
  const ageMs = input.nowMs - input.chapterStartedAtMs;
  if (ageMs >= CREW_POLICY.CHAPTER_MAX_AGE_MS) {
    return { roll: true, reason: 'age', detail: `chapter is ${Math.floor(ageMs / CREW_TIME.DAY_MS)} days old` };
  }
  return { roll: false };
}

// ─── Dispatch ─────────────────────────────────────────────────────────────

/** Triggers that arrive in bursts and wait out the coalescing window. */
const COALESCED_TRIGGERS: ReadonlySet<CrewShiftTrigger> = new Set(['child-session']);

export interface PendingWakeSummary {
  trigger: CrewShiftTrigger;
  createdAtMs: number;
  urgent?: boolean;
}

export interface DispatchInput {
  pending: readonly PendingWakeSummary[];
  onShift: boolean;
  paused: boolean;
  quietHours?: string;
  budget: BudgetVerdict;
  nowMs: number;
  timeZone: string;
  coalesceWindowMs?: number;
}

export type DispatchDecision =
  | { action: 'none' }
  | { action: 'start' }
  | { action: 'defer'; untilMs: number; reason: 'quiet-hours' | 'coalescing' | 'over-budget' }
  | { action: 'blocked'; reason: 'paused' | 'on-shift' };

/**
 * Whether a member's held wakes should become a shift now.
 *
 * - One shift at a time: wakes arriving mid-shift join the running shift.
 * - The user asking directly starts a shift regardless of quiet hours and
 *   budget; they are awake and are choosing to spend.
 * - Quiet hours hold everything else until the window ends, except an urgent
 *   wake (see `isUrgentChildUpdate`), which also skips coalescing.
 * - Caps are checked here, at shift start, never mid-shift.
 * - Bursty wakes wait until the oldest has aged past the window, so twenty
 *   finished sessions produce one shift. Any other wake starts now.
 */
export function decideDispatch(input: DispatchInput): DispatchDecision {
  if (input.pending.length === 0) return { action: 'none' };
  if (input.onShift) return { action: 'blocked', reason: 'on-shift' };
  if (input.paused) return { action: 'blocked', reason: 'paused' };
  if (input.pending.some((event) => event.trigger === 'user')) return { action: 'start' };
  const urgent = input.pending.some((event) => event.urgent === true);

  const quietEnd = urgent ? null : quietHoursEnd(input.nowMs, input.quietHours, input.timeZone);
  if (quietEnd !== null) return { action: 'defer', untilMs: quietEnd, reason: 'quiet-hours' };

  if (input.budget.overBudget && input.budget.retryAtMs !== null) {
    return { action: 'defer', untilMs: input.budget.retryAtMs, reason: 'over-budget' };
  }

  const windowMs = input.coalesceWindowMs ?? CREW_POLICY.COALESCE_WINDOW_MS;
  const allCoalesced = input.pending.every((event) => COALESCED_TRIGGERS.has(event.trigger));
  if (allCoalesced && !urgent) {
    const oldest = Math.min(...input.pending.map((event) => event.createdAtMs));
    if (oldest + windowMs > input.nowMs) {
      return { action: 'defer', untilMs: oldest + windowMs, reason: 'coalescing' };
    }
  }
  return { action: 'start' };
}

/** The trigger a coalesced shift reports: the most deliberate one present. */
export function primaryTrigger(triggers: readonly CrewShiftTrigger[]): CrewShiftTrigger {
  const order: CrewShiftTrigger[] = ['user', 'self', 'schedule', 'launch-catchup', 'child-session'];
  return order.find((trigger) => triggers.includes(trigger)) ?? 'schedule';
}

// ─── Notification ladder ──────────────────────────────────────────────────

const LEVEL_RANK: Record<CrewLevel, number> = { note: 0, flag: 1, page: 2, ask: 3 };

export interface FlagDelivery {
  /** Level recorded in the journal: requested, capped by `maxLevel`. */
  level: CrewLevel;
  osNotification: boolean;
  mobilePush: boolean;
}

/**
 * note: feed only. flag: + OS notification. page: + phone push. `maxLevel`
 * caps the level; quiet hours reduce delivery to the feed without lowering the
 * recorded level. (An ask is the chapter's own AskUserQuestion and does not go
 * through here; a `maxLevel` of `ask` allows everything up to page.)
 */
export function resolveFlagDelivery(
  requested: CrewLevel,
  maxLevel: CrewLevel,
  inQuietHours: boolean,
): FlagDelivery {
  const level: CrewLevel = requested === 'ask' || LEVEL_RANK[requested] <= LEVEL_RANK[maxLevel]
    ? requested
    : maxLevel;
  const tier = level === 'ask' ? Math.min(LEVEL_RANK.flag, LEVEL_RANK[maxLevel]) : LEVEL_RANK[level];
  if (inQuietHours) return { level, osNotification: false, mobilePush: false };
  return { level, osNotification: tier >= LEVEL_RANK.flag, mobilePush: tier >= LEVEL_RANK.page };
}

export function flagDeliveryAt(
  requested: CrewLevel,
  member: Pick<CrewMemberDefinition, 'notify'>,
  nowMs: number,
  timeZone: string,
): FlagDelivery {
  return resolveFlagDelivery(
    requested,
    member.notify.maxLevel,
    isInQuietHours(nowMs, member.notify.quietHours, timeZone),
  );
}

/**
 * A delegated session's settle wakes the member through quiet hours only when
 * the session is blocked on the user and the member may page. Everything else
 * waits for morning like any other shift.
 */
export function isUrgentChildUpdate(
  outcome: 'completed' | 'error' | 'waiting' | 'interrupted',
  maxLevel: CrewLevel,
): boolean {
  return outcome === 'waiting' && LEVEL_RANK[maxLevel] >= LEVEL_RANK.page;
}

// ─── Roster status ────────────────────────────────────────────────────────

export interface StatusInput {
  definitionErrors: readonly string[];
  paused: boolean;
  onShift: boolean;
  waitingOnUser: boolean;
  overBudget: boolean;
  nextRunAtMs: number | null;
  nowMs: number;
  timeZone: string;
}

export function deriveMemberStatus(input: StatusInput): { status: CrewMemberStatus; detail: string } {
  if (input.definitionErrors.length > 0) {
    return { status: 'error', detail: `Definition file has errors: ${input.definitionErrors.join('; ')}` };
  }
  if (input.paused) return { status: 'paused', detail: 'Paused' };
  if (input.waitingOnUser) return { status: 'waiting-on-user', detail: 'Waiting on you' };
  if (input.onShift) return { status: 'on-shift', detail: 'On shift' };
  if (input.overBudget) return { status: 'over-budget', detail: 'Over budget' };
  if (input.nextRunAtMs !== null) {
    return { status: 'sleeping', detail: `Sleeping until ${formatWhen(input.nextRunAtMs, input.nowMs, input.timeZone)}` };
  }
  return { status: 'idle', detail: 'Idle' };
}

function formatWhen(instantMs: number, nowMs: number, timeZone: string): string {
  const time = new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(new Date(instantMs));
  if (instantMs - nowMs < CREW_TIME.DAY_MS && nextLocalMidnight(nowMs, timeZone) > instantMs) return time;
  const day = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(new Date(instantMs));
  return `${day} ${time}`;
}

// ─── Prompts ──────────────────────────────────────────────────────────────

export function formatLocalStamp(instantMs: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'short',
  }).format(new Date(instantMs));
}

const TRIGGER_LABEL: Record<CrewShiftTrigger, string> = {
  user: 'the user',
  schedule: 'your schedule',
  self: 'a wake you scheduled',
  'child-session': 'a session you delegated',
  'launch-catchup': 'a schedule missed while Nimbalyst was closed',
};

export interface ShiftWake {
  trigger: CrewShiftTrigger;
  prompt: string;
}

export interface ShiftPromptInput {
  member: Pick<CrewMemberDefinition, 'name' | 'slug'>;
  wakes: readonly ShiftWake[];
  nowMs: number;
  timeZone: string;
  /** Set on the first shift of a chapter: the member starts clean from its memory. */
  chapterStart?: { chapterIndex: number; notes: string; notesRevision: string; recentJournal: string };
}

/** One prompt for a shift, with every coalesced wake listed once. */
export function buildShiftPrompt(input: ShiftPromptInput): string {
  const lines: string[] = [];
  lines.push(`[Crew shift] ${formatLocalStamp(input.nowMs, input.timeZone)}`);
  const seen = new Set<string>();
  const items: string[] = [];
  for (const wake of input.wakes) {
    const prompt = wake.prompt.trim();
    const key = `${wake.trigger}\u001f${prompt}`;
    if (!prompt || seen.has(key)) continue;
    seen.add(key);
    items.push(`- From ${TRIGGER_LABEL[wake.trigger]}: ${prompt}`);
  }
  if (items.length === 1) {
    lines.push(`Woken by ${items[0].slice(7)}`);
  } else if (items.length > 1) {
    lines.push('Your inbox for this shift:', ...items);
  }

  if (input.chapterStart) {
    const { chapterIndex, notes, notesRevision, recentJournal } = input.chapterStart;
    lines.push(
      '',
      `This is the first shift of chapter ${chapterIndex}. Your earlier conversation is not in context; your notes and recent journal are below.`,
      '',
      `## Your notes (nimbalyst-local/crew/${input.member.slug}/notes.md, revision ${notesRevision})`,
      notes.trim() || '(empty)',
      '',
      '## Recent journal',
      recentJournal.trim() || '(no entries yet)',
    );
  }
  lines.push(
    '',
    'When the work for this shift is done, end with a short summary of what you did and what is still open. That summary becomes your journal entry.',
  );
  return lines.join('\n');
}

/** A wake that arrives while the member is already on shift, queued into the chapter. */
export function buildMidShiftPrompt(wake: ShiftWake): string {
  return `[Crew] From ${TRIGGER_LABEL[wake.trigger]}: ${wake.prompt.trim()}`;
}

export function buildHandoffPrompt(chapterIndex: number, detail: string): string {
  return [
    `[Crew chapter ending] Chapter ${chapterIndex} is closing (${detail}). Your next shift starts a fresh conversation that sees only your notes and recent journal.`,
    'Reply with a handoff summary for your future self: standing concerns, open threads, commitments you made, and anything you learned about how the user wants you to work. It is appended to your notes. Do not start new work.',
  ].join('\n\n');
}
