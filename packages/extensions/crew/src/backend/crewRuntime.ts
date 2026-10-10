/**
 * Crew's per-workspace runtime: the scheduler, the shift runner, chapters,
 * delegated-session wakes, flags, budgets, and self-scheduling. One instance
 * per backend activation (the host activates the module once per open
 * workspace).
 *
 * State ownership:
 * - Definitions and schedules: the definition files (read fresh on every tick).
 * - Chapters, shift history, last run: owner metadata on the member's sessions
 *   (see crewChapters.ts), read through `sessions.listOwned`.
 * - History and the feed: journal.md.
 * - Token budgets: the usage ledger file (crewLedger.ts) in the data dir.
 * - In memory only: the shift in progress, wakes held back by quiet hours,
 *   coalescing, or budget, and how far the schedule has been processed. The
 *   last two are also cached in the extension's data dir so a restart does not
 *   drop a held wake; the cache is never the source of truth.
 *
 * The host runs this module while the project is open, so "missed runs"
 * covers the project being closed as well as the app: each activation's first
 * tick collapses whatever was missed into one catch-up shift per member.
 *
 * One shift at a time per member. A wake that arrives mid-shift is queued into
 * the current chapter (the chapter's queued prompts are the inbox); a wake that
 * arrives between shifts is held until dispatch rules allow a shift.
 */

import type {
  CrewEvidenceRef,
  CrewLevel,
  CrewMemberDefinition,
  CrewScheduleEntry,
  CrewScheduleSpec,
  CrewShiftTrigger,
  CrewUsageSource,
} from '../shared/types';
import {
  CREW_POLICY,
  buildHandoffPrompt,
  buildMidShiftPrompt,
  buildShiftPrompt,
  computeBudgetVerdict,
  decideChapterRoll,
  decideDispatch,
  describeBudgetReasons,
  flagDeliveryAt,
  formatLocalStamp,
  isUrgentChildUpdate,
  primaryTrigger,
  type BudgetInput,
  type BudgetVerdict,
  type ShiftWake,
} from './crewPolicy';
import {
  CREW_TIME,
  checkSelfSchedule,
  computeNextRunAt,
  describeSchedule,
  isInQuietHours,
  planDueSchedules,
  startOfLocalDay,
} from './crewTime';
import { isValidCrewSlug, sessionModelId, validateScheduleSpec } from './crewDefinition';
import * as crewFiles from './crewFiles';
import { appendCrewJournal, type JournalEntryInput } from './crewJournal';
import { buildCrewDirective, definitionHash } from './crewDirective';
import {
  countSince,
  indexMemberSessions,
  nextChapterIndex,
  shiftStartPatch,
  type MemberSessions,
} from './crewChapters';
import {
  LEDGER_RETENTION_MS,
  emptyLedger,
  ledgerCovers,
  ledgerSum,
  parseLedger,
  pruneLedger,
  recordSnapshot,
  type LedgerData,
} from './crewLedger';
import type { HostSessions, SessionSettledEvent, SettledOutcome } from './hostSessions';

/** Re-read definitions at least this often so file edits reach the scheduler. */
const MAX_TIMER_MS = 5 * CREW_TIME.MINUTE_MS;
const RESULT_EXCERPT_CHARS = 2_000;
const DEFAULT_USER_SHIFT_PROMPT = 'The user started this shift. Check in on your job and do what is most useful now.';

export interface HeldWake extends ShiftWake {
  createdAtMs: number;
  urgent?: boolean;
  sourceSessionId?: string;
}

interface ActiveShift {
  slug: string;
  trigger: CrewShiftTrigger;
  startedAtMs: number;
  phase: 'starting' | 'work' | 'handoff';
  chapterSessionId?: string;
  chapterIndex?: number;
  chapterStartedAtMs?: number;
  advancing: boolean;
  rollDetail?: string;
}

interface MemberState {
  held: HeldWake[];
  shift?: ActiveShift;
  /** Where schedule entries without their own anchor start from (new entries, first launch). */
  firedThroughMs?: number;
  /** Per schedule entry (by timing): the instant its next run is computed from. */
  entryAnchors: Record<string, number>;
  deferredUntilMs?: number;
  waitingOnUser: boolean;
  /** Local day (start-of-day ms) an over-budget note was last journaled for. */
  budgetNotedDayMs?: number;
}

export interface CrewRuntimeCache {
  firedThrough: Record<string, number>;
  held: Record<string, HeldWake[]>;
  /** Per member, per schedule entry timing: see MemberState.entryAnchors. */
  anchors?: Record<string, Record<string, number>>;
  /** When this runtime last saved; delegated sessions that settled after it were missed while stopped. */
  lastAliveMs?: number;
  /** Per member slug, and `*` for the crew feed: flags at or before this instant have been seen. */
  seenThrough?: Record<string, number>;
}

/** `seenThrough` key for "the user viewed the whole feed". */
const SEEN_ALL = '*';

/** Identity of a schedule entry by its timing, so an edited prompt keeps its anchor. */
function scheduleTimingKey(spec: CrewScheduleSpec): string {
  return JSON.stringify([spec.daily ?? null, spec.weekly ?? null, spec.interval ?? null, spec.at ?? null]);
}

export interface CrewRuntimeDeps {
  workspacePath: string;
  sessions: HostSessions;
  now?: () => number;
  timeZone?: () => string;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  log?: (level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
  cache?: { load(): Promise<CrewRuntimeCache | null>; save(cache: CrewRuntimeCache): Promise<void> };
  /** The usage ledger file. `load` resolves null when there is none yet; `setAside` moves a damaged one out of the way. */
  ledger?: { load(): Promise<unknown | null>; save(data: LedgerData): Promise<void>; setAside(): Promise<string | null> };
  crewTokensPerWeek?: number;
}

/** `handoff`: the current chapter is closing first; the wakes run in its successor. */
interface DispatchResult {
  chapterSessionId: string;
  chapterIndex: number;
  handoff?: boolean;
}

export interface MemberUsage {
  input: BudgetInput;
  verdict: BudgetVerdict;
  /** Source of the weekly figure. */
  source: CrewUsageSource;
}

export interface FlagResult {
  level: Exclude<CrewLevel, 'ask'>;
  capped: boolean;
  delivered: 'feed' | 'desktop' | 'desktop-and-phone';
  quietHours: boolean;
}

export class CrewRuntime {
  private readonly members = new Map<string, MemberState>();
  private readonly dispatching = new Set<string>();
  /** Settles for sessions not yet known (a chapter whose first turn beat `create`'s return). */
  private readonly unclaimedSettles = new Map<string, SessionSettledEvent>();
  private ledger: LedgerData | null = null;
  private ledgerWrite: Promise<void> = Promise.resolve();
  /** Owned sessions created before the ledger started (see preLedgerActiveSince); null when unknown. */
  private preLedgerSessions: Array<{ sessionId: string; key: string; lastActivityMs: number }> | null = null;
  private timer: unknown = null;
  private unsubscribe: (() => void) | null = null;
  private started = false;
  private ticking = false;
  private tickAgain = false;
  private launched = false;
  private revisionValue = 1;
  /** See CrewRuntimeCache.seenThrough. Losing it only re-shows flags as unread. */
  private seenThrough: Record<string, number> = {};
  private lastReconcileMs = Number.NEGATIVE_INFINITY;
  private changeListener: (() => void) | null = null;

