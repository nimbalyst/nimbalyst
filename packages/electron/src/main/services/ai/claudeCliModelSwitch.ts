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
}

export type SwitchClaudeCliModelResult =
  | { switched: true; cliArg: string }
  | { switched: false };

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

  return { switched: true, cliArg: command.slice('/model '.length) };
}
