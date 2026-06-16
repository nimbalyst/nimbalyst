import { describe, it, expect } from 'vitest';
import { createClaudeCliErrorSurfacePolicy } from '../claudeCliErrorSurfacePolicy';
import type { ClaudeCliFailure } from '../claudeCliErrorClassifier';

/**
 * NIM-815: every fresh CLI session's first request can fail transiently (the
 * proxy's cold connection reliably trips errors that the CLI immediately
 * retries past). The old inline guard only swallowed rate_limit/overloaded
 * before the first assistant output — a first-turn api_error/generic surfaced
 * "The Claude CLI turn failed." even though the session went on to work fine.
 */

const failure = (kind: ClaudeCliFailure['kind'], statusCode = 500): ClaudeCliFailure => ({
  kind,
  statusCode,
  message: 'x',
});

describe('claudeCliErrorSurfacePolicy', () => {
  it('suppresses self-healing kinds before the first assistant output', () => {
    const policy = createClaudeCliErrorSurfacePolicy();
    expect(policy.shouldSurface(failure('rate_limit', 429))).toBe(false);
    expect(policy.shouldSurface(failure('overloaded', 529))).toBe(false);
  });

  it('surfaces self-healing kinds after the first visible assistant output', () => {
    const policy = createClaudeCliErrorSurfacePolicy();
    policy.noteAssistantMessage(true);
    expect(policy.shouldSurface(failure('rate_limit', 429))).toBe(true);
  });

  it('swallows a startup-transient api_error/generic within the retry budget', () => {
    const policy = createClaudeCliErrorSurfacePolicy({ startupTransientBudget: 2 });
    expect(policy.shouldSurface(failure('api_error', 502))).toBe(false);
    expect(policy.shouldSurface(failure('generic', 400))).toBe(false);
    // Budget exhausted — the third pre-output failure surfaces.
    expect(policy.shouldSurface(failure('api_error', 502))).toBe(true);
  });

  it('surfaces api_error immediately once a visible turn has been produced', () => {
    const policy = createClaudeCliErrorSurfacePolicy();
    policy.noteAssistantMessage(true);
    expect(policy.shouldSurface(failure('api_error', 500))).toBe(true);
  });

  it('always surfaces auth and context_limit, even on the first turn', () => {
    const policy = createClaudeCliErrorSurfacePolicy();
    expect(policy.shouldSurface(failure('auth', 401))).toBe(true);
    expect(policy.shouldSurface(failure('context_limit', 400))).toBe(true);
  });

  it('collapses a retry storm of the same kind into one surfaced failure', () => {
    const policy = createClaudeCliErrorSurfacePolicy();
    policy.noteAssistantMessage(true);
    expect(policy.shouldSurface(failure('api_error', 500))).toBe(true);
    expect(policy.shouldSurface(failure('api_error', 500))).toBe(false);
    // A produced turn resets the episode.
    policy.noteAssistantMessage(true);
    expect(policy.shouldSurface(failure('api_error', 500))).toBe(true);
  });

  it('a hidden (sub-agent) assistant message resets the episode but not the startup window', () => {
    const policy = createClaudeCliErrorSurfacePolicy();
    policy.noteAssistantMessage(false);
    // Still pre-first-VISIBLE-output: self-healing stays suppressed.
    expect(policy.shouldSurface(failure('rate_limit', 429))).toBe(false);
  });
});
