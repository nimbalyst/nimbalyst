import { describe, it, expect } from 'vitest';
import { escalateClaudeCliInterrupt, CLAUDE_CLI_INTERRUPT } from '../claudeCliInterrupt';
import type { ClaudeTurnState } from '../claudeCliPidState';

/**
 * NIM-814: a single Ctrl-C can be ignored by a CLI blocked in a network read,
 * leaving the turn (and the red X) dead. The stop path escalates:
 * Ctrl-C → Ctrl-C → SIGINT, re-checking the PID-file turn state between steps.
 */

function harness(stateSequence: Array<ClaudeTurnState | null>) {
  const writes: string[] = [];
  const kills: Array<string | undefined> = [];
  const delays: number[] = [];
  let readIndex = 0;
  const result = escalateClaudeCliInterrupt({
    write: (data) => writes.push(data),
    kill: (signal) => kills.push(signal),
    readTurnState: async () => {
      const state = stateSequence[Math.min(readIndex, stateSequence.length - 1)];
      readIndex += 1;
      return state;
    },
    delay: async (ms) => {
      delays.push(ms);
    },
  });
  return { writes, kills, delays, result };
}

describe('escalateClaudeCliInterrupt', () => {
  /**
   * NIM-842: an interrupt against an already-resolved turn must be a no-op.
   * Writing Ctrl-C anyway pushes a keystroke into the idle TUI; the claude TUI
   * treats Ctrl-C at an idle prompt as "press again to exit", so two interrupt
   * requests against an idle session quit the CLI entirely (exit code 0) and
   * every later prompt is dropped into a dead terminal.
   */
  it('is a no-op (no write, no kill) when the turn is already idle', async () => {
    const h = harness(['idle']);
    const outcome = await h.result;
    expect(h.writes).toEqual([]);
    expect(h.kills).toEqual([]);
    expect(outcome.resolvedAfter).toBe('already-idle');
  });

  it('is a no-op when the turn is already waiting_for_input', async () => {
    const h = harness(['waiting_for_input']);
    const outcome = await h.result;
    expect(h.writes).toEqual([]);
    expect(h.kills).toEqual([]);
    expect(outcome.resolvedAfter).toBe('already-idle');
  });

  it('stops after the first Ctrl-C when the turn resolves', async () => {
    const h = harness(['running', 'idle']);
    const outcome = await h.result;
    expect(h.writes).toEqual([CLAUDE_CLI_INTERRUPT]);
    expect(h.kills).toEqual([]);
    expect(outcome.resolvedAfter).toBe('first-interrupt');
  });

  it('treats waiting_for_input after the first Ctrl-C as resolved (turn no longer running)', async () => {
    const h = harness(['running', 'waiting_for_input']);
    const outcome = await h.result;
    expect(h.writes).toEqual([CLAUDE_CLI_INTERRUPT]);
    expect(outcome.resolvedAfter).toBe('first-interrupt');
  });

  it('sends a second Ctrl-C when still running, and stops there if it works', async () => {
    const h = harness(['running', 'running', 'idle']);
    const outcome = await h.result;
    expect(h.writes).toEqual([CLAUDE_CLI_INTERRUPT, CLAUDE_CLI_INTERRUPT]);
    expect(h.kills).toEqual([]);
    expect(outcome.resolvedAfter).toBe('second-interrupt');
  });

  it('escalates to SIGINT when both Ctrl-Cs are ignored', async () => {
    const h = harness(['running', 'running', 'running', 'idle']);
    const outcome = await h.result;
    expect(h.writes).toEqual([CLAUDE_CLI_INTERRUPT, CLAUDE_CLI_INTERRUPT]);
    expect(h.kills).toEqual(['SIGINT']);
    expect(outcome.resolvedAfter).toBe('sigint');
  });

  it('reports unresolved when even SIGINT does not clear the turn', async () => {
    const h = harness(['running', 'running', 'running', 'running']);
    const outcome = await h.result;
    expect(h.kills).toEqual(['SIGINT']);
    expect(outcome.resolvedAfter).toBe('unresolved');
  });

  it('keeps escalating while the state is unknown (null) — an unobservable turn is not a resolved one', async () => {
    const h = harness([null, null, null, 'idle']);
    const outcome = await h.result;
    expect(h.writes).toEqual([CLAUDE_CLI_INTERRUPT, CLAUDE_CLI_INTERRUPT]);
    expect(h.kills).toEqual(['SIGINT']);
    expect(outcome.resolvedAfter).toBe('sigint');
  });
});
