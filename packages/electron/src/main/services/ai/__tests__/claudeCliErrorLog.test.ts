import { describe, it, expect, vi } from 'vitest';
import { projectRawMessagesToViewMessages } from '@nimbalyst/runtime/ai/server/transcript';
import type { RawMessage } from '@nimbalyst/runtime/ai/server/transcript';
import {
  buildClaudeCliErrorContent,
  logClaudeCliUpstreamError,
  type LogClaudeCliUpstreamErrorDeps,
} from '../claudeCliErrorLog';
import type { ClaudeCliFailure } from '../claudeCliErrorClassifier';

/**
 * NIM-808 — a failed `claude-code-cli` turn must render in the rich transcript
 * (not a silent hang). These tests pin the persisted row shape so the existing
 * ClaudeCodeRawParser → MessageSegment error widgets fire.
 */

function failure(partial: Partial<ClaudeCliFailure> & { kind: ClaudeCliFailure['kind'] }): ClaudeCliFailure {
  return { statusCode: 500, message: 'boom', ...partial };
}

describe('buildClaudeCliErrorContent', () => {
  it('keeps a context-limit phrase the ContextLimitWidget detects', () => {
    const content = buildClaudeCliErrorContent(
      failure({ kind: 'context_limit', statusCode: 400, message: 'prompt is too long: 215534 tokens > 200000 maximum' }),
    );
    const parsed = JSON.parse(content);
    expect(parsed.type).toBe('error');
    expect(String(JSON.stringify(parsed)).toLowerCase()).toContain('prompt is too long');
  });

  it('flags auth errors so the login widget renders', () => {
    const parsed = JSON.parse(buildClaudeCliErrorContent(failure({ kind: 'auth', statusCode: 401, message: 'Authentication failed' })));
    expect(parsed.is_auth_error).toBe(true);
  });

  it('carries the overloaded/api_error type token so ApiServiceErrorWidget detects it', () => {
    const overloaded = JSON.stringify(JSON.parse(buildClaudeCliErrorContent(failure({ kind: 'overloaded', statusCode: 529 }))));
    expect(overloaded).toContain('overloaded_error');
    const apiErr = JSON.stringify(JSON.parse(buildClaudeCliErrorContent(failure({ kind: 'api_error', statusCode: 500, errorType: 'api_error' }))));
    expect(apiErr).toContain('api_error');
  });

  it('renders a rate-limit as a plain human message (no scary JSON)', () => {
    const parsed = JSON.parse(buildClaudeCliErrorContent(failure({ kind: 'rate_limit', statusCode: 429, message: 'Rate limit reached. Claude paused this turn; it will retry shortly.' })));
    expect(typeof parsed.error).toBe('string');
    expect(parsed.error).toContain('paused');
  });
});

describe('logClaudeCliUpstreamError', () => {
  it('persists an output error row and broadcasts a transcript reload', async () => {
    const createMessage = vi.fn().mockResolvedValue(undefined);
    const notifyMessageLogged = vi.fn();
    const deps: LogClaudeCliUpstreamErrorDeps = {
      createMessage,
      notifyMessageLogged,
      now: () => new Date('2026-06-09T00:00:00.000Z'),
    };
    await logClaudeCliUpstreamError(
      { sessionId: 's1', workspacePath: '/w', failure: failure({ kind: 'rate_limit', statusCode: 429, message: 'Rate limit reached. Claude paused this turn; it will retry shortly.' }) },
      deps,
    );
    expect(createMessage).toHaveBeenCalledTimes(1);
    const row = createMessage.mock.calls[0][0];
    expect(row.sessionId).toBe('s1');
    expect(row.source).toBe('claude-code');
    expect(row.direction).toBe('output');
    expect(row.hidden).toBe(false);
    const parsed = JSON.parse(row.content);
    expect(parsed.type).toBe('error');
    expect(notifyMessageLogged).toHaveBeenCalledWith('s1', '/w');
  });

  it('swallows a repository failure (the CLI turn is unaffected)', async () => {
    const deps: LogClaudeCliUpstreamErrorDeps = {
      createMessage: vi.fn().mockRejectedValue(new Error('db down')),
      notifyMessageLogged: vi.fn(),
      now: () => new Date(),
    };
    await expect(
      logClaudeCliUpstreamError({ sessionId: 's1', workspacePath: '/w', failure: failure({ kind: 'api_error' }) }, deps),
    ).resolves.toBeUndefined();
  });
});

/**
 * Faithful end-to-end check: the row built by `buildClaudeCliErrorContent` must
 * project — through the REAL `ClaudeCodeRawParser` the renderer uses — into an
 * `isError` message carrying the phrase `MessageSegment` routes on. This is what
 * turns a failed/rate-limited turn from a silent hang into a visible widget.
 */
describe('claude-code-cli error row → real transcript projection', () => {
  function errorRow(f: ClaudeCliFailure): RawMessage {
    return {
      id: 1,
      sessionId: 's1',
      source: 'claude-code',
      direction: 'output',
      content: buildClaudeCliErrorContent(f),
      createdAt: new Date('2026-06-09T00:00:00Z'),
    } as RawMessage;
  }

  it('context-limit projects to an isError message with the "prompt is too long" phrase', async () => {
    const vms = await projectRawMessagesToViewMessages(
      [errorRow(failure({ kind: 'context_limit', statusCode: 400, message: 'prompt is too long: 215534 tokens > 200000 maximum' }))],
      'claude-code-cli',
    );
    const err: any = vms.find((m: any) => m?.isError);
    expect(err).toBeDefined();
    expect(String(err.text).toLowerCase()).toContain('prompt is too long');
  });

  it('auth projects to an isError + isAuthError message (login widget path)', async () => {
    const vms = await projectRawMessagesToViewMessages(
      [errorRow(failure({ kind: 'auth', statusCode: 401, message: 'Authentication failed' }))],
      'claude-code-cli',
    );
    const err: any = vms.find((m: any) => m?.isError);
    expect(err).toBeDefined();
    expect(err.isAuthError).toBe(true);
  });

  it('overloaded projects to an isError message carrying the api-service token', async () => {
    const vms = await projectRawMessagesToViewMessages(
      [errorRow(failure({ kind: 'overloaded', statusCode: 529, message: 'Claude is temporarily overloaded.' }))],
      'claude-code-cli',
    );
    const err: any = vms.find((m: any) => m?.isError);
    expect(err).toBeDefined();
    expect(String(err.text)).toContain('overloaded_error');
  });
});
