/**
 * Application-owned voice event queue (GPT-Live-1 migration, slice A3).
 *
 * The Live engine closes the paid socket while sleeping, so the decision of
 * *what is worth waking for* can no longer live inside the transport. This
 * queue is plain application state: it survives with no transport at all, it
 * observes every eligible agent session rather than the one linked session
 * `voiceModeListeners` subscribes to today, and it decides — from injected
 * facts only — what should be spoken next and where an answer must be routed.
 *
 * Deliberately pure: no IPC, no sockets, no React, no service imports, no
 * global state. The clock, the current voice state, and the "is this prompt
 * still pending" predicate are all constructor-injected, because the
 * interesting behavior here (supersession, dedup across reconnect, two
 * devices racing to speak) is ordering-sensitive and can only be exercised if
 * the decision is a function of facts rather than of the environment.
 *
 * The wiring session owns every observation that feeds this; nothing in this
 * file reaches out for anything.
 */

/** Where an event came from. Every field is required for correct routing. */
export interface VoiceEventSource {
  /** Device that produced the event (desktop install, iPhone, ...). */
  deviceId: string;
  /** Workspace path the agent session belongs to. */
  workspacePath: string;
  /** Agent session id. An answer goes back here, not to the active tab. */
  sessionId: string;
  /** Durable task id the event belongs to. */
  taskId: string;
  /**
   * Monotonic revision of that task. A result from a lower revision must
   * never answer a request made at a higher one.
   */
  taskRevision: number;
}

export type VoiceEventKind = 'question' | 'completion';

/** An event as handed to the queue by the wiring layer. */
export interface VoiceEventInput {
  /** Stable id assigned at the source. The dedup key across sync paths. */
  eventId: string;
  kind: VoiceEventKind;
  source: VoiceEventSource;
  /** Required for questions: the pending prompt this answers. */
  promptId?: string;
  /** Short spoken label, e.g. "auth refactor". */
  sourceLabel: string;
  /** Short spoken body: the question, or the completion summary. */
  summary: string;
  /** Source-clock creation time (ms). Used for ordering, not for expiry. */
  createdAt: number;
  /**
   * Whether this completion is worth restoring a sleeping session for,
   * overriding `wakeForCompletions` for this event alone.
   *
   * The queue-wide default exists to stop routine background chatter from
   * reopening a paid session. It is not a reason to silence the task the user
   * explicitly handed over and is waiting to hear about -- those are different
   * events, and only the wiring layer knows which is which.
   */
  wakeOnSleep?: boolean;
}

/**
 * `announcing` is the state the plan warns about: the backend accepted the
 * announcement but there is no proof the user heard audio. It decays back to
 * `queued` when no device confirms presentation.
 */
export type VoiceEventStatus =
  | 'queued'
  | 'announcing'
  | 'presented'
  | 'answered'
  | 'discarded';

export type VoiceEventDiscardReason =
  | 'superseded'
  | 'prompt-resolved'
  | 'stale-result'
  | 'dropped';

export interface VoiceQueueEntry extends VoiceEventInput {
  status: VoiceEventStatus;
  /** Device currently allowed to speak this event; null when unclaimed. */
  announcingDeviceId: string | null;
  /** Queue-clock time of the last status/claim change. */
  updatedAt: number;
  /** Additional event ids folded into this entry (coalesced or duplicate). */
  mergedEventIds: string[];
  /** How many completions this entry represents (1 unless coalesced). */
  coalescedCount: number;
  discardReason?: VoiceEventDiscardReason;
}

export type VoiceRunState =
  /** User explicitly turned voice off. Never auto-reopened by an event. */
  | 'off'
  /** Armed but closed (paid session shut down). An event may restore it. */
  | 'sleeping'
  /** Session open, nobody mid-conversation. */
  | 'listening'
  /** User is mid-conversation; routine completions must not interrupt. */
  | 'conversing';

export type VoiceIngestResult =
  | { accepted: true; entry: VoiceQueueEntry; coalescedInto?: string }
  | {
      accepted: false;
      reason: 'duplicate' | 'superseded' | 'invalid';
      detail?: string;
    };

