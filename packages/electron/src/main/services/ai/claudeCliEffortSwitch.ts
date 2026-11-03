/**
 * Mid-session effort switching for `claude-code-cli` sessions.
 *
 * `--effort` fixes the level for the life of the process, so the composer's
 * effort selector was hidden once a CLI session had spawned: the control existed
 * but could not do anything. The CLI's own `/effort <level>` slash command is a
 * direct setter, so a running session can be retuned by typing it into the PTY,
 * exactly as `claudeCliModelSwitch` already does for `/model`.
 *
 * This only works because the launch path passes `--effort` instead of exporting
 * CLAUDE_CODE_EFFORT_LEVEL. An exported value outranks both the flag and the
 * slash command, and the CLI says so itself:
 *
 *   "CLAUDE_CODE_EFFORT_LEVEL=max overrides this session - clear it and high
 *    takes over"
 *
 * The write is two-step (text, gap, then Enter) mirroring `claudeCliSubmit` and
 * `claudeCliModelSwitch`: a single `text + \r` write can leave the Ink TUI
 * showing the text without consuming Enter.
 */

/** Gap between the command write and the Enter write (same as the model switch). */
export const EFFORT_SWITCH_WRITE_GAP_MS = 25;

/**
 * Levels the CLI accepts. Kept as a local literal rather than imported from the
 * runtime's EffortLevel so an unvalidated string can never be typed into a live
 * PTY; the union is checked at the boundary instead of trusted from the caller.
 */
const VALID_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

export interface SwitchClaudeCliEffortInput {
  sessionId: string;
  effortLevel: string | undefined;
}

export interface SwitchClaudeCliEffortDeps {
  writeToTerminal: (sessionId: string, data: string) => void;
  delay: (ms: number) => Promise<void>;
}

export type SwitchClaudeCliEffortResult =
  | { switched: true; level: string }
  | { switched: false };

/** Build the `/effort <level>` line, or null when the level is not recognised. */
export function buildClaudeCliEffortSwitchCommand(
  effortLevel: string | undefined,
): string | null {
  if (!effortLevel || !VALID_LEVELS.has(effortLevel)) return null;
  return `/effort ${effortLevel}`;
}

/** Type the `/effort` command into the session's PTY. */
export async function switchClaudeCliEffort(
  input: SwitchClaudeCliEffortInput,
  deps: SwitchClaudeCliEffortDeps,
): Promise<SwitchClaudeCliEffortResult> {
  const command = buildClaudeCliEffortSwitchCommand(input.effortLevel);
  if (!command) return { switched: false };

  deps.writeToTerminal(input.sessionId, command);
  await deps.delay(EFFORT_SWITCH_WRITE_GAP_MS);
  deps.writeToTerminal(input.sessionId, '\r');

  return { switched: true, level: command.slice('/effort '.length) };
}
