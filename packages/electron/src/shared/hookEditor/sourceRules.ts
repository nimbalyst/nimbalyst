/**
 * The rules that depend on where a hook lives, beside the per-event
 * compatibility table. The reducer reads both.
 *
 * - A settings file takes all six actions. "Run a script" keeps the command
 *   exactly as the user gives it. The hook runtime is not used (ADR 0001
 *   covers hook packs only).
 * - A hook pack draft refuses "Run a command": hook packs run Python
 *   scripts. "Run a script" calls the hook launcher by its full path, and on
 *   PreToolUse it is a guard hook (ADR 0001 guard form, timeout 30).
 * - A read-only source refuses every edit.
 */

import { eventRule } from './compatibility';
import {
  GUARD_TIMEOUT_SECONDS,
  PLUGIN_ROOT_TOKEN,
  SCRIPT_PATH_PATTERN,
  launcherCommand,
  scriptOfLauncherCommand,
} from './thenBlocks';
import {
  isJsonObject,
  type ActionKind,
  type HookSourceKind,
  type HookType,
  type JsonObject,
  type JsonValue,
  type ThenAnswer,
  type ThenBlock,
} from './types';

/** Which hook type each palette action writes. "Run an agent" writes type agent, which needs a prompt. */
export const ACTION_HOOK_TYPE: Readonly<Record<ActionKind, HookType>> = {
  runScript: 'command',
  runCommand: 'command',
  sendToWeb: 'http',
  askAi: 'prompt',
  runAgent: 'agent',
  callMcpTool: 'mcp_tool',
};

export const ACTION_NAMES: Readonly<Record<ActionKind, string>> = {
  runScript: 'Run a script',
  runCommand: 'Run a command',
  sendToWeb: 'Send to a web address',
  askAi: 'Ask the AI',
  runAgent: 'Run an agent',
  callMcpTool: 'Call an MCP tool',
};

export const THEN_NAMES: Readonly<Record<ThenAnswer, string>> = {
  permission: 'Then: allow, deny or ask',
  block: 'Then: block with a reason',
  addContext: 'Then: add context for Claude',
  stopClaude: 'Then: stop Claude',
  tellUser: 'Then: tell the user',
  watchFiles: 'Then: watch these files',
};

export const READ_ONLY_REASON = 'This hook is read-only. Copy it into one of your own files to change it.';
export const HOOK_PACK_COMMAND_REASON = 'Hook packs run Python scripts';
export const GUARD_LINE_REASON =
  'A guard hook stays on PreToolUse, and other hook pack scripts stay off it. Add a new block on the other event instead.';

export function isSettingsSource(source: HookSourceKind): boolean {
  return source === 'userSettings' || source === 'projectSettings' || source === 'localSettings';
}

export function unknownEventReason(event: string): string {
  return `${event} is not a Claude Code hook event.`;
}

export function doesNotFitReason(action: ActionKind, event: string): string {
  return `${ACTION_NAMES[action]} does not fit ${event}.`;
}

export function narrowNeverRunsReason(event: string): string {
  return `"Narrow to" never runs on ${event}, so this hook would never start.`;
}

const COMMON_FIELDS = ['timeout', 'statusMessage', 'if'];

/** The fields the hook editor sets for each action. Any other field on a hook stays as it is in the file. */
function fieldNames(source: HookSourceKind, action: ActionKind): { required: string[]; optional: string[] } {
  switch (action) {
    case 'runScript':
      return { required: [source === 'hookPackDraft' ? 'script' : 'command'], optional: COMMON_FIELDS };
    case 'runCommand':
      return { required: ['command'], optional: COMMON_FIELDS };
    case 'sendToWeb':
      return { required: ['url'], optional: [...COMMON_FIELDS, 'headers', 'allowedEnvVars'] };
    case 'askAi':
      return { required: ['prompt'], optional: [...COMMON_FIELDS, 'continueOnBlock'] };
    case 'runAgent':
      return { required: ['prompt'], optional: COMMON_FIELDS };
    case 'callMcpTool':
      return { required: ['server', 'tool'], optional: [...COMMON_FIELDS, 'input'] };
  }
}