export type VoiceQueuePlan =
  | {
      action: 'announce';
      entry: VoiceQueueEntry;
      /** True when the paid session is closed and must be restored first. */
      requiresWake: boolean;
    }
  | {
      action: 'none';
      reason:
        | 'empty'
        | 'voice-off'
        | 'busy-conversation'
        | 'awaiting-presentation'
        | 'deferred-until-awake';
    };

export type VoiceAnswerPlan =
  | {
      action: 'deliver';
      /** Route here. Not to whatever session is focused now. */
      target: VoiceEventSource & { promptId: string };
      entry: VoiceQueueEntry;
    }
  | {
      action: 'reject';
      reason:
        | 'unknown-event'
        | 'not-announced'
        | 'already-answered'
        | 'prompt-no-longer-pending'
        | 'superseded'
        | 'not-announcing-device';
    };

export interface VoiceEventQueueOptions {
  /** Injected clock (ms). */
  now: () => number;
  /** Injected current voice state. */
  getVoiceState: () => VoiceRunState;
  /**
   * Revalidation hook, consulted immediately before speaking and again before
   * routing an answer. A prompt may have been answered in the UI meanwhile.
   */
  isPromptPending: (entry: VoiceQueueEntry) => boolean;
  /**
   * Optional extra check that a completion still describes current work.
   * Revision supersession is already handled internally.
   */
  isResultCurrent?: (entry: VoiceQueueEntry) => boolean;
  /** Completions for one session arriving within this window merge. */
  completionCoalesceWindowMs?: number;
  /**
   * How long an `announcing` claim survives without a presentation
   * confirmation before the event returns to the queue and another device
   * may take it.
   */
  announceTimeoutMs?: number;
  /**
   * How long a presented, unanswered question keeps the floor. A user who
   * simply never answers is not an error, so the entry stays answerable; it
   * just stops blocking other sessions' announcements past this bound.
   * Distinct from `announceTimeoutMs`, which covers audio we are not sure
   * was ever heard.
   */
  presentedQuestionHoldMs?: number;
  /** Whether routine completions may restore a sleeping session. */
  wakeForCompletions?: boolean;
  /** Cap on remembered event ids used for dedup. */
  maxRememberedEventIds?: number;
}

const DEFAULT_COALESCE_WINDOW_MS = 4000;
const DEFAULT_ANNOUNCE_TIMEOUT_MS = 20000;
const DEFAULT_PRESENTED_QUESTION_HOLD_MS = 120000;
const DEFAULT_MAX_REMEMBERED_EVENT_IDS = 1000;

const KIND_PRIORITY: Record<VoiceEventKind, number> = {
  // Questions block a human; completion summaries do not.
  question: 0,
  completion: 1,
};

const isOpenStatus = (status: VoiceEventStatus): boolean =>
  status === 'queued' || status === 'announcing' || status === 'presented';

export class VoiceEventQueue {
  private readonly entries = new Map<string, VoiceQueueEntry>();
  /** Every event id ever ingested, so a resync cannot replay one. */
  private readonly seenEventIds = new Set<string>();
  private readonly seenOrder: string[] = [];
  /** Highest task revision observed per task id. */
  private readonly taskRevisions = new Map<string, number>();

  private readonly opts: Required<
    Omit<VoiceEventQueueOptions, 'isResultCurrent'>
  > &
    Pick<VoiceEventQueueOptions, 'isResultCurrent'>;

  constructor(options: VoiceEventQueueOptions) {
    this.opts = {
      now: options.now,
      getVoiceState: options.getVoiceState,
      isPromptPending: options.isPromptPending,
      isResultCurrent: options.isResultCurrent,
      completionCoalesceWindowMs:
        options.completionCoalesceWindowMs ?? DEFAULT_COALESCE_WINDOW_MS,
      announceTimeoutMs: options.announceTimeoutMs ?? DEFAULT_ANNOUNCE_TIMEOUT_MS,
      presentedQuestionHoldMs:
        options.presentedQuestionHoldMs ?? DEFAULT_PRESENTED_QUESTION_HOLD_MS,
      wakeForCompletions: options.wakeForCompletions ?? false,
      maxRememberedEventIds:
        options.maxRememberedEventIds ?? DEFAULT_MAX_REMEMBERED_EVENT_IDS,
    };
  }

