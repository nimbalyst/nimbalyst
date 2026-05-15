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
} from '../atoms/sessions';

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
      getActiveSessionIds: vi.fn().mockResolvedValue({ success: true, sessionIds: [] }),
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
