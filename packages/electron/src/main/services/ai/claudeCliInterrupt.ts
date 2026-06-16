/**
 * Escalating interrupt for a hung Claude CLI turn (NIM-814).
 *
 * A single Ctrl-C through the PTY is the polite stop, but a CLI blocked in a
 * network read can ignore it — leaving the session pinned on "Thinking" with a
 * dead red X. The stop path therefore escalates:
 *
 *   1. Ctrl-C (PTY keystroke — the CLI's normal turn interrupt)
 *   2. second Ctrl-C (some TUIs require a confirm press; also re-delivers)
 *   3. SIGINT via pty.kill (signal delivery interrupts a blocked syscall the
 *      tty read path never reaches)
 *
 * Between steps the PID-file turn state is re-checked (see
 * `readClaudePidTurnState`); escalation stops as soon as the turn is no longer
 * `running`. An unknown state (`null` — unreadable file with a live process)
 * keeps escalating: an unobservable turn is not a resolved one.
 *
 * Dependency-injected so it unit-tests without a PTY or real delays.
 */

import type { ClaudeTurnState } from './claudeCliPidState';

/** Ctrl-C byte, as terminal input. */
export const CLAUDE_CLI_INTERRUPT = '\x03';

/** How long to wait after each step before re-checking the turn state. */
const STEP_SETTLE_MS = 1500;

export interface ClaudeCliInterruptDeps {
  /** Write raw input to the CLI's PTY. */
  write: (data: string) => void;
  /** Deliver a signal to the CLI process (node-pty `kill`). */
  kill: (signal?: string) => void;
  /** One-shot turn-state read; null = unknown. */
  readTurnState: () => Promise<ClaudeTurnState | null>;
  /** Delay override (tests). Defaults to setTimeout. */
  delay?: (ms: number) => Promise<void>;
  /** Optional progress logger. */
  log?: (message: string) => void;
}

export interface ClaudeCliInterruptResult {
  resolvedAfter: 'already-idle' | 'first-interrupt' | 'second-interrupt' | 'sigint' | 'unresolved';
}

const defaultDelay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A turn counts as resolved once it is observably not running. */
function isResolved(state: ClaudeTurnState | null): boolean {
  return state === 'idle' || state === 'waiting_for_input';
}

export async function escalateClaudeCliInterrupt(
  deps: ClaudeCliInterruptDeps
): Promise<ClaudeCliInterruptResult> {
  const delay = deps.delay ?? defaultDelay;
  const log = deps.log ?? (() => {});

  // NIM-842: idle/waiting turns have nothing to interrupt. Writing Ctrl-C
  // anyway pushes a keystroke into the idle TUI, and the claude TUI treats
  // Ctrl-C at an idle prompt as "press again to exit" — so two interrupts
  // against an idle session quit the CLI. Bail before writing.
  if (isResolved(await deps.readTurnState())) {
    return { resolvedAfter: 'already-idle' };
  }

  deps.write(CLAUDE_CLI_INTERRUPT);
  await delay(STEP_SETTLE_MS);
  if (isResolved(await deps.readTurnState())) {
    return { resolvedAfter: 'first-interrupt' };
  }

  log('first Ctrl-C ignored; sending second');
  deps.write(CLAUDE_CLI_INTERRUPT);
  await delay(STEP_SETTLE_MS);
  if (isResolved(await deps.readTurnState())) {
    return { resolvedAfter: 'second-interrupt' };
  }

  log('Ctrl-C ignored twice; delivering SIGINT');
  try {
    deps.kill('SIGINT');
  } catch {
    // Process already gone — the next state read reports idle via liveness.
  }
  await delay(STEP_SETTLE_MS);
  if (isResolved(await deps.readTurnState())) {
    return { resolvedAfter: 'sigint' };
  }

  log('turn still running after SIGINT');
  return { resolvedAfter: 'unresolved' };
}