  /**
   * Record a task revision learned outside of an event (a new prompt was
   * submitted to a task, say). Discards anything queued for an older one.
   */
  noteTaskRevision(taskId: string, revision: number): void {
    const known = this.taskRevisions.get(taskId);
    if (known !== undefined && known >= revision) return;
    this.taskRevisions.set(taskId, revision);
    for (const entry of this.entries.values()) {
      if (
        entry.source.taskId === taskId &&
        entry.source.taskRevision < revision &&
        isOpenStatus(entry.status)
      ) {
        this.discard(entry, 'superseded');
      }
    }
  }

  ingest(input: VoiceEventInput): VoiceIngestResult {
    if (input.kind === 'question' && !input.promptId) {
      return {
        accepted: false,
        reason: 'invalid',
        detail: 'question events require a promptId',
      };
    }

    if (this.seenEventIds.has(input.eventId)) {
      return { accepted: false, reason: 'duplicate', detail: 'event id' };
    }

    // A resync can mint a fresh event id for a prompt we already hold.
    if (input.kind === 'question') {
      for (const entry of this.entries.values()) {
        if (
          isOpenStatus(entry.status) &&
          entry.promptId === input.promptId &&
          entry.source.sessionId === input.source.sessionId
        ) {
          this.remember(input.eventId);
          entry.mergedEventIds.push(input.eventId);
          return { accepted: false, reason: 'duplicate', detail: 'prompt id' };
        }
      }
    }

    const knownRevision = this.taskRevisions.get(input.source.taskId);
    if (
      knownRevision !== undefined &&
      input.source.taskRevision < knownRevision
    ) {
      this.remember(input.eventId);
      return { accepted: false, reason: 'superseded' };
    }
    this.noteTaskRevision(input.source.taskId, input.source.taskRevision);

    const now = this.opts.now();
    this.remember(input.eventId);

    if (input.kind === 'completion') {
      const target = this.findCoalesceTarget(input, now);
      if (target) {
        target.mergedEventIds.push(input.eventId);
        target.coalescedCount += 1;
        target.updatedAt = now;
        // One awaited completion in the batch makes the batch worth waking for.
        if (input.wakeOnSleep) target.wakeOnSleep = true;
        // The newest summary describes the most recent state of the session.
        if (input.createdAt >= target.createdAt) {
          target.summary = input.summary;
          target.sourceLabel = input.sourceLabel;
          target.createdAt = input.createdAt;
          target.source = input.source;
        }
        return { accepted: true, entry: target, coalescedInto: target.eventId };
      }
    }

    const entry: VoiceQueueEntry = {
      ...input,
      status: 'queued',
      announcingDeviceId: null,
      updatedAt: now,
      mergedEventIds: [],
      coalescedCount: 1,
    };
    this.entries.set(entry.eventId, entry);
    return { accepted: true, entry };
  }

  /**
   * Decide what to announce next. Revalidates as it goes: an entry whose
   * prompt is no longer pending, or whose result has been superseded, is
   * discarded here rather than spoken.
   */
  planNext(): VoiceQueuePlan {
    const now = this.opts.now();
    this.expireStaleClaims(now);

    const voiceState = this.opts.getVoiceState();
    if (voiceState === 'off') {
      // Events are retained; turning voice off must not reopen it.
      return { action: 'none', reason: 'voice-off' };
    }

    // One announcement at a time; an unanswered question holds the floor.
    if (this.floorIsHeld(now)) {
      return { action: 'none', reason: 'awaiting-presentation' };
    }

    let sawBlockedByConversation = false;
    let sawDeferredUntilAwake = false;

    for (const entry of this.candidates()) {
      if (!this.revalidate(entry)) continue;

      if (entry.kind === 'completion') {
        if (voiceState === 'conversing') {
          // Routine background completions never interrupt a live exchange.
          sawBlockedByConversation = true;
          continue;
        }
        if (
          voiceState === 'sleeping' &&
          !(entry.wakeOnSleep ?? this.opts.wakeForCompletions)
        ) {
          sawDeferredUntilAwake = true;
          continue;
        }
      }

      return { action: 'announce', entry, requiresWake: voiceState === 'sleeping' };
    }

    if (sawBlockedByConversation) return { action: 'none', reason: 'busy-conversation' };
    if (sawDeferredUntilAwake) return { action: 'none', reason: 'deferred-until-awake' };
    return { action: 'none', reason: 'empty' };
  }

