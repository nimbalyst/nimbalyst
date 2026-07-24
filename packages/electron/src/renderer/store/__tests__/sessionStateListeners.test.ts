/**
 * Regression tests for the centralized session state listeners.
 *
 * Focus: the lifecycle and prompt event handlers that drive the
 * `sessionHasPendingInteractivePromptAtom` flag, which controls whether the
 * session list shows the warning "contact_support" indicator vs a generic
 * "Thinking…" spinner.
 *
 * Multi-project rail (PR #188) introduced a regression where
 * `session:streaming` chunks arriving after a tool_use for AskUserQuestion /
 * ExitPlanMode / ToolPermission / GitCommitProposal cleared the pending flag,
 * leaving the UI stuck on the spinner. These tests guard against that
 * specific regression and against the parallel responsibilities of the
 * direct prompt event handlers.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { store } from '@nimbalyst/runtime/store';
import {
  sessionHasPendingInteractivePromptAtom,
  sessionProcessingAtom,
  sessionPendingPromptsAtom,
  sessionRegistryAtom,
  sessionChildrenAtom,
  sessionLastActivityAtom,
  type SessionMeta,
} from '../atoms/sessions';
import {
  globalSessionTurnActivityAtom,
} from '../atoms/sessionActivity';

function seedRegistry(entries: Array<Partial<SessionMeta> & { id: string }>): void {
  const map = new Map(store.get(sessionRegistryAtom));
  const now = Date.now();
  for (const e of entries) {
    map.set(e.id, {
      id: e.id,
      title: e.title ?? e.id,
      provider: e.provider ?? 'claude',
      sessionType: (e.sessionType ?? 'session') as SessionMeta['sessionType'],
      workspaceId: e.workspaceId ?? '/ws/test-project',
      worktreeId: e.worktreeId ?? null,
      parentSessionId: e.parentSessionId ?? null,
      childCount: e.childCount ?? 0,
      uncommittedCount: e.uncommittedCount ?? 0,
      createdAt: e.createdAt ?? now,
      updatedAt: e.updatedAt ?? now,
      messageCount: e.messageCount ?? 0,
      isArchived: e.isArchived ?? false,
      isPinned: e.isPinned ?? false,
    } as SessionMeta);
  }
  store.set(sessionRegistryAtom, map);
}

type EventHandler = (...args: any[]) => void;

let handlers: Map<string, EventHandler>;
let cleanup: (() => void) | null = null;

function makeApi() {
  return {
    on: vi.fn((channel: string, handler: EventHandler) => {
      handlers.set(channel, handler);
      return () => handlers.delete(channel);
    }),
    invoke: vi.fn().mockResolvedValue({ success: true, sessions: [] }),
    send: vi.fn(),
    sessionState: {
      subscribe: vi.fn().mockResolvedValue({ success: true }),
      unsubscribe: vi.fn().mockResolvedValue({ success: true }),
      getTrackedSessionIds: vi.fn().mockResolvedValue({ success: true, sessionIds: [] }),
      getRunningSessionIds: vi.fn().mockResolvedValue({ success: true, sessionIds: [] }),
      // The listener uses sessionState.onStateChange as the dedicated channel
      // for lifecycle events (session:started/streaming/waiting/completed/error/interrupted).
      // Capture the handler under the same key the rest of the test code uses.
      onStateChange: vi.fn((handler: EventHandler) => {
        handlers.set('ai-session-state:event', handler);
        return () => handlers.delete('ai-session-state:event');
      }),
    },
  };
}

let uniqueCounter = 0;
function uniqueSessionId(prefix: string): string {
  uniqueCounter += 1;
  return `${prefix}-${Date.now()}-${uniqueCounter}`;
}

const WS = '/ws/test-project';

beforeEach(async () => {
  handlers = new Map();
  vi.stubGlobal('window', { electronAPI: makeApi() });
  // initSessionStateListeners is the entry point that wires up handlers.
  // Imported lazily so vi.stubGlobal('window', ...) is in effect when the
  // module reads `window.electronAPI` at call time.
  const mod = await import('../sessionStateListeners');
  cleanup = mod.initSessionStateListeners();
});

afterEach(() => {
  cleanup?.();
  cleanup = null;
  vi.unstubAllGlobals();
});

describe('lifecycle: session:streaming', () => {
  it('does NOT clear sessionHasPendingInteractivePromptAtom (regression: PR #188)', () => {
    const sid = uniqueSessionId('streaming-noclear');
    store.set(sessionHasPendingInteractivePromptAtom(sid), true);

    const handler = handlers.get('ai-session-state:event');
    expect(handler).toBeTypeOf('function');
    handler!({ type: 'session:streaming', sessionId: sid, workspacePath: WS });

    expect(store.get(sessionHasPendingInteractivePromptAtom(sid))).toBe(true);
  });

  it('keeps sessionProcessingAtom true while streaming', () => {
    const sid = uniqueSessionId('streaming-processing');
    const handler = handlers.get('ai-session-state:event');
    handler!({ type: 'session:streaming', sessionId: sid, workspacePath: WS });

    expect(store.get(sessionProcessingAtom(sid))).toBe(true);
  });
});

describe('lifecycle: session:waiting', () => {
  it('sets sessionHasPendingInteractivePromptAtom and sessionProcessingAtom true', () => {
    const sid = uniqueSessionId('waiting-set');
    const handler = handlers.get('ai-session-state:event');
    handler!({ type: 'session:waiting', sessionId: sid, workspacePath: WS });

    expect(store.get(sessionHasPendingInteractivePromptAtom(sid))).toBe(true);
    expect(store.get(sessionProcessingAtom(sid))).toBe(true);
  });

  // NIM-850: the genuine Claude CLI writes a coarse `waiting` pid status that
  // fires transiently mid-turn (e.g. while blocked on a tool/MCP round-trip),
  // not just for real user prompts. AND it has no symmetric clear, so once set it
  // suppressed the "Thinking…" indicator for the rest of the turn. For
  // claude-code-cli sessions, session:waiting must NOT set the pending flag — the
  // flag is driven by the explicit prompt-lifecycle broadcasts (ai:askUserQuestion
  // / ai:requestUserInput, set AND cleared by the MCP handler). The session stays
  // "processing" so the indicator keeps showing between prompts.
  it('does NOT set the pending interactive prompt flag for claude-code-cli (NIM-850)', () => {
    const sid = uniqueSessionId('waiting-cli');
    seedRegistry([{ id: sid, provider: 'claude-code-cli', workspaceId: WS }]);

    const handler = handlers.get('ai-session-state:event');
    handler!({ type: 'session:waiting', sessionId: sid, workspacePath: WS });

    expect(store.get(sessionHasPendingInteractivePromptAtom(sid))).toBe(false);
    expect(store.get(sessionProcessingAtom(sid))).toBe(true);
  });
});

// NIM-850: the "awaiting input" flag for claude-code-cli AskUserQuestion is now
// owned by the explicit prompt-lifecycle broadcasts the MCP handler emits — set on
// ask, cleared on settle (answer OR cancel) — instead of the coarse, never-cleared
// pid `waiting` status. This locks the renderer contract those broadcasts rely on.
describe('AskUserQuestion prompt lifecycle (NIM-850)', () => {
  it('ai:askUserQuestion sets the pending flag; ai:askUserQuestionAnswered clears it', () => {
    const sid = uniqueSessionId('auq');
    const ask = handlers.get('ai:askUserQuestion');
    const answered = handlers.get('ai:askUserQuestionAnswered');
    expect(ask).toBeTypeOf('function');
    expect(answered).toBeTypeOf('function');

    ask!({ sessionId: sid, questionId: 'q1', questions: [] });
    expect(store.get(sessionHasPendingInteractivePromptAtom(sid))).toBe(true);

    answered!({ sessionId: sid, questionId: 'q1' });
    expect(store.get(sessionHasPendingInteractivePromptAtom(sid))).toBe(false);
  });
});

describe.each([
  ['session:completed'],
  ['session:error'],
  ['session:interrupted'],
])('lifecycle: %s', (type) => {
  it('clears both pending and processing atoms', () => {
    const sid = uniqueSessionId(`terminal-${type}`);
    store.set(sessionHasPendingInteractivePromptAtom(sid), true);
    store.set(sessionProcessingAtom(sid), true);

    const handler = handlers.get('ai-session-state:event');
    handler!({ type, sessionId: sid, workspacePath: WS });

    expect(store.get(sessionHasPendingInteractivePromptAtom(sid))).toBe(false);
    expect(store.get(sessionProcessingAtom(sid))).toBe(false);
  });

  // Regression coverage for nimbalyst#116. arcenik86 reported the "Thinking…"
  // indicator stayed pinned after the assistant finished and only cleared on
  // Cancel. Root cause: commit 4e5dd9e7 (fix for #231) added a workspace-routed
  // null-guard that silently dropped terminal events when the session was not
  // yet in `sessionRegistryAtom` — a startup race or post-HMR re-evaluation
  // where the lifecycle event arrives before the session list is hydrated.
  // Extended-thinking sessions (longer turns) reproduce the race more often.
  //
  // After the fix, terminal events MUST clear `sessionProcessingAtom` even
  // when (a) `workspacePath` is missing from the event payload AND (b) the
  // registry has no entry for the session yet. Both conditions are required
  // to exercise the regression — having either one populated would resolve
  // `ownedWorkspacePath` and avoid the null-guard.
  it(`clears sessionProcessingAtom even when workspacePath is missing AND session is not in registry (regression #116)`, () => {
    const sid = uniqueSessionId(`terminal-${type}-no-workspace`);
    store.set(sessionProcessingAtom(sid), true);
    store.set(sessionHasPendingInteractivePromptAtom(sid), true);

    const handler = handlers.get('ai-session-state:event');
    // No workspacePath on the event AND no registry entry for this sessionId.
    // Prior to the fix this combination dropped the event silently.
    handler!({ type, sessionId: sid });

    expect(store.get(sessionProcessingAtom(sid))).toBe(false);
    expect(store.get(sessionHasPendingInteractivePromptAtom(sid))).toBe(false);
  });

  // Per @ghinkle's review on the closed PR #293: terminal events must ALSO
  // clear the workspace-scoped streaming flag in the no-workspacePath case,
  // not just the per-session atoms. The activity index records which
  // workspace this session belonged to when `markSessionStreamingAtom` fired
  // (during started / streaming / waiting), and `clearSessionStreamingAtom`
  // resolves through the index when its `workspacePath` argument is omitted.
  // Without this, the multi-project rail's "streaming" badge stayed on for
  // sessions in inactive projects even after they terminated.
  it(`clears workspace-scoped streaming flag in the no-workspacePath case (Greg's #293 review)`, async () => {
    const { markSessionStreamingAtom, globalSessionActivityAtom } = await import(
      '../atoms/sessionActivity'
    );
    const sid = uniqueSessionId(`terminal-${type}-streaming`);
    const inactiveProject = '/ws/inactive-project';

    // Seed the activity index by simulating an earlier started/streaming event
    // that DID carry a workspacePath.
    store.set(markSessionStreamingAtom, { sessionId: sid, workspacePath: inactiveProject });
    expect(store.get(globalSessionActivityAtom).get(inactiveProject)?.streaming.has(sid)).toBe(true);

    // Terminal event WITHOUT workspacePath - the registry also has no entry.
    const handler = handlers.get('ai-session-state:event');
    handler!({ type, sessionId: sid });

    // Streaming flag for the inactive project should now be cleared.
    expect(store.get(globalSessionActivityAtom).get(inactiveProject)?.streaming.has(sid) ?? false).toBe(false);
  });
});

describe('direct prompt events: AskUserQuestion', () => {
  it('ai:askUserQuestion sets pending true and pushes prompt', () => {
    const sid = uniqueSessionId('auq-set');
    const qid = 'q-1';
    const handler = handlers.get('ai:askUserQuestion');
    expect(handler).toBeTypeOf('function');
    handler!({ sessionId: sid, questionId: qid, questions: [{ q: 'pick' }] });

    expect(store.get(sessionHasPendingInteractivePromptAtom(sid))).toBe(true);
    const prompts = store.get(sessionPendingPromptsAtom(sid));
    expect(prompts).toHaveLength(1);
    expect(prompts[0].promptId).toBe(qid);
    expect(prompts[0].promptType).toBe('ask_user_question_request');
  });

  it('ai:askUserQuestionAnswered clears pending and removes prompt', () => {
    const sid = uniqueSessionId('auq-answer');
    const qid = 'q-1';
    handlers.get('ai:askUserQuestion')!({ sessionId: sid, questionId: qid, questions: [] });
    expect(store.get(sessionHasPendingInteractivePromptAtom(sid))).toBe(true);

    handlers.get('ai:askUserQuestionAnswered')!({ sessionId: sid, questionId: qid });

    expect(store.get(sessionHasPendingInteractivePromptAtom(sid))).toBe(false);
    expect(store.get(sessionPendingPromptsAtom(sid))).toHaveLength(0);
  });
});

describe('direct prompt events: ExitPlanMode', () => {
  it('ai:exitPlanModeConfirm sets pending true and pushes prompt', () => {
    const sid = uniqueSessionId('epm-set');
    const rid = 'epm-1';
    handlers.get('ai:exitPlanModeConfirm')!({ sessionId: sid, requestId: rid });

    expect(store.get(sessionHasPendingInteractivePromptAtom(sid))).toBe(true);
    const prompts = store.get(sessionPendingPromptsAtom(sid));
    expect(prompts).toHaveLength(1);
    expect(prompts[0].promptId).toBe(rid);
  });

  it('ai:exitPlanModeResolved clears pending and removes prompt', () => {
    const sid = uniqueSessionId('epm-resolve');
    const rid = 'epm-1';
    handlers.get('ai:exitPlanModeConfirm')!({ sessionId: sid, requestId: rid });

    handlers.get('ai:exitPlanModeResolved')!({ sessionId: sid, requestId: rid, approved: false });

    expect(store.get(sessionHasPendingInteractivePromptAtom(sid))).toBe(false);
    expect(store.get(sessionPendingPromptsAtom(sid))).toHaveLength(0);
  });
});

describe('direct prompt events: ToolPermission', () => {
  it('ai:toolPermission sets pending true and pushes prompt', () => {
    const sid = uniqueSessionId('tp-set');
    const rid = 'tp-1';
    handlers.get('ai:toolPermission')!({ sessionId: sid, requestId: rid, toolName: 'edit' });

    expect(store.get(sessionHasPendingInteractivePromptAtom(sid))).toBe(true);
    const prompts = store.get(sessionPendingPromptsAtom(sid));
    expect(prompts).toHaveLength(1);
    expect(prompts[0].promptType).toBe('permission_request');
  });

  it('ai:toolPermissionResolved clears pending and removes prompt', () => {
    const sid = uniqueSessionId('tp-resolve');
    const rid = 'tp-1';
    handlers.get('ai:toolPermission')!({ sessionId: sid, requestId: rid });

    handlers.get('ai:toolPermissionResolved')!({ sessionId: sid, requestId: rid });

    expect(store.get(sessionHasPendingInteractivePromptAtom(sid))).toBe(false);
    expect(store.get(sessionPendingPromptsAtom(sid))).toHaveLength(0);
  });
});

describe('direct prompt events: GitCommitProposal', () => {
  it('ai:gitCommitProposal sets pending true and pushes prompt', () => {
    const sid = uniqueSessionId('gcp-set');
    const pid = 'gcp-1';
    handlers.get('ai:gitCommitProposal')!({ sessionId: sid, proposalId: pid });

    expect(store.get(sessionHasPendingInteractivePromptAtom(sid))).toBe(true);
    expect(store.get(sessionPendingPromptsAtom(sid))).toHaveLength(1);
  });

  it('ai:gitCommitProposalResolved clears pending and removes prompt', () => {
    const sid = uniqueSessionId('gcp-resolve');
    const pid = 'gcp-1';
    handlers.get('ai:gitCommitProposal')!({ sessionId: sid, proposalId: pid });

    handlers.get('ai:gitCommitProposalResolved')!({ sessionId: sid, proposalId: pid });

    expect(store.get(sessionHasPendingInteractivePromptAtom(sid))).toBe(false);
    expect(store.get(sessionPendingPromptsAtom(sid))).toHaveLength(0);
  });
});

describe('regression: streaming after a pending prompt', () => {
  it('does not flip the indicator back to spinner', () => {
    const sid = uniqueSessionId('regression');
    // Simulate the bug-trigger sequence: AI emits AskUserQuestion (pending
    // becomes true), then a tail-end token chunk fires session:streaming.
    handlers.get('ai:askUserQuestion')!({ sessionId: sid, questionId: 'q', questions: [] });
    expect(store.get(sessionHasPendingInteractivePromptAtom(sid))).toBe(true);

    handlers.get('ai-session-state:event')!({
      type: 'session:streaming',
      sessionId: sid,
      workspacePath: WS,
    });

    // Pending must remain true so SessionListItem keeps the warning icon.
    expect(store.get(sessionHasPendingInteractivePromptAtom(sid))).toBe(true);
  });
});

// Regression coverage for the user-reported bug on 2026-06-01: workstream
// parents stayed several rows down the TODAY group even though a child session
// had just received a new message. `workspaceSessionTurnActivityAtom` keys the
// sort by sessionId; before the fix the listener only bumped the activity
// timestamp for the child, never for its parent, so SessionHistory continued
// to sort the parent by its stale registry `updatedAt`.
describe('workstream sort: child activity bubbles to parent', () => {
  it('session:started for a child bumps the parent workstream\'s turn activity', () => {
    const parentId = uniqueSessionId('ws-parent');
    const childId = uniqueSessionId('ws-child');
    seedRegistry([
      { id: parentId, sessionType: 'workstream', childCount: 1 },
      { id: childId, parentSessionId: parentId },
    ]);

    const handler = handlers.get('ai-session-state:event');
    handler!({
      type: 'session:started',
      sessionId: childId,
      workspacePath: WS,
      timestamp: 5_000,
    });

    const turnsForWs = store.get(globalSessionTurnActivityAtom).get(WS);
    expect(turnsForWs?.get(childId)).toBe(5_000);
    expect(turnsForWs?.get(parentId)).toBe(5_000);
  });

  it('ai:message-logged for a child bumps only the child\'s relative-time label, not turn-activity', () => {
    // Per-message events deliberately do NOT bump `markSessionTurnActivityAtom`
    // (for the child or its workstream parent). Per-chunk writes to that atom
    // reopen the SessionHistory sort cascade and the `session-files:get-by-session`
    // storm that the May 28 perf fix (commit 3d613ecfc) eliminated. Parent
    // workstreams still rise to the top via the turn-boundary bumps in
    // session:started/waiting/completed.
    const parentId = uniqueSessionId('ws-parent-msg');
    const childId = uniqueSessionId('ws-child-msg');
    seedRegistry([
      { id: parentId, sessionType: 'workstream', childCount: 1 },
      { id: childId, parentSessionId: parentId },
    ]);

    const before = Date.now();
    handlers.get('ai:message-logged')!({
      sessionId: childId,
      direction: 'output',
      workspacePath: WS,
    });

    // Child relative-time label updates.
    const childLive = store.get(sessionLastActivityAtom(childId));
    expect(childLive).toBeGreaterThanOrEqual(before);

    // Parent does NOT bump per-message — neither label nor turn activity.
    const parentLive = store.get(sessionLastActivityAtom(parentId));
    expect(parentLive).toBe(0);
    const turnsForWs = store.get(globalSessionTurnActivityAtom).get(WS);
    expect(turnsForWs?.get(parentId)).toBeUndefined();
    expect(turnsForWs?.get(childId)).toBeUndefined();
  });

  it('session:completed for a child bumps the parent workstream\'s turn activity', () => {
    const parentId = uniqueSessionId('ws-parent-done');
    const childId = uniqueSessionId('ws-child-done');
    seedRegistry([
      { id: parentId, sessionType: 'workstream', childCount: 1 },
      { id: childId, parentSessionId: parentId },
    ]);

    handlers.get('ai-session-state:event')!({
      type: 'session:completed',
      sessionId: childId,
      workspacePath: WS,
      timestamp: 9_000,
    });

    const turnsForWs = store.get(globalSessionTurnActivityAtom).get(WS);
    expect(turnsForWs?.get(parentId)).toBe(9_000);
  });
});

// Burst contract test for the May 28 perf fix (commit 3d613ecfc). The original
// fix split the per-message label bump (`sessionLastActivityAtom`) from the
// turn-boundary sort bump (`markSessionTurnActivityAtom`). The Jun 2 regression
// (commit 3d78447dd) merged them back together inside `handleMessageLogged` and
// re-introduced the SessionHistory sort cascade and the
// `session-files:get-by-session` storm per streamed chunk. If this test fails,
// someone has added a per-message write to `markSessionTurnActivityAtom`
// (directly or via a helper like `bumpParentTurnActivity`). Don't relax it.
describe('contract: per-message events must not bump turn activity', () => {
  it('a burst of ai:message-logged events leaves turn activity untouched', () => {
    const sid = uniqueSessionId('burst-solo');
    seedRegistry([{ id: sid }]);

    const handler = handlers.get('ai:message-logged')!;
    for (let i = 0; i < 100; i++) {
      handler({ sessionId: sid, direction: 'output', workspacePath: WS });
    }

    // Per-row label may bump (fine — only the row's relative-time label re-renders).
    expect(store.get(sessionLastActivityAtom(sid))).toBeGreaterThan(0);

    // Sort-driving atom must be empty: SessionHistory's `liveOrderTimestampMap`
    // and `displayOrderTimestampMap` recompute on changes to this; per-chunk
    // writes here re-fire the sort cascade.
    const turnsForWs = store.get(globalSessionTurnActivityAtom).get(WS);
    expect(turnsForWs?.get(sid)).toBeUndefined();
  });

  it('a burst of ai:message-logged events does not bump the workstream parent\'s turn activity either', () => {
    const parentId = uniqueSessionId('burst-parent');
    const childId = uniqueSessionId('burst-child');
    seedRegistry([
      { id: parentId, sessionType: 'workstream', childCount: 1 },
      { id: childId, parentSessionId: parentId },
    ]);

    const handler = handlers.get('ai:message-logged')!;
    for (let i = 0; i < 100; i++) {
      handler({ sessionId: childId, direction: 'output', workspacePath: WS });
    }

    const turnsForWs = store.get(globalSessionTurnActivityAtom).get(WS);
    expect(turnsForWs?.get(childId)).toBeUndefined();
    expect(turnsForWs?.get(parentId)).toBeUndefined();
  });
});

describe('processing reconcile on terminal events', () => {
  it('heals a stuck processing session promptly when any session reaches a terminal state', async () => {
    vi.useFakeTimers();
    try {
      // A session whose processing atom is stuck true while the backend no longer
      // reports it running (getRunningSessionIds mock returns []). This stands in
      // for a meta-agent child whose terminal clear was missed, pinning the header.
      const stuck = uniqueSessionId('stuck');
      seedRegistry([{ id: stuck }]);
      store.set(sessionProcessingAtom(stuck), true);

      // A DIFFERENT session completing must trigger the debounced reconcile, which
      // re-derives processing atoms against the authoritative active set.
      const other = uniqueSessionId('other');
      const handler = handlers.get('ai-session-state:event')!;
      handler({ type: 'session:completed', sessionId: other, workspacePath: WS });

      expect(store.get(sessionProcessingAtom(stuck))).toBe(true); // not yet (debounced)
      await vi.advanceTimersByTimeAsync(700);
      expect(store.get(sessionProcessingAtom(stuck))).toBe(false); // healed by reconcile
    } finally {
      vi.useRealTimers();
    }
  });

  it('reconcile heals a stuck child that is in sessionChildrenAtom but NOT the registry', async () => {
    vi.useFakeTimers();
    try {
      // The meta header (sessionOrChildProcessingAtom) reads children from
      // sessionChildrenAtom too. A meta-agent child can sit there while not being
      // a registry key (child-added patches it; archived children drop from the
      // list). The reconcile must still heal it, or the header stays stuck.
      const meta = uniqueSessionId('meta');
      const child = uniqueSessionId('child');
      seedRegistry([{ id: meta, sessionType: 'meta-agent' as SessionMeta['sessionType'] }]);
      store.set(sessionChildrenAtom(meta), [child]); // child known only via children atom
      store.set(sessionProcessingAtom(child), true); // stuck

      const handler = handlers.get('ai-session-state:event')!;
      handler({ type: 'session:completed', sessionId: meta, workspacePath: WS });
      await vi.advanceTimersByTimeAsync(700);

      expect(store.get(sessionProcessingAtom(child))).toBe(false); // healed via children union
    } finally {
      vi.useRealTimers();
    }
  });
});
