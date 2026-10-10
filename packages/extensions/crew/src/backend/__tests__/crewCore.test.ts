// @vitest-environment node
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CREW_EXTENSION_ID, type CrewScheduleSpec } from '../../shared/types';
import { checkSelfSchedule, computeNextRunAt } from '../crewTime';
import {
  computeBudgetVerdict,
  decideChapterRoll,
  decideDispatch,
  resolveFlagDelivery,
  type BudgetVerdict,
} from '../crewPolicy';
import { parseCrewMemberFile, serializeCrewMember, splitCrewFile } from '../crewDefinition';
import { appendJournalEntry, ensureMemoryFiles, loadCrewMembers, notesPath, notesRevision, readJournal, readNotes, replaceNotes } from '../crewFiles';
import { fileCache, ledgerFile } from '../crewDataFiles';
import { BadgePublisher, type GutterBadge } from '../crewBadge';
import { parseLedger, recordSnapshot } from '../crewLedger';
import { formatJournalEntry, parseJournalFeed } from '../crewJournal';
import { CrewRuntime, type CrewRuntimeCache } from '../crewRuntime';
import { CrewService } from '../crewService';
import { createCrewToolHandlers } from '../crewTools';
import type {
  CreateSessionInput,
  HostSessions,
  OwnedSession,
  SessionSettledEvent,
  ToolCallContext,
} from '../hostSessions';

const NY = 'America/New_York';
const utc = (iso: string) => Date.parse(iso);
const daily = (time: string): CrewScheduleSpec => ({ daily: time, prompt: 'Review' });
const WITHIN_BUDGET: BudgetVerdict = { overBudget: false, reasons: [], dailyCeiling: 1, retryAtMs: null };

describe('schedule timing', () => {
  it('runs a skipped spring-forward time after the jump and an ambiguous fall-back time once', () => {
    // 2026-03-08: 02:00 EST jumps to 03:00 EDT, so 02:30 does not exist.
    expect(computeNextRunAt(daily('02:30'), utc('2026-03-08T05:00:00Z'), NY)).toBe(utc('2026-03-08T07:30:00Z'));
    // 2026-11-01: 01:30 happens at 05:30Z (EDT) and again at 06:30Z (EST). First only.
    const first = computeNextRunAt(daily('01:30'), utc('2026-11-01T04:00:00Z'), NY);
    expect(first).toBe(utc('2026-11-01T05:30:00Z'));
    expect(computeNextRunAt(daily('01:30'), first!, NY)).toBe(utc('2026-11-02T06:30:00Z'));
  });

  it('skips to the next listed weekday and never re-runs a fired one-shot', () => {
    const monday10am = utc('2026-09-28T14:00:00Z');
    const weekly: CrewScheduleSpec = { weekly: { days: ['monday'], time: '09:00' }, prompt: 'x' };
    expect(computeNextRunAt(weekly, monday10am, NY)).toBe(utc('2026-10-05T13:00:00Z'));
    const at: CrewScheduleSpec = { at: '2026-09-28T15:00:00.000Z', prompt: 'x' };
    expect(computeNextRunAt(at, monday10am, NY)).toBe(utc('2026-09-28T15:00:00Z'));
    expect(computeNextRunAt(at, utc('2026-09-28T15:00:00Z'), NY)).toBeNull();
  });

  it('bounds self-scheduling by quiet hours and shifts per day', () => {
    const base = { nowMs: utc('2026-09-28T14:00:00Z'), timeZone: NY, quietHours: '22:00-08:00', shiftsPerDay: 2 };
    expect(checkSelfSchedule({ ...base, spec: daily('23:00'), otherSpecs: [] })).toMatchObject({ ok: false });
    expect(checkSelfSchedule({ ...base, spec: daily('19:00'), otherSpecs: [daily('09:00'), daily('12:00')] }))
      .toMatchObject({ ok: false });
    expect(checkSelfSchedule({ ...base, spec: daily('19:00'), otherSpecs: [daily('09:00')] })).toEqual({ ok: true });
    expect(checkSelfSchedule({ ...base, spec: { at: '2026-09-28T13:00:00Z', prompt: 'x' }, otherSpecs: [] }))
      .toMatchObject({ ok: false });
  });
});

