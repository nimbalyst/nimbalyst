// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  VoiceEventQueue,
  type VoiceEventInput,
  type VoiceQueueEntry,
  type VoiceEventSource,
  type VoiceRunState,
} from '../voiceEventQueue';

interface Harness {
  queue: VoiceEventQueue;
  advance: (ms: number) => void;
  setVoiceState: (state: VoiceRunState) => void;
  resolvePrompt: (promptId: string) => void;
}

const makeQueue = (
  overrides: {
    voiceState?: VoiceRunState;
    wakeForCompletions?: boolean;
    announceTimeoutMs?: number;
    presentedQuestionHoldMs?: number;
    completionCoalesceWindowMs?: number;
  } = {}
): Harness => {
  let now = 1_000;
  let voiceState: VoiceRunState = overrides.voiceState ?? 'listening';
  const resolved = new Set<string>();

  const queue = new VoiceEventQueue({
    now: () => now,
    getVoiceState: () => voiceState,
    isPromptPending: (entry) => !resolved.has(entry.promptId ?? ''),
    wakeForCompletions: overrides.wakeForCompletions,
    announceTimeoutMs: overrides.announceTimeoutMs,
    presentedQuestionHoldMs: overrides.presentedQuestionHoldMs,
    completionCoalesceWindowMs: overrides.completionCoalesceWindowMs,
  });

  return {
    queue,
    advance: (ms) => {
      now += ms;
    },
    setVoiceState: (state) => {
      voiceState = state;
    },
    resolvePrompt: (promptId) => resolved.add(promptId),
  };
};

let seq = 0;
type EventOverrides = Partial<Omit<VoiceEventInput, 'source' | 'kind'>> & {
  kind: VoiceEventInput['kind'];
  source?: Partial<VoiceEventSource>;
};
const event = (over: EventOverrides): VoiceEventInput => {
  seq += 1;
  const sessionId = over.source?.sessionId ?? `session-${seq}`;
  return {
    eventId: over.eventId ?? `evt-${seq}`,
    kind: over.kind,
    promptId: over.kind === 'question' ? (over.promptId ?? `prompt-${seq}`) : over.promptId,
    sourceLabel: over.sourceLabel ?? `label-${seq}`,
    summary: over.summary ?? `summary-${seq}`,
    createdAt: over.createdAt ?? 1_000 + seq,
    source: {
      deviceId: 'desktop',
      workspacePath: '/w',
      sessionId,
      taskId: `task-${sessionId}`,
      taskRevision: 1,
      ...over.source,
    },
  };
};

/** Announce + present the next planned event, returning the entry. */
const announceNext = (h: Harness, deviceId = 'desktop'): VoiceQueueEntry => {
  const plan = h.queue.planNext();
  if (plan.action !== 'announce') {
    throw new Error(`expected announce, got none/${plan.reason}`);
  }
  expect(h.queue.beginAnnouncement(plan.entry.eventId, deviceId)).toBe(true);
  expect(h.queue.markPresented(plan.entry.eventId, deviceId)).toBe(true);
  return plan.entry;
};