  constructor(private readonly deps: CrewRuntimeDeps) {}

  get workspacePath(): string {
    return this.deps.workspacePath;
  }

  get sessions(): HostSessions {
    return this.deps.sessions;
  }

  /** Bumped on every state change the panel can see. */
  get revision(): number {
    return this.revisionValue;
  }

  bump(): void {
    this.revisionValue += 1;
    this.changeListener?.();
  }

  /** Called after every revision bump (the gutter badge listens). One listener. */
  onChange(listener: (() => void) | null): void {
    this.changeListener = listener;
  }

  now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  timeZone(): string {
    return this.deps.timeZone?.() ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.loadLedger();
    const cached = await this.deps.cache?.load().catch(() => null);
    if (cached) {
      for (const [slug, ms] of Object.entries(cached.firedThrough ?? {})) this.state(slug).firedThroughMs = ms;
      for (const [slug, held] of Object.entries(cached.held ?? {})) this.state(slug).held = held;
      for (const [slug, anchors] of Object.entries(cached.anchors ?? {})) this.state(slug).entryAnchors = { ...anchors };
      this.seenThrough = { ...(cached.seenThrough ?? {}) };
    }
    this.unsubscribe = this.deps.sessions.onSettled((event) => {
      void this.onSettled(event).catch((error) => this.log('error', 'Crew settle handling failed', { event, error: String(error) }));
    });
    await this.catchUpMissedSettles(cached?.lastAliveMs).catch((error) =>
      this.log('warn', 'Crew could not check for sessions that settled while closed', { error: String(error) }));
    await this.tick();
  }

  /**
   * The host does not replay settle events for the time this module was
   * stopped (project closed). Delegated sessions that finished in that window
   * wake their member once, as a single coalesced wake in the current chapter.
   * Their usage is caught by the ledger reconcile at shift start. On a first
   * run there is no last-alive time, so nothing is assumed missed.
   */
  private async catchUpMissedSettles(lastAliveMs: number | undefined): Promise<void> {
    if (lastAliveMs === undefined) return;
    const members = await crewFiles.loadCrewMembers(this.workspacePath);
    for (const member of members) {
      if (member.errors.length > 0) continue;
      const sessions = await this.memberSessions(member.slug);
      const settled = sessions.delegated.filter((session) => session.status !== 'running' && session.updatedAt > lastAliveMs);
      if (settled.length === 0) continue;
      const lines = settled.map((session) => `- "${session.title}" (${session.sessionId}): ${session.status.replace(/_/g, ' ')}`);
      this.state(member.slug).held.push({
        trigger: 'child-session',
        prompt: `While Nimbalyst was closed, sessions you delegated settled:\n${lines.join('\n')}`,
        createdAtMs: this.now(),
        urgent: settled.some((session) => session.status === 'waiting_for_input')
          && isUrgentChildUpdate('waiting', member.definition.notify.maxLevel),
      });
      this.bump();
    }
  }

  stop(): void {
    this.started = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    void this.saveCache();
  }

  /** A definition or schedule changed: re-plan now rather than at the next timer. */
  async onDefinitionsChanged(): Promise<void> {
    this.bump();
    await this.tick();
  }

  // ─── Queries for the panel and tools ───────────────────────────────────

  /** The user viewed a member's desk, or (no slug) the whole feed. */
  async markSeen(slug?: string): Promise<number> {
    const now = this.now();
    this.seenThrough[slug ?? SEEN_ALL] = now;
    this.bump();
    await this.saveCache();
    return now;
  }

  /** Flags at or before this instant have been seen for `slug`. */
  seenThroughMs(slug: string): number {
    return Math.max(this.seenThrough[slug] ?? 0, this.seenThrough[SEEN_ALL] ?? 0);
  }

  memberState(slug: string): Readonly<{
    onShift: boolean;
    shiftStartedAtMs?: number;
    shiftTrigger?: CrewShiftTrigger;
    heldCount: number;
    waitingOnUser: boolean;
    deferredUntilMs?: number;
  }> {
    const state = this.state(slug);
    return {
      onShift: state.shift !== undefined,
      ...(state.shift ? { shiftStartedAtMs: state.shift.startedAtMs, shiftTrigger: state.shift.trigger } : {}),
      heldCount: state.held.length,
      waitingOnUser: state.waitingOnUser,
      ...(state.deferredUntilMs !== undefined ? { deferredUntilMs: state.deferredUntilMs } : {}),
    };
  }

  async memberSessions(slug: string): Promise<MemberSessions> {
    return indexMemberSessions(await this.deps.sessions.listOwned({ key: slug }));
  }

  /** The reference instant schedules are computed from: last processed, else last run, else now. */
  private scheduleAnchor(slug: string, lastRunAtMs: number | null): number {
    return this.state(slug).firedThroughMs ?? lastRunAtMs ?? this.now();
  }

  scheduleEntries(definition: CrewMemberDefinition, lastRunAtMs: number | null): CrewScheduleEntry[] {
    const fallback = this.scheduleAnchor(definition.slug, lastRunAtMs);
    const anchors = this.state(definition.slug).entryAnchors;
    return definition.schedule.map((spec, index) => {
      const anchor = anchors[scheduleTimingKey(spec)] ?? fallback;
      const next = spec.enabled === false ? null : computeNextRunAt(spec, anchor, this.timeZone());
      return {
        index,
        spec,
        ...(next !== null ? { nextRunAt: new Date(next).toISOString() } : {}),
        description: describeSchedule(spec, this.timeZone()),
      };
    });
  }