  /**
   * Claim the right to speak an event. Exactly one device wins; the loser
   * gets false and must stay silent. The claim decays after
   * `announceTimeoutMs` without a `markPresented`, so a device that dies
   * mid-announcement does not strand the event.
   */
  beginAnnouncement(eventId: string, deviceId: string): boolean {
    const now = this.opts.now();
    this.expireStaleClaims(now);
    const entry = this.entries.get(eventId);
    if (!entry) return false;
    if (entry.status !== 'queued') return false;
    if (entry.announcingDeviceId !== null && entry.announcingDeviceId !== deviceId) {
      return false;
    }
    entry.status = 'announcing';
    entry.announcingDeviceId = deviceId;
    entry.updatedAt = now;
    return true;
  }

  /**
   * Audio actually played on the announcing device. For a completion this is
   * terminal; for a question the entry now waits for an answer.
   */
  markPresented(eventId: string, deviceId: string): boolean {
    const entry = this.entries.get(eventId);
    if (!entry || entry.status !== 'announcing') return false;
    if (entry.announcingDeviceId !== deviceId) return false;
    entry.status = 'presented';
    entry.updatedAt = this.opts.now();
    return true;
  }

  /**
   * Explicit handoff of the announcing role (desktop hands the iPhone the
   * floor, or gives it up on disconnect). Returns the event to the queue
   * when `toDeviceId` is null.
   */
  handOffAnnouncement(
    eventId: string,
    fromDeviceId: string,
    toDeviceId: string | null
  ): boolean {
    const entry = this.entries.get(eventId);
    if (!entry) return false;
    if (entry.announcingDeviceId !== fromDeviceId) return false;
    entry.announcingDeviceId = toDeviceId;
    if (toDeviceId === null && entry.status === 'announcing') {
      entry.status = 'queued';
    }
    entry.updatedAt = this.opts.now();
    return true;
  }

  /**
   * The question a spoken answer belongs to on this device: the most recently
   * presented, still-unanswered question. Tab focus is irrelevant.
   */
  activeQuestionId(deviceId: string): string | null {
    let best: VoiceQueueEntry | null = null;
    for (const entry of this.entries.values()) {
      if (entry.kind !== 'question') continue;
      if (entry.status !== 'presented') continue;
      if (entry.announcingDeviceId !== deviceId) continue;
      if (!best || entry.updatedAt > best.updatedAt) best = entry;
    }
    return best?.eventId ?? null;
  }

  /**
   * Resolve where an answer must go and atomically claim it. On `deliver` the
   * entry is already `answered`, so a second device (or a duplicate submit)
   * is rejected rather than double-submitting.
   */
  resolveAnswer(eventId: string, deviceId: string): VoiceAnswerPlan {
    const entry = this.entries.get(eventId);
    if (!entry || entry.kind !== 'question') {
      return { action: 'reject', reason: 'unknown-event' };
    }
    if (entry.status === 'answered') {
      return { action: 'reject', reason: 'already-answered' };
    }
    if (entry.status === 'discarded') {
      return {
        action: 'reject',
        reason:
          entry.discardReason === 'prompt-resolved'
            ? 'prompt-no-longer-pending'
            : 'superseded',
      };
    }
    if (entry.announcingDeviceId !== deviceId) {
      return { action: 'reject', reason: 'not-announcing-device' };
    }
    /**
     * `presented` only -- `announcing` is not consent.
     *
     * The previous version accepted both, on the reasoning that an answer to a
     * question still marked `announcing` must be the user answering it. That
     * reasoning has the trust direction backwards: the thing that "answers" here
     * is a tool call the model chose to make, and the model is precisely what
     * the lower-trust content reaching it can influence. `announcing` means the
     * request to speak was issued and nothing has confirmed the audio was
     * heard, so treating a model-generated call as that confirmation lets an
     * answer be delivered for a question no human was ever read.
     *
     * A genuinely heard question reaches `presented` from the playback path
     * within the announce timeout; one that does not is requeued and asked
     * again, which is the safe direction to be wrong in.
     */
    if (entry.status !== 'presented') {
      return { action: 'reject', reason: 'not-announced' };
    }
    const known = this.taskRevisions.get(entry.source.taskId);
    if (known !== undefined && entry.source.taskRevision < known) {
      this.discard(entry, 'superseded');
      return { action: 'reject', reason: 'superseded' };
    }
    if (!this.opts.isPromptPending(entry)) {
      this.discard(entry, 'prompt-resolved');
      return { action: 'reject', reason: 'prompt-no-longer-pending' };
    }

    entry.status = 'answered';
    entry.updatedAt = this.opts.now();
    return {
      action: 'deliver',
      entry,
      target: { ...entry.source, promptId: entry.promptId as string },
    };
  }

