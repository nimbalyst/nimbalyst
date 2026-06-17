import { describe, it, expect } from 'vitest';
import { classifyClaudeCliUpstreamError } from '../claudeCliErrorClassifier';

/**
 * NIM-808 — a failed `claude-code-cli` turn must surface in the rich transcript.
 * The proxy hands us `{statusCode, body}` for any non-2xx upstream response;
 * these tests pin the classification that drives which widget renders.
 */
describe('classifyClaudeCliUpstreamError', () => {
  it('classifies a 400 "prompt is too long" as context_limit', () => {
    const body = JSON.stringify({
      type: 'error',
      error: { type: 'invalid_request_error', message: 'prompt is too long: 215534 tokens > 200000 maximum' },
    });
    const failure = classifyClaudeCliUpstreamError({ statusCode: 400, body });
    expect(failure?.kind).toBe('context_limit');
    // The persisted row text is derived from `message`; it must carry a phrase
    // the ContextLimitWidget detector matches.
    expect(failure?.message.toLowerCase()).toContain('prompt is too long');
  });

  it('classifies a 429 as rate_limit and preserves retry-after', () => {
    const body = JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'rate limited' } });
    const failure = classifyClaudeCliUpstreamError({ statusCode: 429, body, retryAfter: '60' });
    expect(failure?.kind).toBe('rate_limit');
    expect(failure?.retryAfter).toBe('60');
  });

  it('classifies a 529 as overloaded', () => {
    const body = JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } });
    expect(classifyClaudeCliUpstreamError({ statusCode: 529, body })?.kind).toBe('overloaded');
  });

  it('classifies 401/403 as auth', () => {
    expect(classifyClaudeCliUpstreamError({ statusCode: 401 })?.kind).toBe('auth');
    expect(classifyClaudeCliUpstreamError({ statusCode: 403 })?.kind).toBe('auth');
  });

  it('classifies other 5xx as api_error and carries the error type', () => {
    const body = JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'Internal server error' } });
    const failure = classifyClaudeCliUpstreamError({ statusCode: 500, body });
    expect(failure?.kind).toBe('api_error');
    expect(failure?.errorType).toBe('api_error');
  });

  it('falls back to generic for an unrecognized 4xx', () => {
    expect(classifyClaudeCliUpstreamError({ statusCode: 418 })?.kind).toBe('generic');
  });

  it('is tolerant of a missing / non-JSON body', () => {
    const failure = classifyClaudeCliUpstreamError({ statusCode: 429, body: 'not json' });
    expect(failure?.kind).toBe('rate_limit');
    expect(typeof failure?.message).toBe('string');
  });

  it('returns null for a success status', () => {
    expect(classifyClaudeCliUpstreamError({ statusCode: 200 })).toBeNull();
  });
});