  nextRunAtMs(definition: CrewMemberDefinition, lastRunAtMs: number | null): number | null {
    const candidates = this.scheduleEntries(definition, lastRunAtMs)
      .map((entry) => (entry.nextRunAt ? Date.parse(entry.nextRunAt) : null))
      .filter((ms): ms is number => ms !== null);
    const deferred = this.state(definition.slug).deferredUntilMs;
    if (deferred !== undefined && this.state(definition.slug).held.length > 0) candidates.push(deferred);
    return candidates.length > 0 ? Math.min(...candidates) : null;
  }

  async usage(definition: CrewMemberDefinition, sessions: MemberSessions): Promise<MemberUsage> {
    const now = this.now();
    const dayStartMs = startOfLocalDay(now, this.timeZone());
    const [week, today, crew] = await Promise.all([
      this.windowTokens(now - 7 * CREW_TIME.DAY_MS, definition.slug),
      this.windowTokens(dayStartMs, definition.slug),
      this.crewTokensWeek(),
    ]);
    const input: BudgetInput = {
      memberTokensWeek: week.tokens,
      memberTokensToday: today.tokens,
      shiftsToday: countSince(sessions.shiftStartsMs, dayStartMs),
      tokensPerWeek: definition.budget.tokensPerWeek,
      shiftsPerDay: definition.budget.shiftsPerDay,
      crewTokensWeek: crew.tokens,
      crewTokensPerWeek: this.crewTokensPerWeek(),
      nowMs: now,
      timeZone: this.timeZone(),
    };
    return { input, verdict: computeBudgetVerdict(input), source: week.source };
  }

  async crewTokensWeek(): Promise<{ tokens: number; source: CrewUsageSource }> {
    return this.windowTokens(this.now() - 7 * CREW_TIME.DAY_MS);
  }

  /**
   * Tokens since `sinceMs` for one member (or the whole crew): exact from the
   * ledger when it reaches back that far, otherwise the host's
   * session-granular totals, labeled as an estimate.
   */
  private async windowTokens(sinceMs: number, key?: string): Promise<{ tokens: number; source: CrewUsageSource }> {
    if (this.ledger && (ledgerCovers(this.ledger, sinceMs) || !this.preLedgerActiveSince(sinceMs, key))) {
      return { tokens: ledgerSum(this.ledger, sinceMs, key), source: 'ledger' };
    }
    const report = await this.deps.sessions.getUsage({ ...(key ? { key } : {}), since: sinceMs });
    return { tokens: report.totals.allTokens, source: 'session-estimate' };
  }

  /**
   * Whether a session older than the ledger was active since `sinceMs`. Only
   * such a session can hold usage the ledger never saw; a session created
   * after the ledger started is charged in full from its first record. Unknown
   * (the owned-session list failed to load) counts as active.
   */
  private preLedgerActiveSince(sinceMs: number, key?: string): boolean {
    if (this.preLedgerSessions === null) return true;
    return this.preLedgerSessions.some((session) =>
      (key === undefined || session.key === key)
      && (session.lastActivityMs >= sinceMs
        || this.ledger!.entries.some((entry) => entry.sessionId === session.sessionId && entry.atMs >= sinceMs)));
  }

  private async findPreLedgerSessions(): Promise<void> {
    const startedAtMs = this.ledger!.startedAtMs;
    try {
      const owned = await this.deps.sessions.listOwned();
      this.preLedgerSessions = owned
        .filter((session) => session.createdAt < startedAtMs)
        .map((session) => ({ sessionId: session.sessionId, key: session.key, lastActivityMs: session.updatedAt }));
    } catch (error) {
      this.preLedgerSessions = null;
      this.log('warn', 'Crew could not list sessions to check ledger coverage; usage is an estimate', { error: String(error) });
    }
  }

  // ─── Usage ledger ──────────────────────────────────────────────────────

  private async loadLedger(): Promise<void> {
    await this.loadLedgerFile();
    await this.findPreLedgerSessions();
  }

  private async loadLedgerFile(): Promise<void> {
    const store = this.deps.ledger;
    if (!store) {
      this.ledger = emptyLedger(this.now());
      return;
    }
    let raw: unknown;
    try {
      raw = await store.load();
    } catch (error) {
      raw = { unreadable: String(error) };
    }
    if (raw === null) {
      this.ledger = emptyLedger(this.now());
      return;
    }
    const dropped = { count: 0 };
    const parsed = parseLedger(raw, dropped);
    if (parsed) {
      if (dropped.count > 0) {
        this.log('warn', 'Crew usage ledger had malformed rows; dropped them and re-baselined those sessions', { dropped: dropped.count });
      }
      this.ledger = parsed;
      return;
    }
    // Keep the damaged file for inspection and start a new ledger. Budgets use
    // the host's session totals (shown as an estimate) for windows that
    // include activity of sessions older than the new ledger.
    const movedTo = await store.setAside().catch(() => null);
    this.log('error', 'Crew usage ledger was unreadable; started a new one', { movedTo });
    this.ledger = emptyLedger(this.now());
    await this.persistLedger();
  }

  /** Records a session's lifetime total; the growth since the last record is charged at `atMs`. */
  recordUsage(input: { sessionId: string; key: string; tokens: number; atMs: number }): void {
    if (!this.ledger || !recordSnapshot(this.ledger, input)) return;
    pruneLedger(this.ledger, this.now());
    this.bump();
    void this.persistLedger();
  }

  /**
   * Catches up sessions whose settles were missed (project closed) or that
   * never settle again. Covers every member's sessions in one call, not just
   * the member about to run: the crew-wide cap sums all of them, and a member
   * that never runs again would otherwise never be reconciled.
   */
  async reconcileUsage(options: { maxAgeMs?: number } = {}): Promise<void> {
    const now = this.now();
    if (options.maxAgeMs !== undefined && now - this.lastReconcileMs < options.maxAgeMs) return;
    const report = await this.deps.sessions.getUsage({ since: now - LEDGER_RETENTION_MS });
    this.lastReconcileMs = now;
    for (const row of report.sessions) {
      this.recordUsage({ sessionId: row.sessionId, key: row.key, tokens: row.allTokens, atMs: row.lastActivity });
    }
  }