describe('shift decisions', () => {
  const now = utc('2026-09-28T16:00:00Z'); // 12:00 in New York
  const dispatch = (overrides: Partial<Parameters<typeof decideDispatch>[0]>) => decideDispatch({
    pending: [{ trigger: 'child-session', createdAtMs: now - 60_000 }],
    onShift: false,
    paused: false,
    budget: WITHIN_BUDGET,
    nowMs: now,
    timeZone: NY,
    ...overrides,
  });

  it('coalesces bursty wakes, queues behind a running shift, defers for quiet hours, and lets the user through', () => {
    expect(dispatch({})).toEqual({ action: 'defer', untilMs: now - 60_000 + 10 * 60_000, reason: 'coalescing' });
    expect(dispatch({ pending: [{ trigger: 'child-session', createdAtMs: now - 11 * 60_000 }] })).toEqual({ action: 'start' });
    expect(dispatch({ pending: [{ trigger: 'schedule', createdAtMs: now }] })).toEqual({ action: 'start' });
    expect(dispatch({ onShift: true })).toEqual({ action: 'blocked', reason: 'on-shift' });
    const night = utc('2026-09-29T03:00:00Z'); // 23:00 local
    expect(dispatch({ nowMs: night, quietHours: '22:00-08:00', pending: [{ trigger: 'schedule', createdAtMs: night }] }))
      .toEqual({ action: 'defer', untilMs: utc('2026-09-29T12:00:00Z'), reason: 'quiet-hours' });
    expect(dispatch({ nowMs: night, quietHours: '22:00-08:00', pending: [{ trigger: 'child-session', createdAtMs: night, urgent: true }] }))
      .toEqual({ action: 'start' });
    expect(dispatch({ nowMs: night, quietHours: '22:00-08:00', pending: [{ trigger: 'user', createdAtMs: night }] }))
      .toEqual({ action: 'start' });
  });

  it('derives the daily ceiling as a third of the weekly cap and retries calendar caps at local midnight', () => {
    const input = {
      memberTokensWeek: 0, memberTokensToday: 0, shiftsToday: 0, tokensPerWeek: 3_000, shiftsPerDay: 4,
      crewTokensWeek: 0, crewTokensPerWeek: 1_000_000, nowMs: now, timeZone: NY,
    };
    expect(computeBudgetVerdict({ ...input, memberTokensToday: 999 }).overBudget).toBe(false);
    const dailyCap = computeBudgetVerdict({ ...input, memberTokensToday: 1_000 });
    expect(dailyCap).toMatchObject({ overBudget: true, reasons: ['daily-tokens'], dailyCeiling: 1_000 });
    expect(dailyCap.retryAtMs).toBe(utc('2026-09-29T04:00:00Z'));
    const weekly = computeBudgetVerdict({ ...input, crewTokensWeek: 1_000_000 });
    expect(weekly.reasons).toEqual(['crew-weekly-tokens']);
    expect(weekly.retryAtMs).toBe(now + 60 * 60_000);
    expect(dispatch({ pending: [{ trigger: 'schedule', createdAtMs: now }], budget: dailyCap }))
      .toEqual({ action: 'defer', untilMs: dailyCap.retryAtMs, reason: 'over-budget' });
  });

  it('rolls a chapter at 70% measured context or one week, and not otherwise', () => {
    const start = now - 6 * 24 * 3_600_000;
    expect(decideChapterRoll({ chapterStartedAtMs: start, nowMs: now, contextTokens: 69, contextWindow: 100 }).roll).toBe(false);
    expect(decideChapterRoll({ chapterStartedAtMs: start, nowMs: now, contextTokens: 70, contextWindow: 100 }))
      .toMatchObject({ roll: true, reason: 'context' });
    expect(decideChapterRoll({ chapterStartedAtMs: now - 7 * 24 * 3_600_000, nowMs: now }))
      .toMatchObject({ roll: true, reason: 'age' });
  });

  it('caps flag levels at maxLevel and keeps quiet-hours flags in the feed only', () => {
    expect(resolveFlagDelivery('page', 'flag', false)).toEqual({ level: 'flag', osNotification: true, mobilePush: false });
    expect(resolveFlagDelivery('page', 'page', false)).toEqual({ level: 'page', osNotification: true, mobilePush: true });
    expect(resolveFlagDelivery('page', 'page', true)).toEqual({ level: 'page', osNotification: false, mobilePush: false });
    expect(resolveFlagDelivery('flag', 'note', false)).toEqual({ level: 'note', osNotification: false, mobilePush: false });
  });
});

// ─── Files (real files in a temp workspace) ───────────────────────────────

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeWorkspace(files: Record<string, string>): string {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-ext-'));
  tempDirs.push(workspace);
  const dir = path.join(workspace, 'nimbalyst-local', 'crew');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return workspace;
}

const ADA = `---
crew:
  name: Ada
  role: Architect
  autonomy: delegate-in-worktree
  notify:
    maxLevel: flag
  schedule:
    - daily: "18:30"
      prompt: Review today's work.
  triggers:
    - sessionsCompleted: { minCount: 5 }
---
You are the architect.
`;

describe('definition and journal files', () => {
  it('surfaces a malformed member beside valid ones, ignores retired autonomy, and keeps unknown keys', async () => {
    const workspace = makeWorkspace({ 'ada.md': ADA, 'broken.md': '---\ncrew:\n  name: [unclosed\n---\n', 'Bad Name.md': ADA });
    const members = await loadCrewMembers(workspace);
    expect(members.map((m) => [m.slug, m.errors.length > 0])).toEqual([['Bad Name', true], ['ada', false], ['broken', true]]);
    const ada = members.find((m) => m.slug === 'ada')!.definition;
    expect(ada).toMatchObject({ provider: 'claude-code', model: 'sonnet', budget: { tokensPerWeek: 60_000_000 } });
    expect(ada).not.toHaveProperty('autonomy');

    const rewritten = serializeCrewMember({ ...ada, name: 'Ada L.' }, (splitCrewFile(ADA).frontmatter as any).crew);
    const crew = (splitCrewFile(rewritten).frontmatter as any).crew;
    expect(crew.triggers).toEqual([{ sessionsCompleted: { minCount: 5 } }]);
    expect(crew).not.toHaveProperty('autonomy');
    const reparsed = parseCrewMemberFile('ada', ada.sourcePath, rewritten);
    expect(reparsed.ok && reparsed.definition).toEqual({ ...ada, name: 'Ada L.' });
  });

  it('round-trips structured journal entries into the feed, including "--" in text, and skips hand-written sections', () => {
    const entry = formatJournalEntry({
      kind: 'flag', level: 'page', title: 'Main is red -- again', body: 'CI failed.', atMs: utc('2026-09-28T16:00:00Z'),
      evidence: [{ kind: 'session', sessionId: 's1' }],
    }, NY);
    const journal = `# Journal\n\n## My own note\n\nNo marker here.\n\n## ${entry.heading}\n\n${entry.body}\n`;
    expect(parseJournalFeed('ada', journal)).toEqual([{
      id: 'ada:2026-09-28T16:00:00.000Z:1', memberSlug: 'ada', at: '2026-09-28T16:00:00.000Z', kind: 'flag',
      title: 'Main is red -- again', body: 'CI failed.', level: 'page', evidence: [{ kind: 'session', sessionId: 's1' }],
    }]);
  });
});

// ─── Runtime against a fake host session API ─────────────────────────────

type FakeSession = OwnedSession & {
  lastResponse?: string;
  contextFill?: { tokens: number; contextWindow: number };
  totalTokens: number;
};

/** A usage row whose all-tokens total is `allTokens`; input+output is deliberately smaller, as with cache-heavy turns. */
function usageOf(allTokens: number) {
  return {
    inputTokens: 0, outputTokens: Math.floor(allTokens / 10), totalTokens: Math.floor(allTokens / 10), costUSD: 0,
    cacheReadInputTokens: allTokens - Math.floor(allTokens / 10), cacheCreationInputTokens: 0, allTokens,
  };
}