describe('VoiceEventQueue', () => {
  it('answers the question that was announced, not the session that became active later', () => {
    const h = makeQueue();
    const first = event({ kind: 'question', source: { sessionId: 'agent-a' } });
    const second = event({ kind: 'question', source: { sessionId: 'agent-b' } });
    h.queue.ingest(first);
    h.queue.ingest(second);

    // Two agents asked close together: one holds the floor at a time.
    const announced = announceNext(h);
    expect(announced.eventId).toBe(first.eventId);
    expect(h.queue.planNext()).toEqual({ action: 'none', reason: 'awaiting-presentation' });

    // The user switches to agent-b's tab and then speaks an answer. The queue
    // routes by the announced event, so it must still reach agent-a.
    expect(h.queue.activeQuestionId('desktop')).toBe(first.eventId);
    const plan = h.queue.resolveAnswer(first.eventId, 'desktop');
    if (plan.action !== 'deliver') throw new Error('expected deliver');
    expect(plan.target.sessionId).toBe('agent-a');
    expect(plan.target.promptId).toBe(first.promptId);

    // agent-b's question is only now eligible.
    expect(announceNext(h).eventId).toBe(second.eventId);
  });

  it('rejects a duplicate answer from a second device instead of double-submitting', () => {
    const h = makeQueue();
    const q = event({ kind: 'question' });
    h.queue.ingest(q);

    const plan = h.queue.planNext();
    if (plan.action !== 'announce') throw new Error('expected announce');
    expect(h.queue.beginAnnouncement(q.eventId, 'desktop')).toBe(true);
    // iPhone races for the same event and loses.
    expect(h.queue.beginAnnouncement(q.eventId, 'iphone')).toBe(false);
    expect(h.queue.markPresented(q.eventId, 'iphone')).toBe(false);
    expect(h.queue.markPresented(q.eventId, 'desktop')).toBe(true);

    expect(h.queue.resolveAnswer(q.eventId, 'iphone')).toEqual({
      action: 'reject',
      reason: 'not-announcing-device',
    });
    expect(h.queue.resolveAnswer(q.eventId, 'desktop').action).toBe('deliver');
    expect(h.queue.resolveAnswer(q.eventId, 'desktop')).toEqual({
      action: 'reject',
      reason: 'already-answered',
    });
  });

  it('releases an unconfirmed announcement so another device can take it', () => {
    const h = makeQueue({ announceTimeoutMs: 5_000 });
    const q = event({ kind: 'question' });
    h.queue.ingest(q);
    expect(h.queue.beginAnnouncement(q.eventId, 'desktop')).toBe(true);

    // Backend acceptance is not proof the user heard audio: desktop never
    // confirmed presentation, so the claim decays.
    h.advance(5_001);
    expect(h.queue.planNext()).toMatchObject({ action: 'announce' });
    expect(h.queue.beginAnnouncement(q.eventId, 'iphone')).toBe(true);
    expect(h.queue.get(q.eventId)?.announcingDeviceId).toBe('iphone');

    // Explicit handoff back to the queue.
    expect(h.queue.handOffAnnouncement(q.eventId, 'iphone', null)).toBe(true);
    expect(h.queue.get(q.eventId)?.status).toBe('queued');
  });

  it('deduplicates the same event arriving by two sync paths', () => {
    const h = makeQueue();
    const q = event({ kind: 'question', promptId: 'p1', source: { sessionId: 's1' } });
    expect(h.queue.ingest(q).accepted).toBe(true);
    expect(h.queue.ingest(q)).toMatchObject({ accepted: false, reason: 'duplicate' });

    // A reconnect can mint a new event id for a prompt we already hold.
    const resync = event({
      kind: 'question',
      eventId: 'evt-resync',
      promptId: 'p1',
      source: { sessionId: 's1' },
    });
    expect(h.queue.ingest(resync)).toMatchObject({ accepted: false, reason: 'duplicate' });
    expect(h.queue.pending()).toHaveLength(1);
  });

  it('coalesces a completion burst from one session but keeps separate sessions apart', () => {
    const h = makeQueue({ completionCoalesceWindowMs: 4_000 });
    const base = { sessionId: 'busy' };
    h.queue.ingest(event({ kind: 'completion', source: base, summary: 'first' }));
    h.advance(500);
    h.queue.ingest(event({ kind: 'completion', source: base, summary: 'second' }));
    h.advance(500);
    h.queue.ingest(event({ kind: 'completion', source: base, summary: 'third' }));
    h.queue.ingest(event({ kind: 'completion', source: { sessionId: 'other' } }));

    const pending = h.queue.pending();
    expect(pending).toHaveLength(2);
    const busy = pending.find((e) => e.source.sessionId === 'busy');
    expect(busy?.coalescedCount).toBe(3);
    expect(busy?.summary).toBe('third');

    // Past the window, a later completion is its own announcement.
    h.advance(4_001);
    h.queue.ingest(event({ kind: 'completion', source: base, summary: 'late' }));
    expect(h.queue.pending()).toHaveLength(3);
  });

  it('never speaks a result from a superseded task revision', () => {
    const h = makeQueue();
    const stale = event({
      kind: 'completion',
      source: { sessionId: 's1', taskId: 't1', taskRevision: 1 },
    });
    h.queue.ingest(stale);

    // The user re-asked: revision 2 is now current.
    h.queue.noteTaskRevision('t1', 2);
    expect(h.queue.get(stale.eventId)?.status).toBe('discarded');
    expect(h.queue.get(stale.eventId)?.discardReason).toBe('superseded');
    expect(h.queue.planNext()).toEqual({ action: 'none', reason: 'empty' });

    // A late arrival from the old revision is refused outright.
    const lateStale = event({
      kind: 'completion',
      source: { sessionId: 's1', taskId: 't1', taskRevision: 1 },
    });
    expect(h.queue.ingest(lateStale)).toMatchObject({ accepted: false, reason: 'superseded' });
  });

  it('discards a question whose prompt stopped being pending instead of announcing it', () => {
    const h = makeQueue();
    const q = event({ kind: 'question', promptId: 'p-gone' });
    const c = event({ kind: 'completion' });
    h.queue.ingest(q);
    h.queue.ingest(c);

    // Answered in the UI before we got to speak it.
    h.resolvePrompt('p-gone');
    const plan = h.queue.planNext();
    expect(plan).toMatchObject({ action: 'announce' });
    if (plan.action !== 'announce') throw new Error('unreachable');
    expect(plan.entry.eventId).toBe(c.eventId);
    expect(h.queue.get(q.eventId)?.discardReason).toBe('prompt-resolved');
  });

  it('revalidates again at answer time', () => {
    const h = makeQueue();
    const q = event({ kind: 'question', promptId: 'p-race' });
    h.queue.ingest(q);
    announceNext(h);

    h.resolvePrompt('p-race');
    expect(h.queue.resolveAnswer(q.eventId, 'desktop')).toEqual({
      action: 'reject',
      reason: 'prompt-no-longer-pending',
    });
  });

  it('holds events while voice is off and does not reopen the session', () => {
    const h = makeQueue({ voiceState: 'off' });
    const q = event({ kind: 'question' });
    h.queue.ingest(q);
    expect(h.queue.planNext()).toEqual({ action: 'none', reason: 'voice-off' });
    expect(h.queue.pending()).toHaveLength(1);

    // Armed-but-sleeping is a different state: a question may restore it.
    h.setVoiceState('sleeping');
    expect(h.queue.planNext()).toMatchObject({ action: 'announce', requiresWake: true });
  });

  it('prioritizes questions and keeps routine completions out of a live conversation', () => {
    const h = makeQueue({ voiceState: 'conversing' });
    const older = event({ kind: 'completion', createdAt: 10 });
    const newerQuestion = event({ kind: 'question', createdAt: 99 });
    h.queue.ingest(older);
    h.queue.ingest(newerQuestion);

    const plan = h.queue.planNext();
    if (plan.action !== 'announce') throw new Error('expected announce');
    expect(plan.entry.eventId).toBe(newerQuestion.eventId);
    expect(plan.requiresWake).toBe(false);

    h.queue.beginAnnouncement(newerQuestion.eventId, 'desktop');
    h.queue.markPresented(newerQuestion.eventId, 'desktop');
    h.queue.resolveAnswer(newerQuestion.eventId, 'desktop');

    // The completion still waits out the conversation.
    expect(h.queue.planNext()).toEqual({ action: 'none', reason: 'busy-conversation' });
    h.setVoiceState('listening');
    expect(h.queue.planNext()).toMatchObject({ action: 'announce' });
  });

  it('does not wake a sleeping session for a routine completion by default', () => {
    const h = makeQueue({ voiceState: 'sleeping' });
    h.queue.ingest(event({ kind: 'completion' }));
    expect(h.queue.planNext()).toEqual({ action: 'none', reason: 'deferred-until-awake' });

    const waking = makeQueue({ voiceState: 'sleeping', wakeForCompletions: true });
    waking.queue.ingest(event({ kind: 'completion' }));
    expect(waking.queue.planNext()).toMatchObject({ action: 'announce', requiresWake: true });
  });

  it('does not let a question answered in the UI block the queue forever', () => {
    const h = makeQueue();
    const q = event({ kind: 'question', promptId: 'p-ui' });
    h.queue.ingest(q);
    announceNext(h);

    // The user answers in the UI rather than by voice, so resolveAnswer is
    // never called. Without revalidation of the floor holder this deadlocks
    // every future announcement from every session.
    h.resolvePrompt('p-ui');
    const c = event({ kind: 'completion' });
    h.queue.ingest(c);

    const plan = h.queue.planNext();
    if (plan.action !== 'announce') throw new Error(`blocked: ${plan.reason}`);
    expect(plan.entry.eventId).toBe(c.eventId);
    expect(h.queue.get(q.eventId)?.discardReason).toBe('prompt-resolved');
  });

  it('stops a still-pending unanswered question from holding the floor forever', () => {
    const h = makeQueue({ presentedQuestionHoldMs: 60_000 });
    const q = event({ kind: 'question' });
    h.queue.ingest(q);
    announceNext(h);
    h.queue.ingest(event({ kind: 'completion' }));

    expect(h.queue.planNext()).toEqual({ action: 'none', reason: 'awaiting-presentation' });

    h.advance(60_001);
    expect(h.queue.planNext()).toMatchObject({ action: 'announce' });
    // The question is still pending and still answerable; it just no longer blocks.
    expect(h.queue.get(q.eventId)?.status).toBe('presented');
    expect(h.queue.resolveAnswer(q.eventId, 'desktop').action).toBe('deliver');
  });

  it('keeps dedup memory for live entries past the remembered-id cap', () => {
    // Cap is 2, so the first completion's id would be evicted FIFO.
    const small = new VoiceEventQueue({
      now: () => 1_000,
      getVoiceState: () => 'listening',
      isPromptPending: () => true,
      maxRememberedEventIds: 2,
    });
    const first = event({ kind: 'completion', eventId: 'c1', source: { sessionId: 's1' } });
    small.ingest(first);
    small.ingest(event({ kind: 'completion', eventId: 'c2', source: { sessionId: 's2' } }));
    small.ingest(event({ kind: 'completion', eventId: 'c3', source: { sessionId: 's3' } }));

    // c1 is still queued, so a redelivery by a second sync path is a duplicate,
    // not a second announcement.
    expect(small.ingest(first)).toMatchObject({ accepted: false, reason: 'duplicate' });
    expect(small.pending()).toHaveLength(3);
  });

  it('keeps a presented question but prunes finished completions', () => {
    const h = makeQueue();
    const q = event({ kind: 'question' });
    const c = event({ kind: 'completion' });
    h.queue.ingest(q);
    h.queue.ingest(c);
    announceNext(h); // question
    h.queue.resolveAnswer(q.eventId, 'desktop');
    announceNext(h); // completion

    h.advance(60_000);
    expect(h.queue.prune(30_000)).toBe(2);
    expect(h.queue.snapshot()).toHaveLength(0);
  });

  it('refuses to answer a question that is only announcing', () => {
    const h = makeQueue();
    const q = event({ kind: 'question' });
    h.queue.ingest(q);
    const plan = h.queue.planNext();
    if (plan.action !== 'announce') throw new Error('expected announce');
    expect(h.queue.beginAnnouncement(q.eventId, 'desktop')).toBe(true);

    // `announcing` means the request to speak was issued and nothing has
    // confirmed the audio reached anyone. The thing "answering" here is a tool
    // call the model chose to make, which is exactly what lower-trust content
    // reaching that model can influence -- so it cannot be the confirmation.
    expect(h.queue.resolveAnswer(q.eventId, 'desktop')).toEqual({
      action: 'reject',
      reason: 'not-announced',
    });

    // Confirmed heard, and the same answer lands.
    expect(h.queue.markPresented(q.eventId, 'desktop')).toBe(true);
    expect(h.queue.resolveAnswer(q.eventId, 'desktop').action).toBe('deliver');
  });

  it('hands an answer claim back when delivering it failed', () => {
    const h = makeQueue();
    const q = event({ kind: 'question' });
    h.queue.ingest(q);
    announceNext(h);
    expect(h.queue.resolveAnswer(q.eventId, 'desktop').action).toBe('deliver');

    // The claim is taken before the answer is persisted, so that a duplicate
    // delivery is a no-op. Without a way to give it back, a failed persist
    // left the question permanently unanswerable with nothing recorded.
    expect(h.queue.releaseAnswer(q.eventId, 'iphone')).toBe(false);
    expect(h.queue.releaseAnswer(q.eventId, 'desktop')).toBe(true);
    expect(h.queue.resolveAnswer(q.eventId, 'desktop').action).toBe('deliver');
  });

  it('distinguishes announcement candidates from everything still open', () => {
    const h = makeQueue();
    const q = event({ kind: 'question' });
    h.queue.ingest(q);
    announceNext(h);

    // `pending()` is the next-to-announce list, so a presented question is
    // absent from it. Reading it as "everything still open" is how voice-off
    // came to leave presented questions holding the next conversation's floor.
    expect(h.queue.pending()).toHaveLength(0);
    expect(h.queue.open().map((entry) => entry.eventId)).toEqual([q.eventId]);

    h.queue.clear();
    expect(h.queue.open()).toHaveLength(0);
    expect(h.queue.snapshot()).toHaveLength(0);
    // Dedup memory goes with it: the next conversation may legitimately need
    // to ask the same question again.
    expect(h.queue.ingest(q)).toMatchObject({ accepted: true });
  });
});
