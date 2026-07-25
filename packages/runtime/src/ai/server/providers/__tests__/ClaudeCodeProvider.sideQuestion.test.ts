import { describe, it, expect, vi } from 'vitest';
import { ClaudeCodeProvider } from '../ClaudeCodeProvider';

/**
 * Coverage for `/btw` (side questions) on the Claude Agent path.
 *
 * The underlying `askSideQuestion` control request is present in the shipped
 * claude-agent-sdk bundle but absent from its published types, so the provider
 * feature-detects it. These tests pin that contract: every failure mode must
 * come back as a named reason the UI can explain, never as a throw.
 */

/** Minimal stand-in for the live SDK query the provider holds mid-turn. */
function providerWithQuery(query: unknown): ClaudeCodeProvider {
  const provider = Object.create(ClaudeCodeProvider.prototype) as ClaudeCodeProvider;
  (provider as unknown as { leadQuery: unknown }).leadQuery = query;
  return provider;
}

describe('ClaudeCodeProvider.askSideQuestion', () => {
  it('returns the answer when the SDK supports side questions', async () => {
    const askSideQuestion = vi.fn().mockResolvedValue({ response: '42', synthetic: false });
    const provider = providerWithQuery({ askSideQuestion });

    const result = await provider.askSideQuestion('what is the answer?');

    expect(result).toEqual({ ok: true, response: '42', synthetic: false });
    // The question is forwarded trimmed, exactly once.
    expect(askSideQuestion).toHaveBeenCalledTimes(1);
    expect(askSideQuestion).toHaveBeenCalledWith('what is the answer?');
  });

  it('trims the question and defaults synthetic to false when omitted', async () => {
    const askSideQuestion = vi.fn().mockResolvedValue({ response: 'ok' });
    const provider = providerWithQuery({ askSideQuestion });

    const result = await provider.askSideQuestion('   spaced out   ');

    expect(askSideQuestion).toHaveBeenCalledWith('spaced out');
    expect(result).toEqual({ ok: true, response: 'ok', synthetic: false });
  });

  it('reports `idle` when no turn is streaming', async () => {
    // leadQuery is nulled at the end of every turn, so there is no control
    // channel to ask alongside — this is the common case, not an error.
    const provider = providerWithQuery(null);

    expect(await provider.askSideQuestion('anything')).toEqual({ ok: false, reason: 'idle' });
  });

  it('reports `unsupported` when the bundled CLI lacks the control request', async () => {
    // Guards the undocumented-API risk: an SDK without askSideQuestion must
    // degrade to a clear message, not a TypeError.
    const provider = providerWithQuery({ interrupt: vi.fn() });

    expect(await provider.askSideQuestion('anything')).toEqual({ ok: false, reason: 'unsupported' });
  });

  it('reports `empty` for a blank question without touching the transport', async () => {
    const askSideQuestion = vi.fn();
    const provider = providerWithQuery({ askSideQuestion });

    expect(await provider.askSideQuestion('   ')).toEqual({ ok: false, reason: 'empty' });
    expect(askSideQuestion).not.toHaveBeenCalled();
  });

  it('reports `no-answer` when the control request resolves without a response', async () => {
    const provider = providerWithQuery({ askSideQuestion: vi.fn().mockResolvedValue(null) });

    expect(await provider.askSideQuestion('anything')).toEqual({ ok: false, reason: 'no-answer' });
  });

  it('reports `error` with the message instead of throwing when the transport rejects', async () => {
    const provider = providerWithQuery({
      askSideQuestion: vi.fn().mockRejectedValue(new Error('transport closed')),
    });

    expect(await provider.askSideQuestion('anything')).toEqual({
      ok: false,
      reason: 'error',
      message: 'transport closed',
    });
  });
});
