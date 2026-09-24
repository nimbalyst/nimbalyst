/**
 * Dev-only seeding helper for the "Run later" and queued-prompt surfaces (#1497).
 *
 * Builds the full interleaved scenario in one call:
 *   fake agent turn running -> 2 queued -> run later -> 2 more queued
 *
 * The queue is seeded into `sessionQueuedPromptsAtom` only, NEVER through
 * `ai:createQueuedPrompt`. This is the whole safety property of the fixture and
 * it is easy to get wrong: a real queued row is drained by the MAIN process,
 * which chains `processQueuedPrompt -> finally -> triggering next` until the
 * queue is empty. That chain lives in AIService and does not consult the
 * renderer at all, so marking the session "busy" on the renderer side does NOT
 * hold it back — seeding 4 real rows dispatches 4 real billable turns. Writing
 * the atom instead renders the list while the main-process queue stays empty,
 * so the renderer's drain trigger finds nothing and no-ops.
 *
 * Trade-off: the seeded queue is transient (a reload refetches from the DB and
 * clears it). The wakeup, by contrast, is a real persisted row.
 *
 * `fakeRunningTurn` is cosmetic — it only makes the transcript render its
 * mid-turn state, which is what surfaces the queue's "Send now" buttons. It is
 * not a drain guard. No provider is called and no tokens are spent.
 *
 * Usage from the DevTools console (dev builds only):
 *   await window.__testHelpers.seedScheduleLaterDemo()
 *   await window.__testHelpers.seedScheduleLaterDemo({ sessionId: '<existing>' })
 *
 * The session stays stuck "running" until you clear it:
 *   await window.__testHelpers.resetScheduleLaterDemo('<sessionId>')
 */

import { store } from '@nimbalyst/runtime/store';
import {
  addSessionFullAtom,
  sessionProcessingAtom,
  setSelectedWorkstreamAtom,
} from '../store/atoms/sessions';
import { sessionQueuedPromptsAtom } from '../store/atoms/sessionTranscript';
import { MIN_WAKEUP_LEAD_MS } from '../../shared/sessionWakeups';

/** The server minimum plus a few seconds of headroom for the round trip. */
const MIN_FIRE_IN_SECONDS = MIN_WAKEUP_LEAD_MS / 1000 + 5;

const FIRST_QUEUE_BATCH = [
  'Queued #1 — added while the agent is mid-turn',
  'Queued #2 — still waiting behind the first',
];
const SECOND_QUEUE_BATCH = [
  'Queued #3 — added after the scheduled prompts',
  'Queued #4 — last in line',
];
const RUN_LATER_PROMPTS = [
  'Run later #1 — the earlier schedule',
  'Run later #2 — scheduled after it',
];

export interface SeedScheduleLaterOptions {
  /** Defaults to the workspace reported by `get-initial-state`. */
  workspacePath?: string;
  /** Reuse an existing session instead of creating one. */
  sessionId?: string;
  /** When the first wakeup fires. Clamped up to the 30s server minimum. */
  fireInSeconds?: number;
  /** Set false to leave the session idle (the queue will then drain immediately). */
  fakeRunningTurn?: boolean;
}

export interface SeedScheduleLaterResult {
  sessionId: string;
  createdSession: boolean;
  fakeRunningTurn: boolean;
  /** Seeded into the renderer atom only — transient, never dispatched. */
  queuedSeeded: number;
  runLaterRequested: number;
  /** Active wakeups for the session afterwards; equals runLaterRequested unless one failed. */
  runLaterActive: number;
  note?: string;
}