  /**
   * Give an answer claim back, because delivering it failed.
   *
   * `resolveAnswer` marks the entry answered before the answer is persisted,
   * which is what makes a duplicate delivery a no-op. The cost is that a failed
   * persist used to leave the question permanently unanswerable: the user said
   * the words, nothing was recorded, and every retry was rejected as
   * already-answered. Returning it to `presented` keeps the question the user
   * demonstrably heard answerable while still rejecting a concurrent second
   * claim, which is the case the atomic claim exists for.
   */
  releaseAnswer(eventId: string, deviceId: string): boolean {
    const entry = this.entries.get(eventId);
    if (!entry || entry.kind !== 'question') return false;
    if (entry.status !== 'answered') return false;
    if (entry.announcingDeviceId !== deviceId) return false;
    entry.status = 'presented';
    entry.updatedAt = this.opts.now();
    return true;
  }

  /** Drop an event without answering it (session closed, user dismissed). */
  drop(eventId: string, reason: VoiceEventDiscardReason = 'dropped'): boolean {
    const entry = this.entries.get(eventId);
    if (!entry || !isOpenStatus(entry.status)) return false;
    this.discard(entry, reason);
    return true;
  }

  get(eventId: string): VoiceQueueEntry | undefined {
    return this.entries.get(eventId);
  }

  /**
   * Next-to-announce order. Only `queued` entries: an entry already claimed or
   * presented is not a candidate for announcement.
   *
   * This is NOT "everything still open" -- `open()` is. Reading it as such is
   * how voice-off came to leave announcing and presented questions in the
   * queue, where they went on holding the next conversation's floor.
   */
  pending(): VoiceQueueEntry[] {
    return this.candidates();
  }

  /** Every entry that is not yet terminal, in announcement order. */
  open(): VoiceQueueEntry[] {
    return [...this.entries.values()].filter((entry) => isOpenStatus(entry.status));
  }

  /**
   * Forget everything: the conversation this queue belonged to is over.
   *
   * Dedup memory goes too, deliberately. It exists so a resync cannot replay an
   * event *within* a conversation; keeping it across conversations would
   * instead suppress a question the next conversation legitimately needs to ask
   * again, and would grow for the renderer's lifetime.
   */
  clear(): void {
    this.entries.clear();
    this.seenEventIds.clear();
    this.seenOrder.length = 0;
    this.taskRevisions.clear();
  }

  /** Everything the queue still holds, including terminal entries. */
  snapshot(): VoiceQueueEntry[] {
    return [...this.entries.values()];
  }

  /** Forget terminal entries older than `maxAgeMs`. Dedup memory survives. */
  prune(maxAgeMs: number): number {
    const cutoff = this.opts.now() - maxAgeMs;
    let removed = 0;
    for (const [id, entry] of this.entries) {
      // A presented completion has nothing left to do; a presented question
      // is still waiting for an answer.
      const terminal =
        !isOpenStatus(entry.status) ||
        (entry.kind === 'completion' && entry.status === 'presented');
      if (!terminal) continue;
      if (entry.updatedAt > cutoff) continue;
      this.entries.delete(id);
      removed += 1;
    }
    return removed;
  }

  // --- internals -------------------------------------------------------

