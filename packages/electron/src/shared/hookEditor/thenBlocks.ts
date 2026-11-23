/**
 * Turns a Then block into the code that answers Claude Code, and reads that
 * code back into a Then block.
 *
 * - In a settings file, a Then block is one inline command that prints the
 *   hook output JSON. If it fails, the tool call goes ahead (it fails open).
 * - In a hook pack, a Then block is a small generated Python script in the
 *   draft, run through the hook launcher. On PreToolUse the call uses the
 *   ADR 0001 guard form, so a failure blocks the tool call (a guard hook).
 *
 * The user's message only ever passes through JSON.stringify and shellQuote,
 * so quotes and shell characters cannot break the command or the script.
 * Reading back works by making the code again from what was read and
 * comparing it with the text. Anything changed by hand is not a Then block.
 */

import { shellQuote } from './shellQuote';
import { isJsonObject, type JsonObject, type ThenBlock } from './types';

// Claude Code puts the plugin folder in place of this token.
// eslint-disable-next-line no-template-curly-in-string
export const PLUGIN_ROOT_TOKEN = '${CLAUDE_PLUGIN_ROOT}';

/** ADR 0001: a guard hook has timeout 30, and the hook launcher stops the script at 28. */
export const GUARD_TIMEOUT_SECONDS = 30;
export const GUARD_LAUNCHER_LIMIT_SECONDS = 28;

/** A hook pack script path, relative to the draft root. No quote, no space, no folder climb. */
export const SCRIPT_PATH_PATTERN = /^hooks\/[A-Za-z0-9_][A-Za-z0-9_.-]*\.py$/;

export const THEN_SCRIPT_HEADER = '# Made by Nimbalyst from a Then block.';
const THEN_SCRIPT_NOTE =
  '# Nimbalyst writes this file again each time the block changes. Use "Turn into a script" to edit it yourself.';
const THEN_LINE_PREFIX = '# then: ';
const SETTINGS_PREFIX = "printf '%s' ";

/** The hook output JSON that a Then block answers with. */
export function thenOutput(event: string, then: ThenBlock): JsonObject {
  switch (then.answer) {
    case 'permission':
      return {
        hookSpecificOutput: {
          hookEventName: event,
          permissionDecision: then.decision,
          permissionDecisionReason: then.message,
        },
      };
    case 'block':
      return { decision: 'block', reason: then.message };
    case 'addContext':
      return { hookSpecificOutput: { hookEventName: event, additionalContext: then.message } };
    case 'stopClaude':
      return { continue: false, stopReason: then.message };
    case 'tellUser':
      return { systemMessage: then.message };
    case 'watchFiles':
      return { hookSpecificOutput: { hookEventName: event, watchPaths: [...then.paths] } };
  }
}

/** A Then block from untrusted JSON, or null when the shape is wrong. */
export function asThenBlock(value: unknown): ThenBlock | null {
  if (!isJsonObject(value)) return null;
  const { answer } = value;
  if (answer === 'watchFiles') {
    const { paths } = value;
    return Array.isArray(paths) && paths.every((item) => typeof item === 'string')
      ? { answer, paths: paths as string[] }
      : null;
  }
  if (typeof value.message !== 'string') return null;
  if (answer === 'permission') {
    const { decision } = value;
    return decision === 'allow' || decision === 'deny' || decision === 'ask'
      ? { answer, decision, message: value.message }
      : null;
  }
  if (answer === 'block' || answer === 'addContext' || answer === 'stopClaude' || answer === 'tellUser') {
    return { answer, message: value.message };
  }
  return null;
}

/** The Then block that writes exactly this output on this event, or null. */
function thenFromOutput(event: string, output: unknown): ThenBlock | null {
  if (!isJsonObject(output)) return null;
  const specific = isJsonObject(output.hookSpecificOutput) ? output.hookSpecificOutput : null;
  let then: ThenBlock | null = null;
  if (specific && typeof specific.permissionDecisionReason === 'string') {
    then = asThenBlock({ answer: 'permission', decision: specific.permissionDecision, message: specific.permissionDecisionReason });
  } else if (specific && typeof specific.additionalContext === 'string') {
    then = { answer: 'addContext', message: specific.additionalContext };
  } else if (specific && specific.watchPaths !== undefined) {
    then = asThenBlock({ answer: 'watchFiles', paths: specific.watchPaths });
  } else if (output.decision === 'block' && typeof output.reason === 'string') {
    then = { answer: 'block', message: output.reason };
  } else if (output.continue === false && typeof output.stopReason === 'string') {
    then = { answer: 'stopClaude', message: output.stopReason };
  } else if (typeof output.systemMessage === 'string') {
    then = { answer: 'tellUser', message: output.systemMessage };
  }
  if (then === null) return null;
  return JSON.stringify(thenOutput(event, then)) === JSON.stringify(output) ? then : null;
}