class FakeSessions implements HostSessions {
  sessions = new Map<string, FakeSession>();
  created: CreateSessionInput[] = [];
  sent: Array<{ sessionId: string; prompt: string }> = [];
  notified: Array<{ title: string; urgency?: string }> = [];
  private seq = 0;

  constructor(private readonly clock: { now: number } = { now: 0 }) {}

  add(session: Partial<FakeSession> & { sessionId: string; key: string }): void {
    this.sessions.set(session.sessionId, {
      title: session.sessionId, sessionType: 'session', workstreamId: null, createdBySessionId: null, status: 'idle',
      hasPendingPrompt: false, queuedPromptCount: 0, createdAt: this.clock.now, updatedAt: this.clock.now,
      ownerMetadata: {}, totalTokens: 0, ...session,
    });
  }
  async create(input: CreateSessionInput) {
    const sessionId = `chapter-${++this.seq}`;
    this.created.push(input);
    this.add({ sessionId, key: input.ownerKey, title: input.name, status: 'running', ownerMetadata: { ...input.ownerMetadata } });
    if (input.prompt) this.sent.push({ sessionId, prompt: input.prompt });
    return { sessionId, queuedPromptId: null };
  }
  async createWorkstream(input: { name: string; ownerKey: string; ownerMetadata?: Record<string, unknown> }) {
    const workstreamId = `ws-${++this.seq}`;
    this.add({ sessionId: workstreamId, key: input.ownerKey, sessionType: 'workstream', ownerMetadata: { ...input.ownerMetadata } });
    return { workstreamId };
  }
  async sendPrompt(sessionId: string, prompt: string) {
    this.sent.push({ sessionId, prompt });
    return { queuedPromptId: `q${this.sent.length}` };
  }
  async getStatus(sessionId: string) {
    const s = this.sessions.get(sessionId)!;
    return {
      sessionId, status: s.status, title: s.title, lastActivity: s.updatedAt, updatedAt: s.updatedAt,
      hasPendingPrompt: s.hasPendingPrompt, queuedPromptCount: s.queuedPromptCount,
    };
  }
  async getResult(sessionId: string) {
    const s = this.sessions.get(sessionId)!;
    return {
      sessionId, status: s.status, lastResponse: s.lastResponse ?? null, errorMessage: null,
      contextFill: s.contextFill ?? null, pendingPrompt: null, editedFiles: [],
    };
  }
  async listOwned(input?: { key?: string }) {
    return [...this.sessions.values()]
      .filter((s) => !input?.key || s.key === input.key)
      .map(({ lastResponse: _t, contextFill: _c, totalTokens: _u, ...summary }) => structuredClone(summary));
  }
  async getUsage(input: { key?: string; since: number }) {
    const rows = [...this.sessions.values()]
      .filter((s) => (!input.key || s.key === input.key) && s.updatedAt >= input.since)
      .map((s) => ({ sessionId: s.sessionId, key: s.key, lastActivity: s.updatedAt, ...usageOf(s.totalTokens) }));
    const allTokens = rows.reduce((sum, row) => sum + row.allTokens, 0);
    return { since: input.since, totals: usageOf(allTokens), sessions: rows };
  }
  async updateOwnerMetadata(sessionId: string, patch: Record<string, unknown>) {
    const s = this.sessions.get(sessionId)!;
    Object.assign(s.ownerMetadata, patch);
    return { ownerMetadata: s.ownerMetadata };
  }
  async notifyUser(input: { title: string; urgency?: 'low' | 'normal' | 'critical' }) {
    this.notified.push({ title: input.title, urgency: input.urgency });
  }
  onSettled() {
    return () => {};
  }
  /** The session goes idle having spent `totalTokens` over its life so far. */
  finish(sessionId: string, lastResponse: string, queuedPromptCount = 0, totalTokens?: number): SessionSettledEvent {
    const s = this.sessions.get(sessionId)!;
    Object.assign(s, { status: 'idle', lastResponse, queuedPromptCount, updatedAt: this.clock.now });
    if (totalTokens !== undefined) s.totalTokens = totalTokens;
    return {
      sessionId, ownerKey: s.key, outcome: 'completed', createdBySessionId: s.createdBySessionId, workstreamId: s.workstreamId,
      at: this.clock.now, tokenUsage: usageOf(s.totalTokens),
    };
  }
}

function runtimeAt(workspacePath: string, sessions: FakeSessions, clock: { now: number }, cache?: { value: CrewRuntimeCache | null }) {
  return new CrewRuntime({
    workspacePath,
    sessions,
    now: () => clock.now,
    timeZone: () => NY,
    setTimer: () => 'timer',
    clearTimer: () => {},
    ...(cache ? { cache: { load: async () => cache.value, save: async (value) => { cache.value = value; } } } : {}),
  });
}

