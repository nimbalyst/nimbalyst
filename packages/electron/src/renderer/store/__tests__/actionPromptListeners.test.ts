/**
 * Tests for the `action-prompts:launched` listener — the renderer side of
 * the new-session launch flow.
 *
 * Covers the foreground/focus behavior specifically, because the review
 * found that updating only `activeSessionIdAtom` left the right-hand panel
 * stuck on the old session (the panel reads from `selectedWorkstreamAtom`).
 * These tests pin the listener to the canonical navigation pattern from
 * `trayListeners.ts`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { store } from '@nimbalyst/runtime/store';
import {
  selectedWorkstreamAtom,
  sessionDraftInputAtom,
} from '../atoms/sessions';
import {
  workstreamStateAtom,
  workstreamActiveChildAtom,
  initWorkstreamState,
} from '../atoms/workstreamState';

type EventHandler = (...args: any[]) => void;

let handlers: Map<string, EventHandler>;
let cleanup: (() => void) | null = null;

function makeApi() {
  return {
    on: vi.fn((channel: string, handler: EventHandler) => {
      handlers.set(channel, handler);
      return () => handlers.delete(channel);
    }),
    invoke: vi.fn().mockResolvedValue({}),
    send: vi.fn(),
  };
}

const WS = '/ws/test-actions';

beforeEach(async () => {
  handlers = new Map();
  vi.stubGlobal('window', { electronAPI: makeApi() });
  // workstreamStateAtom's setter schedules a persist via the module-level
  // `currentWorkspacePath`. Initializing it once keeps the persist no-op happy
  // in unit-test land (the underlying IPC call is stubbed via makeApi).
  initWorkstreamState(WS);
  const mod = await import('../listeners/actionPromptListeners');
  cleanup = mod.initActionPromptListeners();
});

afterEach(() => {
  cleanup?.();
  cleanup = null;
  vi.unstubAllGlobals();
});

function fireLaunched(payload: Record<string, unknown>) {
  const handler = handlers.get('action-prompts:launched');
  if (!handler) throw new Error('action-prompts:launched handler not registered');
  handler(payload);
}

describe('action-prompts:launched listener', () => {
  it('updates selectedWorkstreamAtom (workstream case) so the right panel switches to the new session', () => {
    const newSession = 'sess-new-ws';
    const workstreamId = 'ws-parent';

    fireLaunched({
      workspacePath: WS,
      parentSessionId: 'sess-old',
      sessionId: newSession,
      workstreamId,
      worktreeId: null,
      draftInput: null,
      focus: true,
    });

    const selection = store.get(selectedWorkstreamAtom(WS));
    expect(selection).toEqual({ type: 'workstream', id: workstreamId });

    // Active child within the workstream is the new session, which is what
    // AgentMode reads to render the transcript panel.
    expect(store.get(workstreamActiveChildAtom(workstreamId))).toBe(newSession);
  });

  it('updates selectedWorkstreamAtom (worktree case) using the worktree id', () => {
    const newSession = 'sess-new-wt';
    const worktreeId = 'wt-1';

    fireLaunched({
      workspacePath: WS,
      parentSessionId: 'sess-old',
      sessionId: newSession,
      workstreamId: null,
      worktreeId,
      draftInput: null,
      focus: true,
    });

    const selection = store.get(selectedWorkstreamAtom(WS));
    expect(selection).toEqual({ type: 'worktree', id: newSession });

    // The new session's workstreamState should be tagged as worktree so the
    // panel resolves it as a worktree-resident session.
    const state = store.get(workstreamStateAtom(newSession));
    expect(state.type).toBe('worktree');
  });

  it('does not switch focus when foreground=false', () => {
    // Seed a different selection so we can detect (un)intended changes.
    store.set(selectedWorkstreamAtom(WS), { type: 'session', id: 'sess-current' });

    fireLaunched({
      workspacePath: WS,
      parentSessionId: 'sess-old',
      sessionId: 'sess-new',
      workstreamId: 'ws-1',
      worktreeId: null,
      draftInput: null,
      focus: false,
    });

    expect(store.get(selectedWorkstreamAtom(WS))).toEqual({
      type: 'session',
      id: 'sess-current',
    });
  });

  it('prefills the new session draft when draftInput is provided (autoSubmit=false path)', () => {
    const newSession = 'sess-prefill';
    const prompt = '/review the originating session\n\nOriginating session: @@[Foo](full-uuid)';

    fireLaunched({
      workspacePath: WS,
      parentSessionId: 'sess-old',
      sessionId: newSession,
      workstreamId: 'ws-1',
      worktreeId: null,
      draftInput: prompt,
      focus: false,
    });

    expect(store.get(sessionDraftInputAtom(newSession))).toBe(prompt);
  });
});
