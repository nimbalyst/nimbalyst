// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { shouldSettleUnterminatedTurn, shouldForceIdleOnCancel } from '../sessionSettlePolicy';

describe('shouldSettleUnterminatedTurn', () => {
  const base = {
    sawComplete: false,
    providerError: undefined as string | undefined,
    alreadySettled: false,
    queuedChainActive: false,
  };

  it('settles a built-in provider stream that yielded an error chunk and returned without completing', () => {
    // The Codex app-server RPC failure: sendMessage catches, yields one in-band
    // error chunk, then returns normally -- neither the `complete` branch nor
    // the outer catch runs, so the session stayed `running` forever.
    expect(shouldSettleUnterminatedTurn({
      ...base,
      providerError: '[CodexAppServer] RPC error -32602: Input exceeds the maximum length of 1048576 characters.',
    })).toBe(true);
  });

  it('does not settle when the stream reached its complete chunk', () => {
    expect(shouldSettleUnterminatedTurn({
      ...base,
      providerError: 'transient tool failure',
      sawComplete: true,
    })).toBe(false);
  });

  it('does not settle a clean stream that never errored', () => {
    expect(shouldSettleUnterminatedTurn({ ...base, sawComplete: true })).toBe(false);
  });

  it('does not double-settle when the extension-agent branch already ended the session', () => {
    expect(shouldSettleUnterminatedTurn({
      ...base,
      providerError: 'gemini backend failed',
      alreadySettled: true,
    })).toBe(false);
  });

  it('defers to the queued-prompt chain when one is still driving the session', () => {
    expect(shouldSettleUnterminatedTurn({
      ...base,
      providerError: 'boom',
      queuedChainActive: true,
    })).toBe(false);
  });
});

describe('shouldForceIdleOnCancel', () => {
  it('clears a session still tracked as running, so one click stops it even after the turn died', () => {
    expect(shouldForceIdleOnCancel({ status: 'running' })).toBe(true);
  });

  it('clears a streaming session whose status has not flipped to running yet', () => {
    expect(shouldForceIdleOnCancel({ status: 'idle', isStreaming: true })).toBe(true);
  });

  it('leaves an idle session alone so a stray click emits no interrupt', () => {
    expect(shouldForceIdleOnCancel({ status: 'idle' })).toBe(false);
  });

  it('leaves a session waiting for input alone', () => {
    expect(shouldForceIdleOnCancel({ status: 'waiting_for_input' })).toBe(false);
  });

  it('handles an untracked session', () => {
    expect(shouldForceIdleOnCancel(null)).toBe(false);
  });
});