describe('crew runtime', () => {
  it('runs a week of missed schedules as one shift on the next launch, and not again once it ran', async () => {
    const workspace = makeWorkspace({ 'ada.md': ADA });
    const clock = { now: 0 };
    const sessions = new FakeSessions(clock);
    const cache = { value: null as CrewRuntimeCache | null };

    // Launch 1, Sunday noon: nothing is due yet; how far the schedule was processed is cached.
    clock.now = utc('2026-09-20T16:00:00Z');
    const first = runtimeAt(workspace, sessions, clock, cache);
    await first.start();
    first.stop();
    expect(sessions.sent).toEqual([]);

    // Launch 2, a week later: seven 18:30 runs were missed while closed.
    clock.now = utc('2026-09-27T16:00:00Z');
    const second = runtimeAt(workspace, sessions, clock, cache);
    await second.start();
    expect(sessions.created).toHaveLength(1);
    expect(sessions.created[0]).toMatchObject({
      ownerKey: 'ada', provider: 'claude-code', model: 'claude-code:sonnet', routeChildUpdatesToOwner: true,
      ownerMetadata: { kind: 'chapter', chapterIndex: 1 },
      name: 'Ada - Chapter 1',
    });
    expect(sessions.created[0].directive).toContain('## Crew member: Ada (Architect)');
    expect(sessions.created[0].directive).not.toContain('2026');
    expect(sessions.sent[0].prompt).toContain('closed through 7 scheduled runs');
    expect(second.memberState('ada').onShift).toBe(true);

    await second.onSettled(sessions.finish(sessions.sent[0].sessionId, 'Reviewed the week.'));
    expect(second.memberState('ada').onShift).toBe(false);
    expect(parseJournalFeed('ada', await readJournal(workspace, 'ada')).map((e) => [e.kind, e.body]))
      .toEqual([['shift', 'Reviewed the week.']]);
    second.stop();

    // Launch 3 with no cache: the chapter's last shift is the anchor, so nothing re-runs.
    clock.now = utc('2026-09-27T17:00:00Z');
    const third = runtimeAt(workspace, sessions, clock);
    await third.start();
    third.stop();
    expect(sessions.sent).toHaveLength(1);
  });

  it('wakes the member in its current chapter, not the rolled one that spawned the work, and queues mid-shift wakes', async () => {
    const workspace = makeWorkspace({ 'ada.md': ADA });
    const clock = { now: 0 };
    const sessions = new FakeSessions(clock);
    sessions.add({ sessionId: 'ws', key: 'ada', sessionType: 'workstream' });
    sessions.add({ sessionId: 'ch1', key: 'ada', ownerMetadata: {
      kind: 'chapter', chapterIndex: 1, startedAt: '2026-09-20T12:00:00Z', endedAt: '2026-09-27T12:00:00Z',
    } });
    sessions.add({ sessionId: 'ch2', key: 'ada', ownerMetadata: {
      kind: 'chapter', chapterIndex: 2, startedAt: '2026-09-27T12:00:00Z', lastShiftStartedAt: '2026-09-28T12:00:00Z',
      shiftStarts: ['2026-09-28T12:00:00Z'],
    } });
    sessions.add({ sessionId: 'child', key: 'ada', title: 'Fix sync', createdBySessionId: 'ch1' });
    sessions.add({ sessionId: 'child2', key: 'ada', title: 'Add test', createdBySessionId: 'ch1' });
    clock.now = utc('2026-09-28T14:00:00Z');
    const runtime = runtimeAt(workspace, sessions, clock);
    await runtime.start();

    await runtime.onSettled(sessions.finish('child', 'Sync fixed.'));
    expect(sessions.sent).toEqual([]); // inside the coalescing window
    expect(runtime.memberState('ada').heldCount).toBe(1);

    clock.now += 11 * 60_000;
    await runtime.onDefinitionsChanged();
    expect(sessions.created).toEqual([]);
    expect(sessions.sent).toHaveLength(1);
    expect(sessions.sent[0].sessionId).toBe('ch2');
    expect(sessions.sent[0].prompt).toContain('Delegated session "Fix sync" (child) finished.');
    expect(sessions.sessions.get('ch2')!.ownerMetadata.shiftStarts).toHaveLength(2);

    // Mid-shift: the next wake joins the running shift instead of starting another.
    await runtime.onSettled(sessions.finish('child2', 'Test added.'));
    expect(sessions.sent.map((s) => s.sessionId)).toEqual(['ch2', 'ch2']);
    expect(sessions.sent[1].prompt).toMatch(/^\[Crew\] From a session you delegated/);

    // Idle with a queued follow-up: still the same shift. Then done.
    await runtime.onSettled(sessions.finish('ch2', 'partial', 1));
    expect(runtime.memberState('ada').onShift).toBe(true);
    await runtime.onSettled(sessions.finish('ch2', 'Checked both.'));
    expect(runtime.memberState('ada').onShift).toBe(false);
    runtime.stop();
  });

  it('asks for a handoff when a chapter fills, then closes it into notes', async () => {
    const workspace = makeWorkspace({ 'ada.md': ADA });
    const clock = { now: 0 };
    const sessions = new FakeSessions(clock);
    clock.now = utc('2026-09-28T14:00:00Z');
    const runtime = runtimeAt(workspace, sessions, clock);
    await runtime.start();
    const started = await runtime.startShift('ada', 'Look at the sync refactor.');
    expect(started).toMatchObject({ outcome: 'started', chapterIndex: 1 });

    sessions.sessions.get(started.chapterSessionId)!.contextFill = { tokens: 150_000, contextWindow: 200_000 };
    await runtime.onSettled(sessions.finish(started.chapterSessionId, 'Looked.'));
    expect(sessions.sent.at(-1)!.prompt).toContain('[Crew chapter ending] Chapter 1');
    expect(runtime.memberState('ada').onShift).toBe(true);

    await runtime.onSettled(sessions.finish(started.chapterSessionId, 'Watch the sync retry loop.'));
    expect(runtime.memberState('ada').onShift).toBe(false);
    expect(sessions.sessions.get(started.chapterSessionId)!.ownerMetadata).toMatchObject({
      endedAt: expect.any(String), handoffSummary: 'Watch the sync retry loop.',
    });
    expect(await readNotes(workspace, 'ada')).toContain('Watch the sync retry loop.');

    // The next shift starts chapter 2 in the same workstream.
    const next = await runtime.startShift('ada');
    expect(next).toMatchObject({ outcome: 'started', chapterIndex: 2 });
    expect(sessions.created[1].workstreamId).toBe(sessions.created[0].workstreamId);
    runtime.stop();
  });
});

