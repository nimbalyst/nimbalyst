// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { createIndexSendChannel, IndexSendError, throwIfUnsent, type IndexSocketLike } from '../indexSendChannel';

/** One poll interval plus scheduling jitter, the most the wait may overshoot. */
const POLL_SLACK_MS = 60;

const OPEN = 1;
const CONNECTING = 0;
const CLOSED = 3;

class FakeSocket implements IndexSocketLike {
  sent: string[] = [];
  constructor(public readyState: number = OPEN) {}
  send(payload: string): void {
    if (this.readyState !== OPEN) throw new Error('send on a socket that is not OPEN');
    this.sent.push(payload);
  }
  /** Complete a handshake that was still in flight. */
  open(): void { this.readyState = OPEN; }
  close(): void { this.readyState = CLOSED; }
}

/** A provider-shaped harness: one live socket, a generation bumped on reconnect. */
function harness(initial: FakeSocket | null) {
  const state = { socket: initial, generation: 0, connected: initial?.readyState === OPEN };
  const channel = createIndexSendChannel({
    getSocket: () => state.socket,
    getGeneration: () => state.generation,
    isConnected: () => state.connected,
    connect: async () => { state.connected = state.socket?.readyState === OPEN; },
  });
  const reconnect = (next: FakeSocket) => {
    state.socket?.close();
    state.socket = next;
    state.generation++;
    state.connected = next.readyState === OPEN;
  };
  return { state, channel, reconnect };
}

describe('index send channel', () => {
  /**
   * R-C1-3: the socket resolved before the encryption await is not necessarily
   * the socket that is live after it. Sending on the old one throws (or goes
   * nowhere) and the replacement never carries the response.
   */
  it('sends on the replacement socket when a reconnect lands during the build', async () => {
    const original = new FakeSocket();
    const { channel, reconnect, state } = harness(original);
    const replacement = new FakeSocket();

    let turnedOver = false;
    const outcome = await channel.send('create worktree response', async () => {
      // The encryption await, during which the connection turns over once.
      if (!turnedOver) { turnedOver = true; reconnect(replacement); }
      return '{"type":"createWorktreeResponse"}';
    });

    expect(outcome.sent).toBe(true);
    expect(original.sent).toEqual([]);
    expect(replacement.sent).toEqual(['{"type":"createWorktreeResponse"}']);
    expect(state.generation).toBe(1);
  });

  /**
   * R-C1-4: connectToIndex constructs the socket without awaiting onopen, so a
   * real handshake leaves it CONNECTING when the helper looks. The response
   * must wait for the open, not be discarded.
   */
  it('waits for a socket that opens on a later tick', async () => {
    const connecting = new FakeSocket(CONNECTING);
    const { channel, state } = harness(connecting);
    setTimeout(() => { connecting.open(); state.connected = true; }, 5);

    const outcome = await channel.send('create session response', () => '{"type":"createSessionResponse"}');

    expect(outcome.sent).toBe(true);
    expect(connecting.sent).toEqual(['{"type":"createSessionResponse"}']);
  });

  /**
   * R-C1-5: a build that throws (an encryption failure) used to leave the
   * public sender fulfilling with nothing on the wire.
   */
  it('reports a build failure as unsent and non-retryable', async () => {
    const socket = new FakeSocket();
    const { channel } = harness(socket);

    const outcome = await channel.send('create session request', async () => {
      throw new Error('project id encryption failed');
    });

    expect(outcome).toEqual({
      sent: false,
      reason: 'failed to build create session request',
      retryable: false,
    });
    expect(socket.sent).toEqual([]);
  });

  it('turns every unsent outcome into a rejection carrying reason and retryable', () => {
    expect(() => throwIfUnsent('create session request', {
      sent: false, reason: 'failed to build create session request', retryable: false,
    })).toThrowError(IndexSendError);

    try {
      throwIfUnsent('create worktree response', { sent: false, reason: 'no open index connection', retryable: true });
    } catch (err) {
      const sendError = err as IndexSendError;
      expect(sendError.reason).toBe('no open index connection');
      expect(sendError.retryable).toBe(true);
      expect(sendError.message).toContain('create worktree response');
    }

    expect(() => throwIfUnsent('create session response', { sent: true })).not.toThrow();
  });

  /**
   * R-C1-6: the budget is elapsed time, not timer executions. A stalled event
   * loop used to stretch the wait -- every late callback still counted as one
   * more tick of headroom -- so a 250ms stall inside a 200ms budget kept
   * polling after it. Real timers, deliberately: the defect only shows when
   * callbacks actually run late.
   */
  it('does not extend the open-wait past the budget when the event loop stalls', async () => {
    const { channel } = harness(null);
    const startedAt = performance.now();

    const sending = channel.send('create session response', () => '{}', { openTimeoutMs: 200 });
    // Block the loop well past the budget, the way a long synchronous task does.
    const stallUntil = performance.now() + 250;
    while (performance.now() < stallUntil) { /* burn the event loop */ }

    const outcome = await sending;
    const elapsed = performance.now() - startedAt;

    expect(outcome.sent).toBe(false);
    // The stall itself is unavoidable; what must not happen is waiting on past it.
    expect(elapsed).toBeLessThan(250 + POLL_SLACK_MS);
  });

  it('reports a retryable outcome when the connection never comes up', async () => {
    const { channel } = harness(null);
    const outcome = await channel.send('session control message', () => '{}', { openTimeoutMs: 20 });
    expect(outcome.sent).toBe(false);
    expect(outcome.retryable).toBe(true);
  });
});
