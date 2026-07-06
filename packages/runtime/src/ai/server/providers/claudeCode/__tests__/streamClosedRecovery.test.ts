import { describe, expect, it } from 'vitest';
import {
  buildStreamClosedContinuationMessage,
  classifyStreamClosedContinuation,
  extractStreamClosedToolName,
} from '../streamClosedRecovery';

describe('classifyStreamClosedContinuation', () => {
  it('continues under the retry cap when a stream-closed tool result was seen', () => {
    expect(
      classifyStreamClosedContinuation({
        sawStreamClosed: true,
        retryCount: 0,
        maxRetries: 2,
        drainExitCause: 'resolved',
        hasPendingUserStop: false,
      }),
    ).toEqual({ continue: true, reason: 'retry' });
  });

  it('stops once the retry cap is exhausted', () => {
    expect(
      classifyStreamClosedContinuation({
        sawStreamClosed: true,
        retryCount: 2,
        maxRetries: 2,
        drainExitCause: 'resolved',
        hasPendingUserStop: false,
      }),
    ).toEqual({ continue: false, reason: 'exhausted' });
  });

  it('does not continue when no stream-closed result was seen', () => {
    expect(
      classifyStreamClosedContinuation({
        sawStreamClosed: false,
        retryCount: 0,
        maxRetries: 2,
        drainExitCause: 'resolved',
        hasPendingUserStop: false,
      }),
    ).toEqual({ continue: false, reason: 'not-applicable' });
  });

  it('does not continue after abort, interrupt, or an explicit user stop', () => {
    expect(
      classifyStreamClosedContinuation({
        sawStreamClosed: true,
        retryCount: 0,
        maxRetries: 2,
        drainExitCause: 'aborted',
        hasPendingUserStop: false,
      }),
    ).toEqual({ continue: false, reason: 'aborted' });
    expect(
      classifyStreamClosedContinuation({
        sawStreamClosed: true,
        retryCount: 0,
        maxRetries: 2,
        drainExitCause: 'interrupted',
        hasPendingUserStop: false,
      }),
    ).toEqual({ continue: false, reason: 'aborted' });
    expect(
      classifyStreamClosedContinuation({
        sawStreamClosed: true,
        retryCount: 0,
        maxRetries: 2,
        drainExitCause: 'resolved',
        hasPendingUserStop: true,
      }),
    ).toEqual({ continue: false, reason: 'aborted' });
  });
});

describe('buildStreamClosedContinuationMessage', () => {
  it('builds a visible system continuation and names the failed tool when known', () => {
    const message = buildStreamClosedContinuationMessage('Bash');

    expect(message).toContain('[System:');
    expect(message).toContain('Stream closed');
    expect(message).toContain('Bash');
    expect(message).toContain('continue');
  });
});

describe('extractStreamClosedToolName', () => {
  it('returns a tool name only for narrowed stream-closed tool results', () => {
    expect(
      extractStreamClosedToolName({
        isError: true,
        resultText: 'Tool permission request failed: Error: Stream closed',
        toolName: 'Bash',
      }),
    ).toBe('Bash');
    expect(
      extractStreamClosedToolName({
        isError: false,
        resultText: 'Stream closed',
        toolName: 'Bash',
      }),
    ).toBeNull();
    expect(
      extractStreamClosedToolName({
        isError: true,
        resultText: 'regular tool failure',
        toolName: 'Bash',
      }),
    ).toBeNull();
  });
});
