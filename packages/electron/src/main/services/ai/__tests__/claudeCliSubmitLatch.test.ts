// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  createClaudeCliSubmitLatch,
  submitDrainDeadlineMs,
} from '../claudeCliSubmitLatch';

describe('claude-code-cli submit latch', () => {
  it('holds a session from the moment we write until the CLI picks the turn up', () => {
    let now = 1000;
    const latch = createClaudeCliSubmitLatch({ now: () => now });

    expect(latch.isInFlight('s1')).toBe(false);

    latch.mark('s1', 500);
    expect(latch.isInFlight('s1')).toBe(true);
    // Other sessions are unaffected.
    expect(latch.isInFlight('s2')).toBe(false);

    // The PID watcher reporting a turn is the real "the CLI consumed it" signal.
    latch.clear('s1');
    expect(latch.isInFlight('s1')).toBe(false);
  });

  it('expires on its own so a CLI that never starts a turn cannot wedge the queue', () => {
    let now = 1000;
    const latch = createClaudeCliSubmitLatch({ now: () => now });

    latch.mark('s1', 500);
    now += submitDrainDeadlineMs(500) - 1;
    expect(latch.isInFlight('s1')).toBe(true);

    now += 2;
    expect(latch.isInFlight('s1')).toBe(false);
  });

  it('keeps the longest deadline across the writes that make up one submit', () => {
    let now = 1000;
    const latch = createClaudeCliSubmitLatch({ now: () => now });

    // A submit is the payload write followed by a separate Enter write. The
    // one-character Enter must not shorten the big payload's window.
    latch.mark('s1', 250_000);
    latch.mark('s1', 1);

    now += submitDrainDeadlineMs(1) + 1;
    expect(latch.isInFlight('s1')).toBe(true);
  });

  it('scales the deadline with payload size, because ConPTY delivers ~31k chars/sec', () => {
    // A 250k paste measured ~8s to reach the CLI on Windows; the deadline has to
    // outlast that or the latch lifts while the payload is still arriving.
    expect(submitDrainDeadlineMs(250_000)).toBeGreaterThan(8_000);
    // Short prompts still get a floor — the CLI needs a moment to start the turn.
    expect(submitDrainDeadlineMs(0)).toBeGreaterThanOrEqual(3_000);
    expect(submitDrainDeadlineMs(10)).toEqual(submitDrainDeadlineMs(0));
    // Bounded, so a pathological payload can't stall the queue indefinitely.
    expect(submitDrainDeadlineMs(100_000_000)).toBeLessThanOrEqual(120_000);
  });
});
