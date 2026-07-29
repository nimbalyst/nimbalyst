import { describe, it, expect, vi } from 'vitest';
import {
  isTerminalSessionEvent,
  clearStalePendingPromptOnTerminal,
  findSessionsWithPendingPrompt,
  selectStalePendingPromptSessions,
} from '../pendingPromptTerminalClear';

describe('isTerminalSessionEvent', () => {
  it('treats completed/error/interrupted as terminal', () => {
    expect(isTerminalSessionEvent('session:completed')).toBe(true);
    expect(isTerminalSessionEvent('session:error')).toBe(true);
    expect(isTerminalSessionEvent('session:interrupted')).toBe(true);
  });

  it('does not treat in-flight events as terminal', () => {
    expect(isTerminalSessionEvent('session:started')).toBe(false);
    expect(isTerminalSessionEvent('session:streaming')).toBe(false);
    expect(isTerminalSessionEvent('session:waiting')).toBe(false);
  });
});

describe('findSessionsWithPendingPrompt (NIM-2208 boot sweep)', () => {
  it('selects every set bit regardless of phase', () => {
    // Repro for NIM-2208: the old boot repair only matched phase === 'complete',
    // so 32 real sessions (planning / implementing / validating / no phase) kept
    // an "awaiting input" flag for weeks across restarts. No process survives an
    // app restart, so at boot every set bit is stale by definition.
    expect(findSessionsWithPendingPrompt([
      { id: 'complete', metadata: { phase: 'complete', hasPendingPrompt: true } },
      { id: 'planning', metadata: { phase: 'planning', hasPendingPrompt: true } },
      { id: 'validating', metadata: { phase: 'validating', hasPendingPrompt: true } },
      { id: 'no-phase', metadata: { hasPendingPrompt: true } },
      { id: 'clean', metadata: { phase: 'planning', hasPendingPrompt: false } },
      { id: 'absent', metadata: { phase: 'planning' } },
    ])).toEqual(['complete', 'planning', 'validating', 'no-phase']);
  });

  it('returns nothing when no bit is set', () => {
    expect(findSessionsWithPendingPrompt([
      { id: 'a', metadata: { hasPendingPrompt: false } },
    ])).toEqual([]);
  });
});

describe('selectStalePendingPromptSessions (NIM-2208 live reconcile)', () => {
  const none = () => false;
  const all = () => true;

  it('clears a set bit when nothing in-memory could still be blocked on it', () => {
    expect(selectStalePendingPromptSessions({
      sessionIds: ['dead'],
      hasLiveInteractivePrompt: none,
      isSessionTracked: none,
    })).toEqual(['dead']);
  });

  it('never clears while an MCP prompt waiter is genuinely blocked', () => {
    // The blocked handler is sitting in `new Promise` waiting on its response
    // channel; clearing here would hide a session that IS waiting on the user.
    expect(selectStalePendingPromptSessions({
      sessionIds: ['blocked'],
      hasLiveInteractivePrompt: (id) => id === 'blocked',
      isSessionTracked: none,
    })).toEqual([]);
  });

  it('never clears a session still tracked in memory', () => {
    // Provider-driven prompts (ExitPlanMode et al, MessageStreamingHandler) set
    // the bit without registering an MCP waiter, so the waiter registry alone is
    // not sufficient. A tracked session may have a live provider blocked on one;
    // leave it to the terminal-event clear and the next boot sweep.
    expect(selectStalePendingPromptSessions({
      sessionIds: ['tracked'],
      hasLiveInteractivePrompt: none,
      isSessionTracked: all,
    })).toEqual([]);
  });

  it('is a no-op when nothing carries the bit', () => {
    expect(selectStalePendingPromptSessions({
      sessionIds: [],
      hasLiveInteractivePrompt: none,
      isSessionTracked: none,
    })).toEqual([]);
  });

  it('sweeps only the stale subset of a mixed set', () => {
    expect(selectStalePendingPromptSessions({
      sessionIds: ['dead-a', 'blocked', 'tracked', 'dead-b'],
      hasLiveInteractivePrompt: (id) => id === 'blocked',
      isSessionTracked: (id) => id === 'tracked',
    })).toEqual(['dead-a', 'dead-b']);
  });
});

describe('clearStalePendingPromptOnTerminal (NIM-871)', () => {
  const sessionId = '5a681e17-2bb9-4b27-b667-3c6ad92c3fad';

  it('clears the persisted bit when a turn ends with an abandoned prompt', async () => {
    // Repro: an AskUserQuestion opened (hasPendingPrompt=true), the user
    // submitted a new prompt instead of answering, and that new turn now
    // completes. The bit must be cleared so the session does not stay stuck
    // showing "awaiting user input".
    const clearPendingPrompt = vi.fn().mockResolvedValue(undefined);
    const result = await clearStalePendingPromptOnTerminal(
      { type: 'session:completed', sessionId },
      {
        readHasPendingPrompt: async () => true,
        clearPendingPrompt,
      },
    );
    expect(result).toBe(true);
    expect(clearPendingPrompt).toHaveBeenCalledWith(sessionId);
  });

  it('clears on interruption (stop / crash) too', async () => {
    const clearPendingPrompt = vi.fn().mockResolvedValue(undefined);
    await clearStalePendingPromptOnTerminal(
      { type: 'session:interrupted', sessionId },
      { readHasPendingPrompt: async () => true, clearPendingPrompt },
    );
    expect(clearPendingPrompt).toHaveBeenCalledWith(sessionId);
  });

  it('does NOT write on a normal turn end with no pending prompt', async () => {
    const clearPendingPrompt = vi.fn().mockResolvedValue(undefined);
    const result = await clearStalePendingPromptOnTerminal(
      { type: 'session:completed', sessionId },
      { readHasPendingPrompt: async () => false, clearPendingPrompt },
    );
    expect(result).toBe(false);
    expect(clearPendingPrompt).not.toHaveBeenCalled();
  });

  it('does NOT clear on a non-terminal (in-flight) event', async () => {
    const readHasPendingPrompt = vi.fn().mockResolvedValue(true);
    const clearPendingPrompt = vi.fn().mockResolvedValue(undefined);
    const result = await clearStalePendingPromptOnTerminal(
      { type: 'session:waiting', sessionId },
      { readHasPendingPrompt, clearPendingPrompt },
    );
    expect(result).toBe(false);
    // A non-terminal event must not even probe the DB.
    expect(readHasPendingPrompt).not.toHaveBeenCalled();
    expect(clearPendingPrompt).not.toHaveBeenCalled();
  });

  it('does nothing when the bit cannot be determined (null)', async () => {
    const clearPendingPrompt = vi.fn().mockResolvedValue(undefined);
    const result = await clearStalePendingPromptOnTerminal(
      { type: 'session:completed', sessionId },
      { readHasPendingPrompt: async () => null, clearPendingPrompt },
    );
    expect(result).toBe(false);
    expect(clearPendingPrompt).not.toHaveBeenCalled();
  });

  it('reports read/clear failures without throwing', async () => {
    const onError = vi.fn();
    const result = await clearStalePendingPromptOnTerminal(
      { type: 'session:completed', sessionId },
      {
        readHasPendingPrompt: async () => {
          throw new Error('db down');
        },
        clearPendingPrompt: vi.fn(),
        onError,
      },
    );
    expect(result).toBe(false);
    expect(onError).toHaveBeenCalled();
  });
});