function nonEmptyText(value: JsonValue): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

const FIELD_CHECKS: Readonly<Record<string, (value: JsonValue) => boolean>> = {
  command: nonEmptyText,
  script: (value) => typeof value === 'string' && SCRIPT_PATH_PATTERN.test(value),
  url: (value) => typeof value === 'string' && /^https?:\/\/\S+$/.test(value),
  headers: (value) => isJsonObject(value) && Object.values(value).every((item) => typeof item === 'string'),
  allowedEnvVars: (value) => Array.isArray(value) && value.every((item) => typeof item === 'string'),
  prompt: nonEmptyText,
  continueOnBlock: (value) => typeof value === 'boolean',
  server: nonEmptyText,
  tool: nonEmptyText,
  input: isJsonObject,
  timeout: (value) => typeof value === 'number' && Number.isInteger(value) && value > 0,
  statusMessage: (value) => typeof value === 'string',
  if: nonEmptyText,
};

function requiredReason(action: ActionKind, name: string): string {
  return action === 'runAgent' && name === 'prompt'
    ? 'Run an agent needs a prompt. Claude Code requires one on agent hooks.'
    : `${ACTION_NAMES[action]} needs "${name}".`;
}

/** Checks one field. A value of undefined means "remove the field". */
export function checkField(
  source: HookSourceKind,
  event: string,
  action: ActionKind,
  name: string,
  value: JsonValue | undefined,
): string | null {
  const names = fieldNames(source, action);
  if (![...names.required, ...names.optional].includes(name)) {
    return `The hook editor does not set "${name}" on ${ACTION_NAMES[action]}.`;
  }
  const guard = source === 'hookPackDraft' && event === 'PreToolUse' && action === 'runScript';
  // A guard hook keeps its 30 s limit, so removing the field is refused too.
  if (name === 'timeout' && guard && value !== GUARD_TIMEOUT_SECONDS) {
    return 'A guard hook always gives up after 30 s, so the hook launcher can stop it first.';
  }
  if (value === undefined) return names.required.includes(name) ? requiredReason(action, name) : null;
  if (!FIELD_CHECKS[name](value)) return `Claude Code does not accept this value for "${name}".`;
  if (name === 'if' && !eventRule(event)?.ifRuns) return narrowNeverRunsReason(event);
  return null;
}

/** Checks a new action block on an event. */
export function checkAction(source: HookSourceKind, event: string, action: ActionKind, fields: JsonObject): string | null {
  if (source === 'readOnly') return READ_ONLY_REASON;
  const rule = eventRule(event);
  if (!rule) return unknownEventReason(event);
  if (source === 'hookPackDraft' && action === 'runCommand') return HOOK_PACK_COMMAND_REASON;
  if (!rule.hookTypes.includes(ACTION_HOOK_TYPE[action])) return doesNotFitReason(action, event);
  for (const name of fieldNames(source, action).required) {
    if (!(name in fields)) return requiredReason(action, name);
  }
  for (const [name, value] of Object.entries(fields)) {
    const problem = checkField(source, event, action, name, value);
    if (problem) return problem;
  }
  return null;
}

/** Checks a Then block on an event. */
export function checkThen(source: HookSourceKind, event: string, then: ThenBlock): string | null {
  if (source === 'readOnly') return READ_ONLY_REASON;
  const rule = eventRule(event);
  if (!rule) return unknownEventReason(event);
  if (!rule.thenAnswers.includes(then.answer)) return `Claude Code ignores "${THEN_NAMES[then.answer]}" on ${event}.`;
  if (then.answer === 'watchFiles') {
    return then.paths.length > 0 && then.paths.every((item) => item.startsWith('/'))
      ? null
      : 'Watch these files needs one or more full paths that start with /.';
  }
  return then.message.trim() === '' ? 'A Then block needs a message.' : null;
}

