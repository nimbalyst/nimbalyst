// @vitest-environment node
/**
 * The per-session bit `hasPendingPrompt` answers "is this session waiting on a
 * human?", but every prompt that settled used to write it directly — so with
 * two prompts open, whichever settled first cleared the bit for both. These
 * tests pin the correlation: the bit is derived from the set of prompt ids
 * still open, across every interactive prompt kind.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';

const setSessionPendingPrompt = vi.fn(async () => {});
vi.mock('../pendingPromptPersistence', () => ({
  setSessionPendingPrompt: (...args: unknown[]) => setSessionPendingPrompt(...(args as [])),
}));

import {
  openPrompt,
  resolvePrompt,
  hasOpenPrompts,
  clearOpenPrompts,
  __resetOpenPromptRegistry,
} from '../openPromptRegistry';

describe('open prompt registry', () => {
  beforeEach(() => {
    __resetOpenPromptRegistry();
    setSessionPendingPrompt.mockClear();
  });

  it('sets the bit when the first prompt opens and not again for the second', () => {
    openPrompt('s1', 'q1', 'decision');
    openPrompt('s1', 'q2', 'decision');

    expect(setSessionPendingPrompt).toHaveBeenCalledTimes(2);
    expect(setSessionPendingPrompt).toHaveBeenNthCalledWith(1, 's1', true, 'decision');
    expect(hasOpenPrompts('s1')).toBe(true);
  });

  it('keeps the bit set while a sibling question is still open', () => {
    openPrompt('s1', 'q1', 'decision');
    openPrompt('s1', 'q2', 'decision');
    setSessionPendingPrompt.mockClear();

    resolvePrompt('s1', 'q1');

    expect(setSessionPendingPrompt).not.toHaveBeenCalled();
    expect(hasOpenPrompts('s1')).toBe(true);
  });

  it('keeps the bit set while a tool permission is still open', () => {
    openPrompt('s1', 'q1', 'decision');
    openPrompt('s1', 'perm1', 'approval');
    setSessionPendingPrompt.mockClear();

    resolvePrompt('s1', 'q1');

    expect(setSessionPendingPrompt).not.toHaveBeenCalled();
    expect(hasOpenPrompts('s1')).toBe(true);
  });

  it('clears the bit when the last prompt settles', () => {
    openPrompt('s1', 'q1', 'decision');
    openPrompt('s1', 'q2', 'decision');
    resolvePrompt('s1', 'q1');
    setSessionPendingPrompt.mockClear();

    resolvePrompt('s1', 'q2');

    expect(setSessionPendingPrompt).toHaveBeenCalledWith('s1', false);
    expect(hasOpenPrompts('s1')).toBe(false);
  });

  it('is idempotent for a prompt that already settled', () => {
    openPrompt('s1', 'q1', 'decision');
    resolvePrompt('s1', 'q1');
    setSessionPendingPrompt.mockClear();

    resolvePrompt('s1', 'q1');

    expect(setSessionPendingPrompt).not.toHaveBeenCalled();
  });

  // A stopped or completed session drops everything at once. A prompt that
  // settles afterwards must not re-raise the bit on a dead session.
  it('drops every prompt on terminal session cleanup and ignores late resolves', () => {
    openPrompt('s1', 'q1', 'decision');
    openPrompt('s1', 'q2', 'decision');

    clearOpenPrompts('s1');
    expect(setSessionPendingPrompt).toHaveBeenLastCalledWith('s1', false);
    expect(hasOpenPrompts('s1')).toBe(false);

    setSessionPendingPrompt.mockClear();
    resolvePrompt('s1', 'q1');
    expect(setSessionPendingPrompt).not.toHaveBeenCalled();
  });

  it('keeps sessions independent', () => {
    openPrompt('s1', 'q1', 'decision');
    openPrompt('s2', 'q1', 'decision');
    setSessionPendingPrompt.mockClear();

    resolvePrompt('s1', 'q1');

    expect(setSessionPendingPrompt).toHaveBeenCalledWith('s1', false);
    expect(hasOpenPrompts('s2')).toBe(true);
  });
});