  private persistLedger(): Promise<void> {
    const store = this.deps.ledger;
    if (!store || !this.ledger) return Promise.resolve();
    const snapshot = this.ledger;
    this.ledgerWrite = this.ledgerWrite
      .then(() => store.save(snapshot))
      .catch((error) => this.log('warn', 'Crew usage ledger save failed', { error: String(error) }));
    return this.ledgerWrite;
  }

  crewTokensPerWeek(): number {
    return this.deps.crewTokensPerWeek ?? CREW_POLICY.DEFAULT_CREW_TOKENS_PER_WEEK;
  }

  // ─── Shifts: user-facing ───────────────────────────────────────────────

  /** A user-started shift, or a prompt queued into the shift already running. */
  async startShift(slug: string, prompt?: string): Promise<{ outcome: 'started' | 'queued'; chapterSessionId: string; chapterIndex: number }> {
    const member = await this.requireRunnable(slug);
    const state = this.state(slug);
    const text = prompt?.trim() || DEFAULT_USER_SHIFT_PROMPT;
    const shift = state.shift;
    if (shift?.phase === 'work' && shift.chapterSessionId && shift.chapterIndex !== undefined) {
      await this.deps.sessions.sendPrompt(shift.chapterSessionId, text);
      this.bump();
      return { outcome: 'queued', chapterSessionId: shift.chapterSessionId, chapterIndex: shift.chapterIndex };
    }
    if (shift) throw new Error(`${member.name} is between chapters; try again in a moment`);
    const wake: HeldWake = { trigger: 'user', prompt: text, createdAtMs: this.now() };
    state.held.push(wake);
    try {
      const started = await this.tryDispatch(slug);
      if (started?.handoff) {
        // The user's request waits (held) for the closing chapter's handoff, then starts the next chapter.
        return { outcome: 'queued', chapterSessionId: started.chapterSessionId, chapterIndex: started.chapterIndex };
      }
      if (started) return { outcome: 'started', chapterSessionId: started.chapterSessionId, chapterIndex: started.chapterIndex };
    } catch (error) {
      // The user saw the failure; do not start their request later, unasked.
      state.held = state.held.filter((held) => held !== wake);
      throw error;
    }
    state.held = state.held.filter((held) => held !== wake);
    throw new Error(`${member.name}'s shift could not start right now; try again in a moment`);
  }

  /** Releases the member from its shift. A running turn is not interrupted. */
  async endShift(slug: string): Promise<boolean> {
    const shift = this.state(slug).shift;
    if (!shift || shift.phase === 'starting') return false;
    await this.journal(slug, {
      kind: 'shift',
      title: 'Shift ended by the user',
      body: 'The user released the member before it finished its shift.',
      trigger: shift.trigger,
      ...(shift.chapterIndex !== undefined ? { chapterIndex: shift.chapterIndex } : {}),
      ...(shift.chapterSessionId ? { sessionId: shift.chapterSessionId } : {}),
    });
    await this.finishShift(slug);
    return true;
  }

  // ─── Flags ─────────────────────────────────────────────────────────────

  /**
   * Raises something to the user through the ladder: the level is capped by
   * the member's `maxLevel`, quiet hours keep it in the feed, and every flag is
   * recorded in the journal whether or not a notification went out.
   */
  async flag(
    definition: CrewMemberDefinition,
    input: { level: CrewLevel; title: string; body: string; evidence?: CrewEvidenceRef[] },
    callerSessionId?: string,
  ): Promise<FlagResult> {
    if (input.level === 'ask') {
      throw new Error('To ask the user a question, use your AskUserQuestion tool with options; it reaches desktop and phone. crew_flag takes note, flag, or page.');
    }
    if (!input.title.trim()) throw new Error('A flag needs a title');
    const now = this.now();
    const delivery = flagDeliveryAt(input.level, definition, now, this.timeZone());
    const level = delivery.level === 'ask' ? 'flag' : delivery.level;
    const quietHours = isInQuietHours(now, definition.notify.quietHours, this.timeZone());
    await this.journal(definition.slug, {
      kind: 'flag',
      title: input.title,
      body: input.body,
      level,
      ...(input.evidence && input.evidence.length > 0 ? { evidence: input.evidence } : {}),
      ...(callerSessionId ? { sessionId: callerSessionId } : {}),
    });
    const sessionId = callerSessionId ?? this.state(definition.slug).shift?.chapterSessionId
      ?? (await this.memberSessions(definition.slug)).current?.session.sessionId;
    if ((delivery.osNotification || delivery.mobilePush) && !sessionId) {
      this.log('warn', 'Crew flag has no session to notify about; it is in the feed only', { slug: definition.slug });
    } else if (delivery.osNotification || delivery.mobilePush) {
      try {
        await this.deps.sessions.notifyUser({
          sessionId: sessionId!,
          title: `${definition.name}: ${input.title}`,
          body: input.body,
          urgency: delivery.mobilePush ? 'critical' : 'normal',
        });
      } catch (error) {
        // The flag is already in the journal and feed; only the tap on the shoulder is lost.
        this.log('warn', 'Crew flag notification failed', { slug: definition.slug, error: String(error) });
      }
    }
    return {
      level,
      capped: level !== input.level,
      delivered: delivery.mobilePush ? 'desktop-and-phone' : delivery.osNotification ? 'desktop' : 'feed',
      quietHours,
    };
  }

  async journal(slug: string, entry: Omit<JournalEntryInput, 'atMs'> & { atMs?: number }): Promise<void> {
    await appendCrewJournal(this.workspacePath, slug, { ...entry, atMs: entry.atMs ?? this.now() }, this.timeZone());
    this.bump();
  }

  // ─── Self-scheduling ───────────────────────────────────────────────────