/** An event with no matcher takes actions directly. A matcher there would be ignored silently. */
export function checkMatcher(event: string, matcher: string | null): string | null {
  const rule = eventRule(event);
  if (!rule) return unknownEventReason(event);
  return rule.matcher.kind === 'none' && matcher !== null
    ? `${event} takes no "Only when" block. Its actions run every time.`
    : null;
}

/** The hook entry JSON for a new action block. Call checkAction first. */
export function buildHookEntry(
  source: HookSourceKind,
  event: string,
  action: ActionKind,
  fields: JsonObject,
  launcherPath: string | null,
): JsonObject {
  if (source !== 'hookPackDraft' || action !== 'runScript') return { type: ACTION_HOOK_TYPE[action], ...fields };
  const { script, ...rest } = fields;
  if (launcherPath === null || typeof script !== 'string') {
    throw new Error('A hook pack "Run a script" needs the hook launcher path and a script path.');
  }
  const guard = event === 'PreToolUse';
  const entry: JsonObject = { type: 'command', command: launcherCommand(launcherPath, script, guard), ...rest };
  if (guard) entry.timeout = GUARD_TIMEOUT_SECONDS;
  return entry;
}

const INTERPRETERS = new Set(['python3', 'python', 'node', 'bash', 'sh', 'zsh', 'bun', 'deno', 'ruby', 'perl', 'uv', 'run', '--script']);
const SCRIPT_FILE = /\.(py|sh|js|mjs|cjs|ts|rb|pl)$/;
const SCRIPT_START = /^(\/|~\/|\.\/|\$CLAUDE_PROJECT_DIR\/|\$\{CLAUDE_PROJECT_DIR\}\/)/;

/**
 * The script file that a settings file command runs, as written (with ~ or
 * $CLAUDE_PROJECT_DIR left in), or null when the command runs no script file.
 * Double quotes are dropped. A path with spaces is not found, so that hook
 * shows as "Run a command" and the script check skips it.
 */
export function settingsScriptOf(command: string): string | null {
  const first = command.trim().split(/\s+/).find((word) => !INTERPRETERS.has(word));
  if (first === undefined) return null;
  const path = first.split('"').join('');
  return SCRIPT_START.test(path) && SCRIPT_FILE.test(path) ? path : null;
}

/** The draft path of the script that a hook pack entry runs through the hook launcher, or null. */
export function hookPackScriptOf(entry: JsonObject, launcherPath: string | null): string | null {
  if (launcherPath === null || typeof entry.command !== 'string') return null;
  const firstArg = Array.isArray(entry.args) ? entry.args[0] : undefined;
  if (entry.command === launcherPath && typeof firstArg === 'string') {
    // Exec form, as the hook builder writes non-guard hooks.
    const prefix = `${PLUGIN_ROOT_TOKEN}/`;
    const path = firstArg.startsWith(prefix) ? firstArg.slice(prefix.length) : '';
    return SCRIPT_PATH_PATTERN.test(path) ? path : null;
  }
  return scriptOfLauncherCommand(launcherPath, entry.command);
}

/** Which palette action an existing hook entry shows as. */
export function actionOfEntry(source: HookSourceKind, entry: JsonObject, launcherPath: string | null): ActionKind {
  switch (entry.type) {
    case 'http':
      return 'sendToWeb';
    case 'prompt':
      return 'askAi';
    case 'agent':
      return 'runAgent';
    case 'mcp_tool':
      return 'callMcpTool';
    default: {
      const script =
        source === 'hookPackDraft'
          ? hookPackScriptOf(entry, launcherPath)
          : settingsScriptOf(typeof entry.command === 'string' ? entry.command : '');
      return script === null ? 'runCommand' : 'runScript';
    }
  }
}