describe('usage ledger', () => {
  const DAY = 24 * 3_600_000;

  it('charges settle deltas and reconciled never-settled sessions once, in their window, and estimates when the ledger is damaged', async () => {
    const workspace = makeWorkspace({ 'ada.md': ADA });
    const clock = { now: utc('2026-09-28T16:00:00Z') }; // 12:00 in New York
    const sessions = new FakeSessions(clock);
    sessions.add({ sessionId: 'ch', key: 'ada', totalTokens: 1_000, createdAt: clock.now - DAY, ownerMetadata: {
      kind: 'chapter', chapterIndex: 1, startedAt: new Date(clock.now - DAY).toISOString(),
    } });
    // Delegated work that ran this morning while the project was closed; it will never settle again.
    sessions.add({ sessionId: 'child', key: 'ada', createdBySessionId: 'ch', totalTokens: 400, createdAt: clock.now - 3 * 3_600_000, updatedAt: clock.now - 2 * 3_600_000 });
    const saved: { value: unknown } = {
      value: {
        version: 1, startedAtMs: clock.now - 10 * DAY,
        snapshots: { ch: { key: 'ada', totalTokens: 1_000, atMs: clock.now - 9 * DAY, basis: 'all' } },
        entries: [{ atMs: clock.now - 9 * DAY, key: 'ada', sessionId: 'ch', tokens: 1_000, basis: 'all' }],
      },
    };
    const ledger = { load: async () => saved.value, save: async (data: unknown) => { saved.value = structuredClone(data); }, setAside: async () => 'aside' };
    const runtime = new CrewRuntime({ workspacePath: workspace, sessions, now: () => clock.now, timeZone: () => NY, setTimer: () => 't', clearTimer: () => {}, ledger });
    const service = new CrewService(runtime);
    await runtime.start();

    const settle = sessions.finish('ch', 'Between shifts.', 0, 1_600);
    await runtime.onSettled(settle);
    await runtime.onSettled(settle); // a repeated settle for the same state charges nothing
    await runtime.startShift('ada'); // reconciles before the budget check
    await runtime.onSettled(sessions.finish('ch', 'Done.', 0, 1_600));
    const usage = (await service.member('ada'))!.runtime.usage;
    expect(usage).toMatchObject({ source: 'ledger', tokensThisWeek: 1_000, tokensToday: 1_000 });
    expect((saved.value as { entries: unknown[] }).entries).toEqual([
      { atMs: clock.now, key: 'ada', sessionId: 'ch', tokens: 600, basis: 'all' },
      { atMs: clock.now - 2 * 3_600_000, key: 'ada', sessionId: 'child', tokens: 400, basis: 'all' },
    ]);
    runtime.stop();

    // A damaged ledger is set aside, never trusted, and the roster says the numbers are estimates.
    saved.value = { version: 99 };
    const fresh = new CrewRuntime({ workspacePath: workspace, sessions, now: () => clock.now, timeZone: () => NY, setTimer: () => 't', clearTimer: () => {}, ledger });
    await fresh.start();
    const estimate = (await new CrewService(fresh).member('ada'))!.runtime.usage;
    expect(estimate).toMatchObject({ source: 'session-estimate', tokensThisWeek: 2_000 });
    expect(saved.value).toMatchObject({ version: 1, entries: [] });
    fresh.stop();
  });
});