/** Settings file form: one command that prints the answer and nothing else. */
export function settingsThenCommand(event: string, then: ThenBlock): string {
  return SETTINGS_PREFIX + shellQuote(JSON.stringify(thenOutput(event, then)));
}

export function settingsThenEntry(event: string, then: ThenBlock): JsonObject {
  return { type: 'command', command: settingsThenCommand(event, then) };
}

/** The Then block behind a settings file command, or null for any other command. */
export function readSettingsThen(event: string, command: string): ThenBlock | null {
  if (!command.startsWith(SETTINGS_PREFIX)) return null;
  const quoted = command.slice(SETTINGS_PREFIX.length);
  if (quoted.length < 2 || !quoted.startsWith("'") || !quoted.endsWith("'")) return null;
  const text = quoted.slice(1, -1).split("'\\''").join("'");
  let output: unknown;
  try {
    output = JSON.parse(text);
  } catch {
    return null;
  }
  const then = thenFromOutput(event, output);
  return then !== null && settingsThenCommand(event, then) === command ? then : null;
}

/**
 * Hook pack form: the generated Python script. The third line keeps the block
 * itself, so the hook editor can show the block again. The last line prints
 * the answer as a Python string literal: JSON string escapes are valid
 * Python string escapes.
 */
export function thenScriptText(event: string, then: ThenBlock): string {
  return [
    THEN_SCRIPT_HEADER,
    THEN_SCRIPT_NOTE,
    THEN_LINE_PREFIX + JSON.stringify({ event, then }),
    'import sys',
    '',
    'sys.stdin.read()',
    // UTF-8 bytes, so a message with non-ASCII text prints under any locale.
    `sys.stdout.buffer.write(${JSON.stringify(JSON.stringify(thenOutput(event, then)))}.encode('utf-8'))`,
    '',
  ].join('\n');
}

/** The Then block behind a generated script, or null when the script is not one, or was changed by hand. */
export function readThenScript(text: string): { event: string; then: ThenBlock } | null {
  const lines = text.split('\n');
  if (lines[0] !== THEN_SCRIPT_HEADER || !lines[2]?.startsWith(THEN_LINE_PREFIX)) return null;
  let saved: unknown;
  try {
    saved = JSON.parse(lines[2].slice(THEN_LINE_PREFIX.length));
  } catch {
    return null;
  }
  if (!isJsonObject(saved) || typeof saved.event !== 'string') return null;
  const then = asThenBlock(saved.then);
  return then !== null && thenScriptText(saved.event, then) === text ? { event: saved.event, then } : null;
}

/** "Turn into a script": drop the three header lines. The script then belongs to the user. */
export function stripThenHeader(text: string): string {
  return text.split('\n').slice(3).join('\n');
}

/** The first free generated script name for an event, such as hooks/then_pre_tool_use_1.py. */
export function thenScriptPath(event: string, taken: ReadonlySet<string>): string {
  const stem = event.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  for (let n = 1; ; n += 1) {
    const candidate = `hooks/then_${stem}_${n}.py`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * The shell command that runs a hook pack script through the hook launcher.
 * The plugin folder token stays in double quotes, so the shell or Claude Code
 * can put the folder in. The rest of the path goes in single quotes.
 */
export function launcherCommand(launcherPath: string, scriptPath: string, guard: boolean): string {
  const script = `"${PLUGIN_ROOT_TOKEN}"${shellQuote(`/${scriptPath}`)}`;
  return guard
    ? `${shellQuote(launcherPath)} --guard ${GUARD_LAUNCHER_LIMIT_SECONDS} ${script} || exit 2`
    : `${shellQuote(launcherPath)} ${script}`;
}

/** The script path inside a hook launcher command, or null for any other command. */
export function scriptOfLauncherCommand(launcherPath: string, command: string): string | null {
  const match = /"\$\{CLAUDE_PLUGIN_ROOT\}"'\/(hooks\/[A-Za-z0-9_][A-Za-z0-9_.-]*\.py)'/.exec(command);
  if (!match) return null;
  const scriptPath = match[1];
  return command === launcherCommand(launcherPath, scriptPath, true) ||
    command === launcherCommand(launcherPath, scriptPath, false)
    ? scriptPath
    : null;
}

/** A hook pack Then block: the hook entry plus the script it runs. */
export function hookPackThenEntry(
  event: string,
  then: ThenBlock,
  launcherPath: string,
  scriptPath: string,
): { entry: JsonObject; script: { path: string; text: string } } {
  const guard = event === 'PreToolUse';
  const entry: JsonObject = { type: 'command', command: launcherCommand(launcherPath, scriptPath, guard) };
  if (guard) entry.timeout = GUARD_TIMEOUT_SECONDS;
  return { entry, script: { path: scriptPath, text: thenScriptText(event, then) } };
}
