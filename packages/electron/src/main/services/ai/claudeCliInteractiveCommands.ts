/**
 * Interactive-picker detection for the genuine `claude` CLI (NIM-810).
 *
 * A `claude-code-cli` session runs the real TUI in a hidden PTY drawer. Some
 * slash commands open a native interactive picker (`/model`, `/config`, ...) that
 * the user must drive with the keyboard — but if the drawer is collapsed those
 * keystrokes have nowhere to go. These pure predicates let main detect those
 * cases (input-side from the submitted prompt; output-side from the PTY stream)
 * and ask the renderer to reveal + focus the drawer.
 *
 * Pure (no electron/runtime imports) so both predicates unit-test in isolation.
 */

/**
 * Curated set of slash commands that open a native TUI picker with NO Nimbalyst
 * equivalent. Output-only commands (`/clear`, `/compact`, `/cost`, `/context`,
 * `/help`, `/status`) are intentionally excluded — Nimbalyst already surfaces
 * their result in the transcript, so revealing the raw drawer for them is noise.
 *
 * Names are the bare command (no leading slash), lowercase.
 */
export const INTERACTIVE_CLI_SLASH_COMMANDS: ReadonlySet<string> = new Set([
  'model',
  'config',
  'login',
  'logout',
  'theme',
  'agents',
  'permissions',
  'mcp',
  'statusline',
  'vim',
  'terminal-setup',
]);

/** Leading slash command: `/model`, `/terminal-setup`, optionally with args after. */
const LEADING_SLASH_COMMAND_RE = /^\s*\/([a-z][a-z0-9-]*)\b/i;

/**
 * If `prompt` is a leading slash command in the interactive allowlist, returns the
 * matched command name (lowercase); otherwise `null`. Args after the command are
 * ignored, and a slash that is not at the start (e.g. "run /model later") does not
 * match — only the command the CLI readline will actually execute.
 */
export function detectInteractiveCliCommand(prompt: string | undefined): string | null {
  if (!prompt) return null;
  const match = LEADING_SLASH_COMMAND_RE.exec(prompt);
  if (!match) return null;
  const command = match[1].toLowerCase();
  return INTERACTIVE_CLI_SLASH_COMMANDS.has(command) ? command : null;
}

// Strip ANSI/VT escape sequences so the picker heuristic matches the visible glyphs.
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/** Ink `SelectInput` highlights the active row with this caret; the normal REPL prompt does not. */
const SELECTION_CARET = '❯'; // ❯

/**
 * Best-effort, version-fragile heuristic: does this raw PTY chunk look like a
 * native selection picker rendering? Used as a SECONDARY net behind input-side
 * detection — a model-initiated or directly-typed picker the allowlist can't see.
 *
 * Matches the Ink selection caret (`❯ `) that highlights the active row of a
 * picker. The glyph also appears in ordinary output (vitest, slash-autocomplete
 * dropdowns, fancy shell prompts), so false positives are routine, not rare.
 * Output-sourced reveals must therefore never pulse focus — they only expand the
 * drawer visually (NIM-828); a false negative is covered by
 * `detectInteractiveCliCommand`. The caller must debounce — pickers redraw on
 * every keypress.
 */
export function detectCliPickerInChunk(chunk: string | undefined): boolean {
  if (!chunk) return false;
  const visible = chunk.replace(ANSI_ESCAPE_RE, '');
  // Require the caret followed by a space + a printable char (a real menu row),
  // not a lone glyph, to keep the heuristic from firing on stray output.
  const caretIdx = visible.indexOf(`${SELECTION_CARET} `);
  if (caretIdx === -1) return false;
  const after = visible.charCodeAt(caretIdx + 2);
  return Number.isFinite(after) && after > 0x20;
}