export async function seedScheduleLaterDemo(
  options: SeedScheduleLaterOptions = {},
): Promise<SeedScheduleLaterResult> {
  const initialState = await window.electronAPI.invoke('get-initial-state');
  const workspacePath =
    options.workspacePath || initialState?.workspacePath || initialState?.workspaceFolder;
  if (!workspacePath) {
    throw new Error('seedScheduleLaterDemo: no workspace is open');
  }

  // A wakeup is rejected for a session that does not exist, so create a real one
  // unless the caller pointed at an existing session.
  let sessionId = options.sessionId;
  const createdSession = !sessionId;
  if (!sessionId) {
    const result = await window.electronAPI.invoke('sessions:create', {
      session: {
        id: crypto.randomUUID(),
        provider: 'claude-code',
        model: 'claude-code:sonnet',
        title: 'Run later demo',
      },
      workspaceId: workspacePath,
    });
    if (!result?.success || !result.id) {
      throw new Error('seedScheduleLaterDemo: failed to create a session');
    }
    sessionId = result.id as string;

    store.set(addSessionFullAtom, {
      id: sessionId,
      title: 'Run later demo',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      provider: 'claude-code',
      model: 'claude-code:sonnet',
      sessionType: 'session',
      messageCount: 0,
      workspaceId: workspacePath,
      isArchived: false,
      isPinned: false,
      parentSessionId: null,
      worktreeId: null,
      childCount: 0,
      uncommittedCount: 0,
    });
    store.set(setSelectedWorkstreamAtom, {
      workspacePath,
      selection: { type: 'session', id: sessionId },
    });
  }

  // Step 1: render the session as mid-turn. Cosmetic only (see header note) —
  // it is what makes the queue show its "Send now" affordance.
  const fakeRunningTurn = options.fakeRunningTurn ?? true;
  if (fakeRunningTurn) {
    store.set(sessionProcessingAtom(sessionId), true);
  }

  // Steps 2 and 4: queued prompts, in the order a user would have added them —
  // two behind the running turn, two more after scheduling. Written as one atom
  // update because the atom holds the whole ordered list.
  store.set(
    sessionQueuedPromptsAtom(sessionId),
    [...FIRST_QUEUE_BATCH, ...SECOND_QUEUE_BATCH].map((prompt, index) => ({
      id: `seed-queued-${Date.now()}-${index}`,
      prompt,
      timestamp: Date.now() + index,
    })),
  );

  // Step 3: two "run later" schedules. User schedules accumulate (only the
  // agent's self-pacing wakeup replaces its predecessor), so both show.
  const baseFireIn = Math.max(MIN_FIRE_IN_SECONDS, options.fireInSeconds ?? 3600);
  for (const [index, prompt] of RUN_LATER_PROMPTS.entries()) {
    await window.electronAPI.invoke('wakeup:create', {
      sessionId,
      workspacePath,
      prompt,
      fireAt: Date.now() + (baseFireIn + index * 3600) * 1000,
    });
  }

  const active = await window.electronAPI.invoke('wakeup:list-active', workspacePath);
  const runLaterActive = (active || []).filter(
    (w: { sessionId: string }) => w.sessionId === sessionId,
  ).length;

  return {
    sessionId,
    createdSession,
    fakeRunningTurn,
    queuedSeeded: FIRST_QUEUE_BATCH.length + SECOND_QUEUE_BATCH.length,
    runLaterRequested: RUN_LATER_PROMPTS.length,
    runLaterActive,
    note:
      runLaterActive < RUN_LATER_PROMPTS.length
        ? `Only ${runLaterActive} of ${RUN_LATER_PROMPTS.length} scheduled prompts are active; check the main log for a wakeup:create failure.`
        : undefined,
  };
}

/** Undo a seeded scenario: stop the fake turn, drop queued prompts, cancel the wakeup. */
export async function resetScheduleLaterDemo(sessionId: string): Promise<{ cleared: number }> {
  if (!sessionId) throw new Error('resetScheduleLaterDemo: sessionId is required');

  store.set(sessionProcessingAtom(sessionId), false);

  const pending = (await window.electronAPI.invoke('ai:listPendingPrompts', sessionId)) || [];
  for (const row of pending) {
    await window.electronAPI.invoke('ai:deleteQueuedPrompt', row.id);
  }
  store.set(sessionQueuedPromptsAtom(sessionId), []);

  const initialState = await window.electronAPI.invoke('get-initial-state');
  const active =
    (await window.electronAPI.invoke(
      'wakeup:list-active',
      initialState?.workspacePath || initialState?.workspaceFolder,
    )) || [];
  for (const w of active.filter((x: { sessionId: string }) => x.sessionId === sessionId)) {
    await window.electronAPI.invoke('wakeup:cancel', w.id);
  }

  return { cleared: pending.length };
}