  private candidates(): VoiceQueueEntry[] {
    return [...this.entries.values()]
      .filter((entry) => entry.status === 'queued')
      .sort((a, b) => {
        const byKind = KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind];
        if (byKind !== 0) return byKind;
        if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
        return a.eventId < b.eventId ? -1 : 1;
      });
  }

  private findCoalesceTarget(
    input: VoiceEventInput,
    now: number
  ): VoiceQueueEntry | null {
    for (const entry of this.entries.values()) {
      if (entry.kind !== 'completion') continue;
      if (entry.status !== 'queued') continue;
      if (entry.source.sessionId !== input.source.sessionId) continue;
      if (entry.source.deviceId !== input.source.deviceId) continue;
      if (now - entry.updatedAt > this.opts.completionCoalesceWindowMs) continue;
      return entry;
    }
    return null;
  }

  /** Returns false (and discards) when the entry is no longer worth saying. */
  private revalidate(entry: VoiceQueueEntry): boolean {
    const known = this.taskRevisions.get(entry.source.taskId);
    if (known !== undefined && entry.source.taskRevision < known) {
      this.discard(entry, 'superseded');
      return false;
    }
    if (entry.kind === 'question' && !this.opts.isPromptPending(entry)) {
      this.discard(entry, 'prompt-resolved');
      return false;
    }
    if (
      entry.kind === 'completion' &&
      this.opts.isResultCurrent &&
      !this.opts.isResultCurrent(entry)
    ) {
      this.discard(entry, 'stale-result');
      return false;
    }
    return true;
  }

  /**
   * Whether something is currently holding the announcement floor.
   *
   * Revalidates the holder first: a question the user answered in the UI
   * instead of by voice is no longer pending, and must not block every other
   * session's announcements until the process restarts. `resolveAnswer` is
   * not guaranteed to ever be called, so this is the only place that
   * recovers such an entry.
   */
  private floorIsHeld(now: number): boolean {
    let held = false;
    for (const entry of this.entries.values()) {
      if (entry.status === 'announcing') {
        held = true;
        continue;
      }
      if (entry.status !== 'presented' || entry.kind !== 'question') continue;
      if (!this.revalidate(entry)) continue;
      // Still pending, but an unanswered question cannot hold the floor
      // forever; it stays answerable, it just stops blocking.
      if (now - entry.updatedAt < this.opts.presentedQuestionHoldMs) held = true;
    }
    return held;
  }

  private expireStaleClaims(now: number): void {
    for (const entry of this.entries.values()) {
      if (entry.status !== 'announcing') continue;
      if (now - entry.updatedAt < this.opts.announceTimeoutMs) continue;
      // Accepted by a backend is not proof the user heard it.
      entry.status = 'queued';
      entry.announcingDeviceId = null;
      entry.updatedAt = now;
    }
  }

  private discard(entry: VoiceQueueEntry, reason: VoiceEventDiscardReason): void {
    entry.status = 'discarded';
    entry.discardReason = reason;
    entry.announcingDeviceId = null;
    entry.updatedAt = this.opts.now();
  }

  private remember(eventId: string): void {
    this.seenEventIds.add(eventId);
    this.seenOrder.push(eventId);
    if (this.seenOrder.length > this.opts.maxRememberedEventIds) {
      this.trimRemembered();
    }
  }

  /**
   * Evict oldest-first, but never an id that a live entry still depends on:
   * forgetting one would let a second sync path re-ingest it as a fresh
   * event. Completions have no secondary dedup key, so this is their only
   * protection. Callers that never `prune()` therefore keep dedup memory
   * proportional to their live entries, above `maxRememberedEventIds`.
   */
  private trimRemembered(): void {
    const live = new Set<string>();
    for (const entry of this.entries.values()) {
      live.add(entry.eventId);
      for (const merged of entry.mergedEventIds) live.add(merged);
    }

    let overBy = this.seenOrder.length - this.opts.maxRememberedEventIds;
    const kept: string[] = [];
    for (const id of this.seenOrder) {
      if (overBy > 0 && !live.has(id)) {
        this.seenEventIds.delete(id);
        overBy -= 1;
        continue;
      }
      kept.push(id);
    }
    this.seenOrder.length = 0;
    this.seenOrder.push(...kept);
  }
}
