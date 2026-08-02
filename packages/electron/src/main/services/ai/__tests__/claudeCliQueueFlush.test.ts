import { describe, expect, it, vi } from 'vitest';
import type { QueueSettlementResult } from '../../PGLiteQueuedPromptsStore';
import { flushNextClaudeCliQueuedPrompt, type FlushQueuedPrompt } from '../claudeCliQueueFlush';

const settled: QueueSettlementResult = { outcome: 'settled' };

function harness(pending: FlushQueuedPrompt[]) {
  const claimed = pending.map((row) => ({ ...row, claimToken: `token-${row.id}` }));
  const deps = {
    preflight: vi.fn(async () => true),
    listPending: vi.fn(async () => pending),
    claim: vi.fn(async (id: string, _sessionId: string) => claimed.find((row) => row.id === id) ?? null),
    beginDispatch: vi.fn(async () => settled),
    completeAfterDispatch: vi.fn(async () => settled),
    failAfterDispatch: vi.fn(async () => settled),
    submit: vi.fn(async () => ({ submitted: true })),
    notifyClaimed: vi.fn(),
  };
  return deps;
}

describe('flushNextClaudeCliQueuedPrompt', () => {
  it('begins before submit and settles the exact token', async () => {
    const deps = harness([{ id: 'q1', prompt: 'first', attachments: [{ filepath: '/tmp/a.png' }] }]);
    const result = await flushNextClaudeCliQueuedPrompt({ sessionId: 's1', workspacePath: '/w' }, deps);
    expect(result).toBe(true);
    expect(deps.claim).toHaveBeenCalledWith('q1', 's1');
    expect(deps.beginDispatch).toHaveBeenCalledWith('q1', 's1', 'token-q1');
    expect(deps.submit).toHaveBeenCalledWith({
      sessionId: 's1', workspacePath: '/w', prompt: 'first',
      attachments: [{ filepath: '/tmp/a.png' }], documentContext: undefined,
    });
    expect(deps.completeAfterDispatch).toHaveBeenCalledWith('q1', 's1', 'token-q1');
    expect(deps.failAfterDispatch).not.toHaveBeenCalled();
  });

  it('treats claim notification as best-effort', async () => {
    const deps = harness([{ id: 'q1', prompt: 'first' }]);
    deps.notifyClaimed.mockImplementation(() => { throw new Error('destroyed window'); });
    await expect(
      flushNextClaudeCliQueuedPrompt({ sessionId: 's1', workspacePath: '/w' }, deps),
    ).resolves.toBe(true);
    expect(deps.submit).toHaveBeenCalledTimes(1);
    expect(deps.completeAfterDispatch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['empty', ''],
    ['whitespace', '   \n'],
  ])('visibly fails legacy %s input with zero submit side effects', async (_label, prompt) => {
    const deps = harness([{ id: 'q1', prompt }]);
    await expect(
      flushNextClaudeCliQueuedPrompt({ sessionId: 's1', workspacePath: '/w' }, deps),
    ).resolves.toBe(false);
    expect(deps.submit).not.toHaveBeenCalled();
    expect(deps.failAfterDispatch).toHaveBeenCalledWith(
      'q1', 'Queued CLI prompt had no sendable content', 's1', 'token-q1',
    );
  });

  it('admits attachment-only input', async () => {
    const deps = harness([{ id: 'q1', prompt: '', attachments: [{ filepath: '/tmp/a.png' }] }]);
    await expect(
      flushNextClaudeCliQueuedPrompt({ sessionId: 's1', workspacePath: '/w' }, deps),
    ).resolves.toBe(true);
    expect(deps.submit).toHaveBeenCalledTimes(1);
  });

  it('fails a submitted:false result instead of completing it', async () => {
    const deps = harness([{ id: 'q1', prompt: 'first' }]);
    deps.submit.mockResolvedValue({ submitted: false });
    await expect(
      flushNextClaudeCliQueuedPrompt({ sessionId: 's1', workspacePath: '/w' }, deps),
    ).resolves.toBe(false);
    expect(deps.completeAfterDispatch).not.toHaveBeenCalled();
    expect(deps.failAfterDispatch).toHaveBeenCalledWith(
      'q1', 'CLI prompt submission produced no terminal input', 's1', 'token-q1',
    );
  });

  it('same-token fails a PTY error and leaves no executing ambiguity', async () => {
    const deps = harness([{ id: 'q1', prompt: 'first' }]);
    deps.submit.mockRejectedValue(new Error('pty gone'));
    await expect(
      flushNextClaudeCliQueuedPrompt({ sessionId: 's1', workspacePath: '/w' }, deps),
    ).resolves.toBe(false);
    expect(deps.failAfterDispatch).toHaveBeenCalledWith('q1', 'pty gone', 's1', 'token-q1');
  });

  it('surfaces begin, completion, and failure settlement conflicts', async () => {
    const begin = harness([{ id: 'begin', prompt: 'first' }]);
    begin.beginDispatch.mockResolvedValue({ outcome: 'stale_owner' });
    await expect(
      flushNextClaudeCliQueuedPrompt({ sessionId: 's1', workspacePath: '/w' }, begin),
    ).rejects.toThrow(/dispatch intent was rejected: stale_owner/);
    expect(begin.submit).not.toHaveBeenCalled();

    const complete = harness([{ id: 'complete', prompt: 'first' }]);
    complete.completeAfterDispatch.mockResolvedValue({ outcome: 'terminal_conflict' });
    await expect(
      flushNextClaudeCliQueuedPrompt({ sessionId: 's1', workspacePath: '/w' }, complete),
    ).rejects.toThrow(/completion was rejected: terminal_conflict/);

    const failure = harness([{ id: 'failure', prompt: 'first' }]);
    failure.submit.mockRejectedValue(new Error('pty gone'));
    failure.failAfterDispatch.mockResolvedValue({ outcome: 'stale_owner' });
    await expect(
      flushNextClaudeCliQueuedPrompt({ sessionId: 's1', workspacePath: '/w' }, failure),
    ).rejects.toThrow(/failure settlement was rejected: stale_owner/);
  });

  it('leaves rows pending when preflight or atomic claim rejects', async () => {
    const blocked = harness([{ id: 'q1', prompt: 'first' }]);
    blocked.preflight.mockResolvedValue(false);
    await expect(
      flushNextClaudeCliQueuedPrompt({ sessionId: 's1', workspacePath: '/w' }, blocked),
    ).resolves.toBe(false);
    expect(blocked.listPending).not.toHaveBeenCalled();

    const raced = harness([{ id: 'q1', prompt: 'first' }]);
    raced.claim.mockResolvedValue(null);
    await expect(
      flushNextClaudeCliQueuedPrompt({ sessionId: 's1', workspacePath: '/w' }, raced),
    ).resolves.toBe(false);
    expect(raced.beginDispatch).not.toHaveBeenCalled();
    expect(raced.submit).not.toHaveBeenCalled();
  });
});