describe('review fixes', () => {
  const DAY = 24 * 3_600_000;
  const MIN = 60_000;

  it('lets only one of two concurrent notes replacements from the same base win', async () => {
    const workspace = makeWorkspace({ 'ada.md': ADA });
    await ensureMemoryFiles(workspace, 'ada');
    const base = await readNotes(workspace, 'ada');
    const results = await Promise.allSettled([
      replaceNotes(workspace, 'ada', 'Version A', { content: base }),
      replaceNotes(workspace, 'ada', 'Version B', { content: base }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
  });

  it('fires an interval schedule on time even though the scheduler polls more often than the interval', async () => {
    const quinn = '---\ncrew:\n  name: Quinn\n  role: QA\n  schedule:\n    - interval: { minutes: 15 }\n      prompt: Check.\n---\nQA.\n';
    const workspace = makeWorkspace({ 'quinn.md': quinn });
    const clock = { now: utc('2026-09-28T16:00:00Z') };
    const sessions = new FakeSessions(clock);
    const runtime = runtimeAt(workspace, sessions, clock);
    await runtime.start();
    for (let tick = 0; tick < 12; tick += 1) {
      clock.now += 5 * MIN;
      await runtime.onDefinitionsChanged();
      if (runtime.memberState('quinn').onShift) await runtime.onSettled(sessions.finish(sessions.sent.at(-1)!.sessionId, 'Checked.'));
    }
    runtime.stop();
    expect(sessions.sent.map((sent) => sent.prompt.includes('Check.'))).toEqual([true, true, true, true]);
  });

  it('records the user talking to a chapter between shifts as a user shift', async () => {
    const workspace = makeWorkspace({ 'ada.md': ADA });
    const clock = { now: utc('2026-09-28T16:00:00Z') };
    const sessions = new FakeSessions(clock);
    sessions.add({ sessionId: 'ch', key: 'ada', status: 'running', ownerMetadata: {
      kind: 'chapter', chapterIndex: 1, startedAt: new Date(clock.now - DAY).toISOString(),
    } });
    const runtime = runtimeAt(workspace, sessions, clock);
    const service = new CrewService(runtime);
    await runtime.start();
    expect((await service.member('ada'))!.runtime.status).toBe('on-shift');

    await runtime.onSettled(sessions.finish('ch', 'Answered the user.'));
    const feed = parseJournalFeed('ada', await readJournal(workspace, 'ada'));
    expect(feed.map((entry) => [entry.kind, entry.trigger, entry.body])).toEqual([['shift', 'user', 'Answered the user.']]);
    expect((await service.member('ada'))!.runtime.usage.shiftsToday).toBe(1);
    runtime.stop();
  });

  it('asks an expired idle chapter for its handoff before starting the next one', async () => {
    const workspace = makeWorkspace({ 'ada.md': ADA });
    const clock = { now: utc('2026-09-28T16:00:00Z') };
    const sessions = new FakeSessions(clock);
    sessions.add({ sessionId: 'old', key: 'ada', ownerMetadata: {
      kind: 'chapter', chapterIndex: 1, startedAt: new Date(clock.now - 8 * DAY).toISOString(),
    } });
    const runtime = runtimeAt(workspace, sessions, clock);
    await runtime.start();
    expect(await runtime.startShift('ada', 'Review the sync refactor.')).toMatchObject({ outcome: 'queued', chapterSessionId: 'old' });
    expect(sessions.created).toEqual([]);
    expect(sessions.sent.map((sent) => [sent.sessionId, sent.prompt.startsWith('[Crew chapter ending] Chapter 1')])).toEqual([['old', true]]);

    await runtime.onSettled(sessions.finish('old', 'Keep an eye on sync retries.'));
    expect(sessions.sessions.get('old')!.ownerMetadata).toMatchObject({ handoffSummary: 'Keep an eye on sync retries.' });
    expect(await readNotes(workspace, 'ada')).toContain('Keep an eye on sync retries.');
    expect(sessions.created).toHaveLength(1);
    expect(sessions.created[0].ownerMetadata).toMatchObject({ chapterIndex: 2 });
    expect(sessions.created[0].prompt).toContain('Review the sync refactor.');
    runtime.stop();
  });

  it('keeps legacy input+output entries as they are and re-baselines a legacy snapshot instead of charging its cache history', () => {
    const ledger = parseLedger({
      version: 1, startedAtMs: 0,
      snapshots: { pat: { key: 'pat', totalTokens: 6_756, atMs: 1 } },
      entries: [{ atMs: 1, key: 'pat', sessionId: 'pat', tokens: 6_756 }],
    })!;
    // First all-tokens total for the same session: the difference is a change of basis, not new usage.
    recordSnapshot(ledger, { sessionId: 'pat', key: 'pat', tokens: 2_000_000, atMs: 2 });
    recordSnapshot(ledger, { sessionId: 'pat', key: 'pat', tokens: 2_500_000, atMs: 3 });
    expect(ledger.entries.map((entry) => [entry.tokens, entry.basis ?? 'total'])).toEqual([[6_756, 'total'], [500_000, 'all']]);
    expect(ledger.snapshots.pat).toMatchObject({ basis: 'all', totalTokens: 2_500_000 });
  });

  it('re-baselines a malformed ledger snapshot from what was already charged, and ignores a non-numeric total', () => {
    const ledger = parseLedger({
      version: 1, startedAtMs: 0,
      snapshots: { s: { key: 'ada', totalTokens: 'invalid', atMs: 1, basis: 'all' } },
      entries: [{ atMs: 1, key: 'ada', sessionId: 's', tokens: 300, basis: 'all' }],
    })!;
    expect(ledger).not.toBeNull();
    recordSnapshot(ledger, { sessionId: 's', key: 'ada', tokens: 500, atMs: 2 });
    expect(recordSnapshot(ledger, { sessionId: 's', key: 'ada', tokens: Number.NaN, atMs: 3 })).toBe(false);
    recordSnapshot(ledger, { sessionId: 's', key: 'ada', tokens: 700, atMs: 4 });
    expect(ledger.entries.map((entry) => entry.tokens)).toEqual([300, 200, 200]);
  });

  it('wakes the member once, on reopen, for delegated sessions that settled while the project was closed', async () => {
    const workspace = makeWorkspace({ 'ada.md': ADA });
    const clock = { now: utc('2026-09-28T16:00:00Z') };
    const sessions = new FakeSessions(clock);
    sessions.add({ sessionId: 'ch', key: 'ada', ownerMetadata: {
      kind: 'chapter', chapterIndex: 1, startedAt: new Date(clock.now - DAY).toISOString(),
      lastShiftStartedAt: new Date(clock.now - 3 * 3_600_000).toISOString(),
    } });
    sessions.add({ sessionId: 'old', key: 'ada', title: 'Old work', createdBySessionId: 'ch', updatedAt: clock.now - 2 * 3_600_000 });
    sessions.add({ sessionId: 'child', key: 'ada', title: 'Fix sync', createdBySessionId: 'ch', updatedAt: clock.now - 30 * MIN, lastResponse: 'Fixed.' });
    sessions.add({ sessionId: 'busy', key: 'ada', title: 'Still going', createdBySessionId: 'ch', status: 'running', updatedAt: clock.now - 10 * MIN });
    const cache = { value: { firedThrough: {}, held: {}, lastAliveMs: clock.now - 3_600_000 } as CrewRuntimeCache };

    const runtime = runtimeAt(workspace, sessions, clock, cache);
    await runtime.start();
    expect(runtime.memberState('ada').heldCount).toBe(1);
    clock.now += 11 * MIN;
    await runtime.onDefinitionsChanged();
    runtime.stop();
    expect(sessions.sent).toHaveLength(1);
    expect(sessions.sent[0].sessionId).toBe('ch');
    expect(sessions.sent[0].prompt).toContain('(child)');
    expect(sessions.sent[0].prompt).not.toContain('(old)');
    expect(sessions.sent[0].prompt).not.toContain('(busy)');

    // The next reopen does not wake it again for the same sessions.
    const again = runtimeAt(workspace, sessions, clock, cache);
    await again.start();
    expect(again.memberState('ada').heldCount).toBe(0);
    again.stop();
  });
});

describe('live-check fixes', () => {
  const DAY = 24 * 3_600_000;

  it('reads budgets from a new ledger when every session in the window started after it, and estimates only for older sessions', async () => {
    const workspace = makeWorkspace({ 'ada.md': ADA });
    const clock = { now: utc('2026-09-28T16:00:00Z') };
    const sessions = new FakeSessions(clock);
    const saved: { value: unknown } = { value: null };
    const ledger = { load: async () => saved.value, save: async (data: unknown) => { saved.value = structuredClone(data); }, setAside: async () => null };
    const make = () => new CrewRuntime({ workspacePath: workspace, sessions, now: () => clock.now, timeZone: () => NY, setTimer: () => 't', clearTimer: () => {}, ledger });

    const runtime = make();
    await runtime.start();
    const { chapterSessionId } = await runtime.startShift('ada');
    clock.now += 60_000;
    await runtime.onSettled(sessions.finish(chapterSessionId, 'Standup written.', 0, 6_756));
    runtime.stop();
    // Reload: the ledger file is a day old, but nothing it could have missed exists.
    clock.now += DAY;
    const reloaded = make();
    await reloaded.start();
    expect((await new CrewService(reloaded).member('ada'))!.runtime.usage).toMatchObject({ source: 'ledger', tokensThisWeek: 6_756 });
    reloaded.stop();

    // A session that predates the ledger and was active this week makes the window an estimate.
    sessions.add({ sessionId: 'legacy', key: 'ada', createdAt: clock.now - 30 * DAY, updatedAt: clock.now - 2 * DAY, totalTokens: 1_000 });
    saved.value = { version: 1, startedAtMs: clock.now - DAY, snapshots: {}, entries: [] };
    const older = make();
    await older.start();
    expect((await new CrewService(older).member('ada'))!.runtime.usage.source).toBe('session-estimate');
    older.stop();
  });

  it('counts flags raised since the member or the feed was last seen as unread', async () => {
    const workspace = makeWorkspace({ 'ada.md': ADA });
    const clock = { now: utc('2026-09-28T16:00:00Z') };
    const sessions = new FakeSessions(clock);
    const runtime = runtimeAt(workspace, sessions, clock);
    const service = new CrewService(runtime);
    const tools = createCrewToolHandlers(runtime, service);
    const asAda: ToolCallContext = { sessionId: 'ada-ch', workspacePath: workspace, caller: 'agent', sessionOwner: { extensionId: CREW_EXTENSION_ID, key: 'ada' } };
    const panel: ToolCallContext = { sessionId: null, workspacePath: workspace, caller: 'panel', sessionOwner: null };
    const unread = async () => (await service.roster()).members[0].runtime.unreadCount;
    await runtime.start();

    await tools.flag({ level: 'note', title: 'Standup ready', body: '' }, asAda);
    expect(await unread()).toBe(1);
    clock.now += 60_000;
    await tools.panel_mark_seen({ slug: 'ada' }, panel);
    expect(await unread()).toBe(0);
    clock.now += 60_000;
    await tools.flag({ level: 'flag', title: 'Stalled session', body: '' }, asAda);
    await tools.journal_append({ text: 'Not a flag.' }, asAda);
    expect(await unread()).toBe(1);
    clock.now += 60_000;
    await tools.panel_mark_seen({}, panel);
    expect(await unread()).toBe(0);
    runtime.stop();
  });
});

describe('R2 fixes', () => {
  const DAY = 24 * 3_600_000;

  it('keeps the runtime cache and the ledger valid when saves overlap', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-data-'));
    tempDirs.push(dir);
    const cache = fileCache(dir);
    const ledger = ledgerFile(dir);
    const saves = await Promise.allSettled([
      ...Array.from({ length: 30 }, (_, i) => cache.save({ firedThrough: { ada: i }, held: {} })),
      ...Array.from({ length: 30 }, (_, i) => ledger.save({ version: 1, startedAtMs: i, snapshots: {}, entries: [] })),
    ]);
    expect(saves.filter((result) => result.status === 'rejected')).toEqual([]);
    expect(await cache.load()).toEqual({ firedThrough: { ada: 29 }, held: {} });
    expect(await ledger.load()).toEqual({ version: 1, startedAtMs: 29, snapshots: {}, entries: [] });
    expect(fs.readdirSync(dir).sort()).toEqual(['runtime-cache.json', 'usage-ledger.json']);
  });

  it('enforces the crew-wide cap with usage from members other than the one about to run', async () => {
    const workspace = makeWorkspace({ 'ada.md': ADA, 'pat.md': ADA.replace('name: Ada', 'name: Pat') });
    const clock = { now: utc('2026-09-28T16:00:00Z') };
    const sessions = new FakeSessions(clock);
    // Pat spent 2,000 tokens that never reached the ledger (it settled while the project was closed).
    sessions.add({ sessionId: 'pat-ch', key: 'pat', totalTokens: 2_000, createdAt: clock.now - DAY, updatedAt: clock.now - 3_600_000 });
    const saved: { value: unknown } = { value: { version: 1, startedAtMs: clock.now - 10 * DAY, snapshots: {}, entries: [] } };
    const ledger = { load: async () => saved.value, save: async (data: unknown) => { saved.value = structuredClone(data); }, setAside: async () => null };
    const runtime = new CrewRuntime({
      workspacePath: workspace, sessions, now: () => clock.now, timeZone: () => NY, setTimer: () => 't', clearTimer: () => {},
      ledger, crewTokensPerWeek: 1_000,
    });
    await runtime.start();
    await runtime.enqueueWake('ada', { trigger: 'schedule', prompt: 'Review.', createdAtMs: clock.now });
    expect(sessions.sent).toEqual([]);
    expect((await new CrewService(runtime).roster()).crewUsage).toMatchObject({ source: 'ledger', tokensThisWeek: 2_000, overBudget: true });
    runtime.stop();
  });

  it('refuses member file IO through a symlink that leaves the crew folder', async () => {
    const workspace = makeWorkspace({ 'ada.md': ADA });
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-outside-'));
    tempDirs.push(outside);
    fs.symlinkSync(outside, path.join(workspace, 'nimbalyst-local', 'crew', 'ada'));
    await expect(appendJournalEntry(workspace, 'ada', { heading: 'x', body: 'y' })).rejects.toThrow('outside');
    await expect(readNotes(workspace, 'ada')).rejects.toThrow('outside');
    expect(fs.readdirSync(outside)).toEqual([]);

    const secret = path.join(outside, 'secret.md');
    fs.writeFileSync(secret, ADA);
    fs.symlinkSync(secret, path.join(workspace, 'nimbalyst-local', 'crew', 'eve.md'));
    const eve = (await loadCrewMembers(workspace)).find((member) => member.slug === 'eve')!;
    expect(eve.errors.join(' ')).toContain('outside');
  });

  it('changes the roster revision when definition or notes files are edited directly', async () => {
    const workspace = makeWorkspace({ 'ada.md': ADA });
    await ensureMemoryFiles(workspace, 'ada');
    const clock = { now: utc('2026-09-28T16:00:00Z') };
    const runtime = runtimeAt(workspace, new FakeSessions(clock), clock);
    const service = new CrewService(runtime);
    await runtime.start();
    const first = await service.roster();
    expect((await service.roster()).revision).toBe(first.revision);

    fs.writeFileSync(path.join(workspace, 'nimbalyst-local', 'crew', 'ada.md'), ADA.replace('name: Ada', 'name: Ada L.\n  paused: true'));
    const edited = await service.roster();
    expect(edited.members[0].definition).toMatchObject({ name: 'Ada L.', paused: true });
    expect(edited.revision).not.toBe(first.revision);

    fs.appendFileSync(notesPath(workspace, 'ada'), '\nThe user added this by hand.\n');
    expect((await service.roster()).revision).not.toBe(edited.revision);
    runtime.stop();
  });
});

describe('gutter badge', () => {
  it('sends the badge only when it changes, and retries after a failed send', async () => {
    const states: GutterBadge[] = [
      { value: 2, tone: 'default' }, { value: 2, tone: 'default' }, { value: 0, tone: 'warning' },
      { value: 0, tone: 'warning' }, { value: 0, tone: 'warning' }, { value: null, tone: 'default' },
    ];
    const sent: GutterBadge[] = [];
    let failNext = false;
    const publisher = new BadgePublisher({
      compute: async () => states.shift()!,
      send: async (badge) => {
        if (failNext) {
          failNext = false;
          throw new Error('host not ready');
        }
        sent.push(badge);
      },
      log: () => {},
    });
    await publisher.publish(); // 2
    await publisher.publish(); // 2 again: steady state, nothing sent
    failNext = true;
    await publisher.publish(); // warning dot, send fails
    await publisher.publish(); // same state, retried because the failure was not recorded as sent
    await publisher.publish(); // steady
    await publisher.publish(); // cleared
    expect(sent).toEqual([{ value: 2, tone: 'default' }, { value: 0, tone: 'warning' }, { value: null, tone: 'default' }]);
  });
});

describe('crew tools', () => {
  const asAda: ToolCallContext = { sessionId: 'ada-ch', workspacePath: '/ws', caller: 'agent', sessionOwner: { extensionId: CREW_EXTENSION_ID, key: 'ada' } };

  it('acts only for the calling member, applies the ladder, and never overwrites a newer notes edit', async () => {
    const workspace = makeWorkspace({ 'ada.md': ADA });
    const clock = { now: 0 };
    const sessions = new FakeSessions(clock);
    const runtime = runtimeAt(workspace, sessions, { now: utc('2026-09-28T16:00:00Z') });
    const service = new CrewService(runtime);
    const tools = createCrewToolHandlers(runtime, service);

    await expect(tools.flag({ level: 'note', title: 'x', body: '' }, { sessionId: 'plain', workspacePath: '/ws', caller: 'agent', sessionOwner: null })).rejects.toThrow('does not belong to a crew member');
    await expect(tools.flag({ level: 'ask', title: 'x', body: '' }, asAda)).rejects.toThrow('AskUserQuestion');
    expect(await tools.flag({ level: 'page', title: 'Main is red', body: 'CI failed.' }, asAda))
      .toEqual({ level: 'flag', capped: true, delivered: 'desktop', quietHours: false });
    expect(sessions.notified).toEqual([{ title: 'Ada: Main is red', urgency: 'normal' }]);

    const { notesRevision: seen } = await service.readMemory('ada');
    await service.writeNotesByUser('ada', 'User correction B', await readNotes(workspace, 'ada'));
    const replace = (revision?: string) => tools.notes_update({ mode: 'replace', content: 'Agent rewrite', ...(revision ? { revision } : {}) }, asAda);
    await expect(replace(seen)).rejects.toThrow(`Current revision: ${notesRevision('User correction B')}`);
    await expect(replace()).rejects.toThrow('revision');
    expect(await readNotes(workspace, 'ada')).toBe('User correction B');
    await replace(notesRevision('User correction B'));
    expect(await readNotes(workspace, 'ada')).toBe('Agent rewrite');
  });

  it('roster is readable from any session and marks the caller only when it is a crew member', async () => {
    const workspace = makeWorkspace({ 'ada.md': ADA });
    const runtime = runtimeAt(workspace, new FakeSessions({ now: 0 }), { now: utc('2026-09-28T16:00:00Z') });
    const tools = createCrewToolHandlers(runtime, new CrewService(runtime));
    const plain: ToolCallContext = { sessionId: 'user', workspacePath: workspace, caller: 'agent', sessionOwner: null };

    expect((await tools.roster({}, plain) as { members: unknown[] }).members).toEqual([expect.not.objectContaining({ you: true })]);
    expect((await tools.roster({}, { ...asAda, workspacePath: workspace }) as { members: unknown[] }).members).toEqual([expect.objectContaining({ slug: 'ada', you: true })]);
  });

  it('hire works from any session, names the bad field, and never overwrites a member', async () => {
    const workspace = makeWorkspace({ 'ada.md': ADA });
    const runtime = runtimeAt(workspace, new FakeSessions({ now: 0 }), { now: utc('2026-09-28T16:00:00Z') });
    const tools = createCrewToolHandlers(runtime, new CrewService(runtime));
    const plain: ToolCallContext = { sessionId: 'user', workspacePath: workspace, caller: 'agent', sessionOwner: null };
    const file = (weekly: string) => `\`\`\`markdown\n---\ncrew:\n  name: Ada\n  role: Plan Steward\n  schedule:\n    - weekly: ${weekly}\n      prompt: Re-rank plans.\n---\nKeep the plan ledger.\n\`\`\``;

    // The shape a one-shot draft got wrong: the agent must be told which field to fix.
    await expect(tools.hire({ definition: file('"Fri 16:00"') }, plain)).rejects.toThrow('crew.schedule[0].weekly must be');
    await expect(tools.hire({ definition: file('{ days: [friday], time: "16:00" }'), slug: 'ada' }, plain)).rejects.toThrow('already exists');

    expect(await tools.hire({ definition: file('{ days: [friday], time: "16:00" }') }, plain))
      .toEqual({ slug: 'ada-2', name: 'Ada', role: 'Plan Steward', path: 'nimbalyst-local/crew/ada-2.md', paused: false });
    expect(fs.readFileSync(path.join(workspace, 'nimbalyst-local', 'crew', 'ada.md'), 'utf8')).toBe(ADA);
    const hired = (await loadCrewMembers(workspace)).find((member) => member.slug === 'ada-2');
    expect(hired?.definition.directive).toBe('Keep the plan ledger.');
  });
});