  /**
   * A member changing its own schedule. Bounded by quiet hours and
   * shifts-per-day over the next week, written to the definition file (the
   * only schedule store), and logged to the journal.
   */
  async setScheduleByMember(
    definition: CrewMemberDefinition,
    change:
      | { action: 'add'; schedule: unknown; reason: string }
      | { action: 'replace'; index: number; schedule: unknown; reason: string }
      | { action: 'remove'; index: number; reason: string },
  ): Promise<CrewScheduleSpec[]> {
    if (!change.reason?.trim()) throw new Error('Say why you are changing your schedule (reason); it is shown to the user.');
    const current = definition.schedule;
    if (change.action !== 'add' && (!Number.isInteger(change.index) || change.index < 0 || change.index >= current.length)) {
      throw new Error(`No schedule entry at index ${String(change.index)}; crew_schedule_get lists them.`);
    }
    let next: CrewScheduleSpec[];
    let proposed: CrewScheduleSpec | null = null;
    if (change.action === 'remove') {
      next = current.filter((_, index) => index !== change.index);
    } else {
      const validated = validateScheduleSpec(change.schedule);
      if (!validated.ok) {
        throw new Error(`Invalid schedule: ${validated.errors.map((error) => `${error.path} ${error.message}`).join('; ')}`);
      }
      proposed = { ...validated.spec, createdBy: 'member' };
      next = change.action === 'add'
        ? [...current, proposed]
        : current.map((spec, index) => (index === change.index ? proposed! : spec));
    }
    if (proposed) {
      const verdict = checkSelfSchedule({
        spec: proposed,
        otherSpecs: next.filter((spec) => spec !== proposed && spec.enabled !== false),
        shiftsPerDay: definition.budget.shiftsPerDay,
        quietHours: definition.notify.quietHours,
        nowMs: this.now(),
        timeZone: this.timeZone(),
      });
      if (!verdict.ok) throw new Error(`Schedule not changed: ${verdict.reason}`);
    }
    await crewFiles.updateCrewMemberFile(this.workspacePath, definition.slug, (latest) => ({ ...latest, schedule: next }));
    const before = change.action === 'add' ? null : current[change.index];
    const describe = (spec: CrewScheduleSpec | null) => (spec ? `${describeSchedule(spec, this.timeZone())}: ${spec.prompt}` : '(none)');
    await this.journal(definition.slug, {
      kind: 'schedule-change',
      title: change.action === 'add' ? 'Added a run' : change.action === 'remove' ? 'Removed a run' : 'Moved a run',
      body: [`Reason: ${change.reason.trim()}`, `Before: ${describe(before)}`, `After: ${describe(proposed)}`].join('\n'),
    });
    await this.onDefinitionsChanged();
    return next;
  }

  /** A user edit from the panel: validated and written, not bounded or journaled. */
  async setScheduleByUser(slug: string, schedule: unknown[]): Promise<CrewScheduleSpec[]> {
    const specs: CrewScheduleSpec[] = [];
    schedule.forEach((raw, index) => {
      const validated = validateScheduleSpec(raw);
      if (!validated.ok) {
        throw new Error(`Schedule entry ${index + 1}: ${validated.errors.map((error) => `${error.path} ${error.message}`).join('; ')}`);
      }
      specs.push(validated.spec);
    });
    await crewFiles.updateCrewMemberFile(this.workspacePath, slug, (latest) => ({ ...latest, schedule: specs }));
    await this.onDefinitionsChanged();
    return specs;
  }

  // ─── Scheduler ─────────────────────────────────────────────────────────

  private async tick(): Promise<void> {
    if (!this.started) return;
    if (this.ticking) {
      this.tickAgain = true;
      return;
    }
    this.ticking = true;
    try {
      do {
        this.tickAgain = false;
        await this.runDue(!this.launched);
        this.launched = true;
      } while (this.tickAgain);
    } catch (error) {
      this.log('error', 'Crew tick failed', { error: String(error) });
    } finally {
      this.ticking = false;
    }
    await this.arm();
  }

  /**
   * Turns due schedule entries into held wakes and dispatches. At launch, all
   * of a member's missed runs collapse into one catch-up wake; a member asleep
   * for a week gets one shift, not seven.
   */
  private async runDue(atLaunch: boolean): Promise<void> {
    const now = this.now();
    const members = await crewFiles.loadCrewMembers(this.workspacePath);
    const touched = new Set<string>();
    for (const member of members) {
      const slug = member.slug;
      if (!isValidCrewSlug(slug)) continue;
      const state = this.state(slug);
      const runnable = member.errors.length === 0 && member.definition.paused !== true;
      if (state.firedThroughMs === undefined) {
        const lastRun = runnable ? (await this.memberSessions(slug).catch(() => null))?.lastRunAtMs ?? null : null;
        state.firedThroughMs = lastRun ?? now;
      }
      // Each entry keeps its own anchor until it fires. An interval is
      // anchored on its last run, so advancing a shared "processed through"
      // mark every tick would push a 15-minute interval forever out of reach.
      const anchors: Record<string, number> = {};
      const rows = member.definition.schedule.map((spec, index) => {
        const key = scheduleTimingKey(spec);
        const anchor = state.entryAnchors[key] ?? state.firedThroughMs!;
        anchors[key] = anchor;
        return {
          id: `${slug}#${index}`,
          workspaceId: this.workspacePath,
          memberSlug: slug,
          spec,
          prompt: spec.prompt,
          enabled: spec.enabled !== false,
          nextRunAtMs: computeNextRunAt(spec, anchor, this.timeZone()),
        };
      });
      const plan = planDueSchedules(rows, now, this.timeZone(), { atLaunch, isRunnable: () => runnable });
      for (const update of plan.updates) {
        anchors[scheduleTimingKey(member.definition.schedule[Number(update.id.split('#')[1])])] = now;
      }
      // Entries no longer in the file drop their anchors; new ones start from this tick.
      state.entryAnchors = anchors;
      state.firedThroughMs = now;
      for (const item of plan.inbox) {
        const specs = item.scheduleIds.map((id) => member.definition.schedule[Number(id.split('#')[1])]);
        const selfMade = specs.every((spec) => spec?.createdBy === 'member');
        state.held.push({
          trigger: item.trigger === 'schedule' && selfMade ? 'self' : item.trigger,
          prompt: item.missedOccurrences > 1 && item.trigger === 'launch-catchup'
            ? `${item.prompt}\n\n(Nimbalyst was closed through ${item.missedOccurrences} scheduled runs; this one shift stands in for all of them.)`
            : item.prompt,
          createdAtMs: now,
        });
        touched.add(slug);
      }
      const firedWakes = plan.updates
        .map((update) => member.definition.schedule[Number(update.id.split('#')[1])])
        .filter((spec) => spec?.at !== undefined && spec.createdBy === 'member');
      if (firedWakes.length > 0 && member.errors.length === 0) {
        // A fired self-made wake has nothing left to do; the journal keeps the record of setting it.
        await crewFiles.updateCrewMemberFile(this.workspacePath, slug, (latest) => ({
          ...latest,
          schedule: latest.schedule.filter((spec) => !firedWakes.some((fired) => fired.at === spec.at && spec.createdBy === 'member')),
        })).catch((error) => this.log('warn', 'Could not remove a fired wake', { slug, error: String(error) }));
      }
      if (state.held.length > 0 && (state.deferredUntilMs === undefined || state.deferredUntilMs <= now)) touched.add(slug);
    }
    for (const slug of touched) await this.tryDispatch(slug);
    await this.saveCache();
  }

