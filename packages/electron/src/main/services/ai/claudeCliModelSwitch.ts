/**
 * Mid-session model switching for `claude-code-cli` sessions (NIM-806).
 *
 * The genuine CLI's `/model <value>` slash command is a direct setter, so the
 * Nimbalyst model picker can retune a RUNNING CLI session by typing the
 * command into the PTY — no respawn needed. Values reuse
 * `resolveClaudeCliModelArg` so picker ids map to the CLI's own aliases
 * (`claude-code-cli:fable` → `fable`, `claude-code-cli:opus-1m` → `opus[1m]`,
 * pinned opus variants collapse to `opus`); non-claude ids never reach the PTY.
 *
 * The write is two-step (text, gap, then Enter) mirroring `claudeCliSubmit` —
 * a single `text + \r` write can leave the Ink TUI showing the text without
 * consuming Enter. The renderer gates this to idle turns; persisting the new
 * model on the session row (so `--model` agrees on the next respawn/resume)
 * stays with the existing `sessions:update-metadata` call in the renderer.
 */

import { resolveClaudeCliModelArg } from './claudeCliSpawnConfig';

/** Gap between the command write and the Enter write (same as claudeCliSubmit). */
export const MODEL_SWITCH_WRITE_GAP_MS = 25;

export interface SwitchClaudeCliModelInput {
  sessionId: string;
  /** Picker model id — combined (`claude-code-cli:fable`) or bare variant. */
  model: string | undefined;
}

export interface SwitchClaudeCliModelDeps {
  writeToTerminal: (sessionId: string, data: string) => void;
  delay: (ms: number) => Promise<void>;
  /**
   * Recent PTY output for this session (terminal scrollback tail), used to spot
   * the confirmation dialog. Omit to skip confirmation entirely.
   */
  readRecentOutput?: (sessionId: string) => string;
}

export type SwitchClaudeCliModelResult =
  | { switched: true; cliArg: string; confirmed?: true }
  | { switched: false };

/** How long to wait between checks for the confirmation dialog. */
const CONFIRM_POLL_MS = 250;
/** Checks before giving up. 8 x 250ms = 2s. */
const CONFIRM_POLLS = 8;

/**
 * Does this output show the CLI's "switch model?" confirmation?
 *
 * 2.1.225 stopped treating `/model x` as a direct setter: on a cached
 * conversation it asks first, because switching re-reads the whole history on
 * the next message. Matched on the heading plus an affirmative row so ordinary
 * text mentioning a model can't trigger it.
 */
export function isModelSwitchConfirmation(output: string | undefined): boolean {
  if (!output) return false;
  const visible = output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  return /switch\s+model\?/i.test(visible) && /\byes,\s*switch\b/i.test(visible);
}

/** Build the `/model <arg>` line for a picker model id, or null if unresolvable. */
export function buildClaudeCliModelSwitchCommand(model: string | undefined): string | null {
  const cliArg = resolveClaudeCliModelArg(model);
  if (!cliArg) return null;
  return `/model ${cliArg}`;
}

/** Type the `/model` command into the session's PTY. */
export async function switchClaudeCliModel(
  input: SwitchClaudeCliModelInput,
  deps: SwitchClaudeCliModelDeps,
): Promise<SwitchClaudeCliModelResult> {
  const command = buildClaudeCliModelSwitchCommand(input.model);
  if (!command) return { switched: false };

  deps.writeToTerminal(input.sessionId, command);
  await deps.delay(MODEL_SWITCH_WRITE_GAP_MS);
  deps.writeToTerminal(input.sessionId, '\r');

  const cliArg = command.slice('/model '.length);
  if (!deps.readRecentOutput) return { switched: true, cliArg };

  // The dialog waits forever if nobody answers, and the session reads as busy
  // the whole time. Accept it on the user's behalf: they picked this model in
  // Nimbalyst's picker, so re-asking in a terminal they have to go find is a
  // question already answered. Enter takes the highlighted first row ("Yes").
  for (let poll = 0; poll < CONFIRM_POLLS; poll++) {
    await deps.delay(CONFIRM_POLL_MS);
    if (isModelSwitchConfirmation(deps.readRecentOutput(input.sessionId))) {
      deps.writeToTerminal(input.sessionId, '\r');
      return { switched: true, cliArg, confirmed: true };
    }
  }
  return { switched: true, cliArg };
}