  private async arm(): Promise<void> {
    if (!this.started) return;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    const now = this.now();
    const targets: number[] = [now + MAX_TIMER_MS];
    const members = await crewFiles.loadCrewMembers(this.workspacePath).catch(() => []);
    for (const member of members) {
      if (member.errors.length > 0 || member.definition.paused) continue;
      const next = this.nextRunAtMs(member.definition, null);
      if (next !== null) targets.push(next);
    }
    for (const state of this.members.values()) {
      if (state.deferredUntilMs !== undefined && state.held.length > 0) targets.push(state.deferredUntilMs);
    }
    const delay = Math.max(1_000, Math.min(...targets) - now);
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.tick();
    }, Math.min(delay, MAX_TIMER_MS));
  }

  // ─── Dispatch and shifts ───────────────────────────────────────────────

  private async tryDispatch(slug: string): Promise<DispatchResult | null> {
    if (this.dispatching.has(slug)) return null;
    this.dispatching.add(slug);
    try {
      const state = this.state(slug);
      const member = await crewFiles.loadCrewMember(this.workspacePath, slug);
      if (!member) return null;
      const sessions = await this.memberSessions(slug);
      const now = this.now();
      await this.reconcileUsage().catch((error) => this.log('warn', 'Crew usage reconcile failed', { slug, error: String(error) }));
      const { verdict } = await this.usage(member.definition, sessions);
      const decision = decideDispatch({
        pending: state.held,
        onShift: state.shift !== undefined,
        paused: member.errors.length > 0 || member.definition.paused === true,
        quietHours: member.definition.notify.quietHours,
        budget: verdict,
        nowMs: now,
        timeZone: this.timeZone(),
      });
      if (decision.action === 'defer') {
        state.deferredUntilMs = decision.untilMs;
        if (decision.reason === 'over-budget') await this.noteOverBudget(member.definition, verdict);
        this.bump();
        return null;
      }
      state.deferredUntilMs = undefined;
      if (decision.action !== 'start') return null;
      return await this.beginShift(member.definition, sessions);
    } catch (error) {
      this.log('error', 'Crew dispatch failed', { slug, error: String(error) });
      if (this.state(slug).held.some((wake) => wake.trigger === 'user')) throw error;
      return null;
    } finally {
      this.dispatching.delete(slug);
      await this.saveCache();
    }
  }

  private async beginShift(
    definition: CrewMemberDefinition,
    sessions: MemberSessions,
  ): Promise<DispatchResult> {
    const slug = definition.slug;
    const state = this.state(slug);
    const wakes = state.held.splice(0);
    let wakesReturned = false;
    const now = this.now();
    const nowIso = new Date(now).toISOString();
    const shift: ActiveShift = {
      slug,
      trigger: primaryTrigger(wakes.map((wake) => wake.trigger)),
      startedAtMs: now,
      phase: 'starting',
      advancing: false,
    };
    state.shift = shift;
    this.bump();
    try {
      let current = sessions.current;
      if (current) {
        const result = await this.deps.sessions.getResult(current.session.sessionId).catch(() => null);
        const verdict = decideChapterRoll({
          chapterStartedAtMs: Date.parse(current.meta.startedAt),
          nowMs: now,
          contextTokens: result?.contextFill?.tokens ?? null,
          contextWindow: result?.contextFill?.contextWindow ?? null,
        });
        if (verdict.roll) {
          // The chapter aged out (or filled) while idle. Close it the same way
          // as after a shift: ask for the handoff, and let these wakes start
          // the next chapter once the handoff settles (finishShift dispatches them).
          const chapterSessionId = current.session.sessionId;
          Object.assign(shift, {
            chapterSessionId,
            chapterIndex: current.meta.chapterIndex,
            chapterStartedAtMs: Date.parse(current.meta.startedAt),
            phase: 'handoff' as const,
            rollDetail: verdict.detail,
          });
          state.held.unshift(...wakes);
          wakesReturned = true;
          this.bump();
          await this.deps.sessions.sendPrompt(chapterSessionId, buildHandoffPrompt(current.meta.chapterIndex, verdict.detail));
          return { chapterSessionId, chapterIndex: current.meta.chapterIndex, handoff: true };
        }
      }

      if (current) {
        const chapterSessionId = current.session.sessionId;
        Object.assign(shift, {
          chapterSessionId,
          chapterIndex: current.meta.chapterIndex,
          chapterStartedAtMs: Date.parse(current.meta.startedAt),
        });
        await this.deps.sessions.updateOwnerMetadata(chapterSessionId, shiftStartPatch(current.meta, nowIso));
        // In 'work' before sending: a turn that settles before sendPrompt returns must still end the shift.
        shift.phase = 'work';
        await this.deps.sessions.sendPrompt(
          chapterSessionId,
          buildShiftPrompt({ member: definition, wakes, nowMs: now, timeZone: this.timeZone() }),
        );
      } else {
        const chapterIndex = nextChapterIndex(sessions);
        const workstreamId = sessions.workstreamId
          ?? (await this.deps.sessions.createWorkstream({
            name: `${definition.name} (${definition.role})`,
            ownerKey: slug,
            provider: definition.provider,
            ownerMetadata: { kind: 'workstream' },
          })).workstreamId;
        const notes = await crewFiles.readNotes(this.workspacePath, slug);
        const prompt = buildShiftPrompt({
          member: definition,
          wakes,
          nowMs: now,
          timeZone: this.timeZone(),
          chapterStart: {
            chapterIndex,
            notes,
            notesRevision: crewFiles.notesRevision(notes),
            recentJournal: crewFiles.recentJournalEntries(await crewFiles.readJournal(this.workspacePath, slug)),
          },
        });
        const roster = (await crewFiles.loadCrewMembers(this.workspacePath))
          .filter((member) => member.errors.length === 0)
          .map((member) => member.definition);
        shift.phase = 'work';
        Object.assign(shift, { chapterIndex, chapterStartedAtMs: now });
        const { sessionId } = await this.deps.sessions.create({
          prompt,
          provider: definition.provider,
          model: sessionModelId(definition),
          directive: buildCrewDirective({ member: definition, roster }),
          ownerKey: slug,
          name: `${definition.name} - Chapter ${chapterIndex}`,
          workstreamId,
          ownerMetadata: {
            kind: 'chapter',
            chapterIndex,
            startedAt: nowIso,
            definitionHash: definitionHash(definition),
            ...shiftStartPatch({}, nowIso),
          },
          routeChildUpdatesToOwner: true,
        });
        shift.chapterSessionId = sessionId;
      }
      this.bump();
      const early = shift.chapterSessionId ? this.unclaimedSettles.get(shift.chapterSessionId) : undefined;
      if (early) {
        this.unclaimedSettles.delete(early.sessionId);
        void this.onChapterSettled(shift, early).catch((error) => this.log('error', 'Crew settle handling failed', { error: String(error) }));
      }
      return { chapterSessionId: shift.chapterSessionId!, chapterIndex: shift.chapterIndex! };
    } catch (error) {
      state.shift = undefined;
      // Put the wakes back so they are not lost with the failed start.
      if (!wakesReturned) state.held.unshift(...wakes);
      await this.journal(slug, {
        kind: 'system',
        title: 'Shift failed to start',
        body: error instanceof Error ? error.message : String(error),
      }).catch(() => undefined);
      throw error;
    }
  }

  private async finishShift(slug: string): Promise<void> {
    const state = this.state(slug);
    state.shift = undefined;
    state.waitingOnUser = false;
    this.bump();
    if (state.held.length > 0) await this.tryDispatch(slug);
    await this.arm();
  }

  private async noteOverBudget(definition: CrewMemberDefinition, verdict: BudgetVerdict): Promise<void> {
    const state = this.state(definition.slug);
    const day = startOfLocalDay(this.now(), this.timeZone());
    if (state.budgetNotedDayMs === day) return;
    state.budgetNotedDayMs = day;
    const when = verdict.retryAtMs ? formatLocalStamp(verdict.retryAtMs, this.timeZone()) : 'later';
    await this.journal(definition.slug, {
      kind: 'budget',
      title: 'Over budget',
      body: `${definition.name} is waiting: ${describeBudgetReasons(verdict.reasons)}. Next check ${when}. Raise the budget in the member's settings to continue sooner.`,
      level: 'note',
    });
  }

  // ─── Settled sessions ──────────────────────────────────────────────────

  async onSettled(event: SessionSettledEvent): Promise<void> {
    // Every owned session, chapters and delegated work alike, feeds the ledger.
    // Budgets count every token the session consumed, cache reads and writes included.
    this.recordUsage({ sessionId: event.sessionId, key: event.ownerKey, tokens: event.tokenUsage.allTokens, atMs: event.at });
    const slug = event.ownerKey;
    if (!isValidCrewSlug(slug)) return;
    const state = this.state(slug);
    const shift = state.shift;
    if (shift?.chapterSessionId === event.sessionId) {
      await this.onChapterSettled(shift, event);
      return;
    }
    const creatingChapter = shift?.phase === 'work' && !shift.chapterSessionId;
    const sessions = await this.memberSessions(slug);
    if (sessions.chapters.some((chapter) => chapter.session.sessionId === event.sessionId)) {
      if (creatingChapter) {
        // The chapter whose first turn beat `create` returning.
        this.unclaimedSettles.set(event.sessionId, event);
      } else if (sessions.current?.session.sessionId === event.sessionId) {
        await this.recordUserConversation(slug, sessions.current, event);
      }
      this.bump();
      return;
    }
    if (sessions.workstreamId === event.sessionId) return;
    const delegated = sessions.delegated.find((session) => session.sessionId === event.sessionId);
    if (!delegated) {
      // Not listed yet: most likely the chapter being created right now.
      if (creatingChapter) this.unclaimedSettles.set(event.sessionId, event);
      return;
    }
    await this.onDelegatedSettled(slug, delegated.sessionId, delegated.title, event.outcome);
  }

  /**
   * The user talked to the member through the desk's composer, which sends
   * straight to the chapter. That is a user-triggered shift: it counts toward
   * shifts per day and gets a journal entry. It was never gated on budget or
   * pause; the user chose to talk, so it is only recorded.
   */
  private async recordUserConversation(
    slug: string,
    chapter: NonNullable<MemberSessions['current']>,
    event: SessionSettledEvent,
  ): Promise<void> {
    if (event.outcome === 'waiting') return;
    const result = await this.deps.sessions.getResult(event.sessionId).catch(() => null);
    const response = result?.lastResponse?.trim() ?? '';
    await this.deps.sessions.updateOwnerMetadata(event.sessionId, shiftStartPatch(chapter.meta, new Date(event.at).toISOString()));
    await this.journal(slug, {
      kind: 'shift',
      title: 'Conversation with the user',
      body: event.outcome === 'completed'
        ? response
        : `Ended with ${event.outcome === 'error' ? 'an error' : 'an interruption'}.${response ? `\n\n${response}` : ''}`,
      trigger: 'user',
      chapterIndex: chapter.meta.chapterIndex,
      sessionId: event.sessionId,
      atMs: event.at,
    });
  }

  private async onChapterSettled(shift: ActiveShift, event: SessionSettledEvent): Promise<void> {
    const state = this.state(shift.slug);
    if (shift.advancing || state.shift !== shift) return;
    if (event.outcome === 'waiting') {
      state.waitingOnUser = true;
      this.bump();
      return;
    }
    const status = await this.deps.sessions.getStatus(event.sessionId);
    // `completed` fires on every idle; a queued follow-up means the shift is between turns.
    if (event.outcome === 'completed' && ((status.queuedPromptCount ?? 0) > 0 || status.status === 'running')) return;
    state.waitingOnUser = false;
    shift.advancing = true;
    try {
      const result = await this.deps.sessions.getResult(event.sessionId);
      const response = result.lastResponse?.trim() ?? '';
      const base = {
        trigger: shift.trigger,
        ...(shift.chapterIndex !== undefined ? { chapterIndex: shift.chapterIndex } : {}),
        sessionId: event.sessionId,
      };
      if (shift.phase === 'work') {
        const summary = event.outcome === 'completed'
          ? response
          : `Shift ended with ${event.outcome === 'error' ? 'an error' : 'an interruption'}.${response ? `\n\n${response}` : ''}`;
        await this.journal(shift.slug, { kind: 'shift', title: 'Shift summary', body: summary, ...base });
        if (event.outcome === 'completed' && shift.chapterIndex !== undefined) {
          const verdict = decideChapterRoll({
            chapterStartedAtMs: shift.chapterStartedAtMs ?? shift.startedAtMs,
            nowMs: this.now(),
            contextTokens: result.contextFill?.tokens ?? null,
            contextWindow: result.contextFill?.contextWindow ?? null,
          });
          if (verdict.roll) {
            shift.phase = 'handoff';
            shift.rollDetail = verdict.detail;
            this.bump();
            await this.deps.sessions.sendPrompt(event.sessionId, buildHandoffPrompt(shift.chapterIndex, verdict.detail));
            return;
          }
        }
        await this.finishShift(shift.slug);
        return;
      }
      // Handoff phase: the chapter closes whether or not the member produced a summary.
      const handoff = event.outcome === 'completed' && response ? response : undefined;
      const stamp = formatLocalStamp(this.now(), this.timeZone());
      if (handoff) {
        await crewFiles.appendNotesSection(this.workspacePath, shift.slug, {
          heading: `Handoff from chapter ${shift.chapterIndex} (${stamp})`,
          body: handoff,
        });
      }
      await this.deps.sessions.updateOwnerMetadata(event.sessionId, {
        endedAt: new Date(this.now()).toISOString(),
        endReason: shift.rollDetail ?? 'rolled',
        ...(handoff ? { handoffSummary: handoff } : {}),
      });
      await this.journal(shift.slug, {
        kind: 'handoff',
        title: `Chapter ${shift.chapterIndex} closed`,
        body: handoff ?? `No handoff summary (${shift.rollDetail ?? 'rolled'}).`,
        ...base,
      });
      await this.finishShift(shift.slug);
    } finally {
      shift.advancing = false;
    }
  }

  /**
   * A delegated session settled: wake the member in its CURRENT chapter (not
   * the one that spawned the work, which may have rolled since). It is a
   * shift, so it is held for quiet hours, coalesced, and budgeted, unless the
   * session is blocked on the user and the member may page.
   */
  private async onDelegatedSettled(slug: string, sessionId: string, name: string, outcome: SettledOutcome): Promise<void> {
    const member = await crewFiles.loadCrewMember(this.workspacePath, slug);
    if (!member || member.errors.length > 0) return;
    let detail: string;
    if (outcome === 'waiting') {
      detail = 'is waiting on the user. Decide whether to flag it.';
    } else {
      const result = await this.deps.sessions.getResult(sessionId).catch(() => null);
      const response = result?.lastResponse?.trim() ?? '';
      const excerpt = response.length > RESULT_EXCERPT_CHARS ? `${response.slice(0, RESULT_EXCERPT_CHARS)}...` : response;
      const verb = outcome === 'completed' ? 'finished' : outcome === 'error' ? 'stopped with an error' : 'was interrupted';
      detail = `${verb}.${excerpt ? `\n\nIts last message:\n${excerpt}` : ''}`;
    }
    await this.enqueueWake(slug, {
      trigger: 'child-session',
      prompt: `Delegated session "${name}" (${sessionId}) ${detail}`,
      createdAtMs: this.now(),
      urgent: isUrgentChildUpdate(outcome, member.definition.notify.maxLevel),
      sourceSessionId: sessionId,
    });
  }

  /** Mid-shift: queued into the current chapter. Otherwise held, superseding an older wake about the same session. */
  async enqueueWake(slug: string, wake: HeldWake): Promise<void> {
    const state = this.state(slug);
    const shift = state.shift;
    if (shift?.phase === 'work' && shift.chapterSessionId) {
      await this.deps.sessions.sendPrompt(shift.chapterSessionId, buildMidShiftPrompt(wake));
      this.bump();
      return;
    }
    if (wake.sourceSessionId) {
      state.held = state.held.filter((held) => held.sourceSessionId !== wake.sourceSessionId);
    }
    state.held.push(wake);
    this.bump();
    await this.tryDispatch(slug);
    await this.arm();
  }

  // ─── Internals ─────────────────────────────────────────────────────────

  private async requireRunnable(slug: string): Promise<CrewMemberDefinition> {
    const member = await crewFiles.loadCrewMember(this.workspacePath, slug);
    if (!member) throw new Error(`Crew member "${slug}" not found`);
    if (member.errors.length > 0) throw new Error(`${slug}.md has errors: ${member.errors.join('; ')}`);
    if (member.definition.paused) throw new Error(`${member.definition.name} is paused`);
    return member.definition;
  }

  private state(slug: string): MemberState {
    let state = this.members.get(slug);
    if (!state) {
      state = { held: [], waitingOnUser: false, entryAnchors: {} };
      this.members.set(slug, state);
    }
    return state;
  }

  private async saveCache(): Promise<void> {
    if (!this.deps.cache) return;
    const cache: CrewRuntimeCache = { firedThrough: {}, held: {}, anchors: {}, lastAliveMs: this.now(), seenThrough: this.seenThrough };
    for (const [slug, state] of this.members) {
      if (Object.keys(state.entryAnchors).length > 0) cache.anchors![slug] = state.entryAnchors;
      if (state.firedThroughMs !== undefined) cache.firedThrough[slug] = state.firedThroughMs;
      if (state.held.length > 0) cache.held[slug] = state.held;
    }
    await this.deps.cache.save(cache).catch((error) => this.log('warn', 'Crew cache save failed', { error: String(error) }));
  }

  private setTimer(callback: () => void, ms: number): unknown {
    return this.deps.setTimer ? this.deps.setTimer(callback, ms) : setTimeout(callback, ms);
  }

  private clearTimer(handle: unknown): void {
    if (this.deps.clearTimer) this.deps.clearTimer(handle);
    else clearTimeout(handle as ReturnType<typeof setTimeout>);
  }

  private log(level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown): void {
    this.deps.log?.(level, `[crew] ${message}`, data);
  }
}
