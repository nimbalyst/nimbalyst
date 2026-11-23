/**
 * The plain words and small rules the hook editor screen shows: file tab names,
 * what each event means, which blocks fit where, and the block colours. Nothing
 * here reads or writes a file.
 */

import type { SettingsSource } from '../../../main/services/hookEditor/hookFiles';
import { EVENT_RULES, REQUIRED_FIELDS, eventRule, type HookEventName } from '../../../shared/hookEditor/compatibility';
import type { EventBlock, HookBlock } from '../../../shared/hookEditor/hookDocument';
import type { NewBlock } from '../../../shared/hookEditor/hookEdits';
import { ACTION_HOOK_TYPE, ACTION_NAMES, THEN_NAMES, checkAction, checkThen } from '../../../shared/hookEditor/sourceRules';
import {
  isJsonObject,
  type ActionKind,
  type JsonObject,
  type JsonValue,
  type ThenAnswer,
  type ThenBlock,
} from '../../../shared/hookEditor/types';

export const SETTINGS_TABS: ReadonlyArray<{ source: SettingsSource; name: string; inGit: boolean }> = [
  { source: 'userSettings', name: 'All my projects', inGit: false },
  { source: 'projectSettings', name: 'This project, shared', inGit: true },
  { source: 'localSettings', name: 'This project, just me', inGit: false },
];

export const EVENT_TEXT: Readonly<Record<HookEventName, string>> = {
  PreToolUse: 'Before a tool runs',
  PostToolUse: 'After a tool succeeds',
  PostToolUseFailure: 'After a tool fails',
  PostToolBatch: 'After a batch of tool calls',
  Notification: 'When Claude Code sends a notification',
  UserPromptSubmit: 'When you send a prompt',
  UserPromptExpansion: 'When a slash command turns into a prompt',
  SessionStart: 'When a session starts or resumes',
  SessionEnd: 'When a session ends',
  Stop: 'When Claude finishes its answer',
  StopFailure: 'When a turn ends with an error',
  SubagentStart: 'When a subagent starts',
  SubagentStop: 'When a subagent finishes',
  PreCompact: 'Before the conversation is compacted',
  PostCompact: 'After the conversation is compacted',
  PreModelSwitch: 'Before the model changes',
  PostModelSwitch: 'After the model changes',
  PermissionRequest: 'When Claude Code asks for permission',
  PermissionDenied: 'When auto mode denies a tool call',
  Setup: 'When Claude Code starts with an init or maintenance flag',
  TeammateIdle: 'When a teammate has nothing to do',
  TaskCreated: 'When a task is made',
  TaskCompleted: 'When a task is done',
  Elicitation: 'When an MCP server asks you for input',
  ElicitationResult: 'After you answer an MCP server',
  ConfigChange: 'When a settings file changes',
  WorktreeCreate: 'Instead of Claude Code making a worktree',
  WorktreeRemove: 'When a worktree a hook made is removed',
  InstructionsLoaded: 'When instruction files load',
  CwdChanged: 'When the working folder changes',
  FileChanged: 'When a watched file changes',
  DirectoryAdded: 'When a folder is added to the session',
  MessageDisplay: 'When a message shows',
};

/** Facts from the event test that change what a user should expect. */
export const EVENT_NOTES: Readonly<Partial<Record<HookEventName, string>>> = {
  PermissionRequest:
    'Nimbalyst answers permissions in its own code. A hook here can decide before Nimbalyst asks you. Only a JSON decision counts; exit code 2 does not block.',
  Notification: 'In Nimbalyst this may stay silent for a permission prompt. Only three notification types fire in SDK sessions.',
  PermissionDenied: 'Did not fire in the event test when the app denied a tool.',
};

/** One tag for the event block: what the event can do with a hook's answer. */
export function eventTag(event: string): string {
  const rule = eventRule(event);
  if (rule === null) return 'Unknown event';
  // On these two events a block keeps Claude working. It does not stop anything.
  if (event === 'Stop' || event === 'SubagentStop') return 'Can keep Claude working';
  if (rule.exit2Blocks) return 'Can stop the action';
  return rule.thenAnswers.length > 0 ? 'Can answer back' : 'Only watches';
}

/** The events in the order the palette lists them. The canvas draws events in this same order. */
export const EVENT_ORDER = Object.keys(EVENT_RULES) as readonly HookEventName[];

/**
 * Puts event blocks in the palette order. An event the palette does not know
 * (a hand-edited file can hold one) goes last, in the order it came in. This is
 * for drawing only. The file keeps its own order, and block ids do not change.
 */
export function inEventOrder<T extends { event: string }>(blocks: readonly T[]): T[] {
  const place = (event: string) => {
    const at = (EVENT_ORDER as readonly string[]).indexOf(event);
    return at === -1 ? EVENT_ORDER.length : at;
  };
  // A stable sort, so unknown events keep their file order.
  return [...blocks].sort((a, b) => place(a.event) - place(b.event));
}

export const TOOL_CHIPS: readonly string[] = [
  'Bash', 'Read', 'Edit', 'Write', 'MultiEdit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'NotebookEdit',
];

/** The chips for an event's "Only when" block. Null: the event takes no matcher. Empty: the matcher is typed. */
export function chipChoices(event: string): readonly string[] | null {
  const rule = eventRule(event);
  if (rule === null || rule.matcher.kind === 'none') return null;
  if (rule.matcher.kind === 'toolName') return TOOL_CHIPS;
  if (rule.matcher.kind === 'values') return rule.matcher.values;
  return [];
}

/**
 * The example "Only when" value for the starter hook of a picked event. A tool
 * event gets the first tool (Bash). An event with a fixed list gets the first
 * value of the list. An event with no matcher, or one the user types, gets none.
 */
export function starterMatcher(event: string): string | null {
  return chipChoices(event)?.[0] ?? null;
}

/**
 * The chips a matcher stands for. Null when any part is not a chip, so the
 * screen shows the matcher as typed text and never rewrites it.
 */
export function chipsOf(matcher: string | null, choices: readonly string[]): string[] | null {
  if (matcher === null) return [];
  const parts = matcher.split('|');
  return parts.every((part) => choices.includes(part)) ? parts : null;
}

export function matcherOfChips(chips: readonly string[]): string | null {
  return chips.length === 0 ? null : chips.join('|');
}

export type PaletteItem = { kind: 'action'; action: ActionKind } | { kind: 'then'; answer: ThenAnswer };

export const PALETTE_ITEMS: readonly PaletteItem[] = [
  ...(Object.keys(ACTION_NAMES) as ActionKind[]).map((action): PaletteItem => ({ kind: 'action', action })),
  ...(Object.keys(THEN_NAMES) as ThenAnswer[]).map((answer): PaletteItem => ({ kind: 'then', answer })),
];

export function itemName(item: PaletteItem): string {
  return item.kind === 'action' ? ACTION_NAMES[item.action] : THEN_NAMES[item.answer];
}

export const FIELD_LABELS: Readonly<Record<string, string>> = {
  command: 'Command',
  url: 'Web address',
  prompt: 'What to ask',
  server: 'MCP server',
  tool: 'MCP tool',
  message: 'Message',
  decision: 'Allow, deny or ask',
  paths: 'Files to watch, one full path on each line',
};

/**
 * The project's button looks, from styles/components.css. Ghost has no disabled look of its own, so it gets one here.
 * Add `small` for buttons inside a row or a popover. The `!` makes the small size win over the button's own padding.
 */
export const BUTTON = {
  primary: 'nim-btn-primary',
  secondary: 'nim-btn-secondary',
  danger: 'nim-btn-danger',
  ghost: 'nim-btn-ghost disabled:cursor-not-allowed disabled:opacity-50',
  small: '!px-2 !py-1 text-xs',
} as const;

/** The words on the "Paused hooks" tray button. A hook that is already in the file is only cleared from the tray. */
export const RESUME_BUTTON_TEXT = 'Turn back on';
export const REMOVE_FROM_TRAY_TEXT = 'Remove from tray';
export const ALREADY_IN_FILE_TEXT = 'Already in the file';

/** The three answers a "Then: allow, deny or ask" block can give, with the words the screen shows for each. */
export const DECISION_CHOICES: ReadonlyArray<{ value: 'allow' | 'deny' | 'ask'; label: string }> = [
  { value: 'allow', label: 'Allow' },
  { value: 'deny', label: 'Deny' },
  { value: 'ask', label: 'Ask me' },
];

export function requiredFields(item: PaletteItem): readonly string[] {
  if (item.kind === 'action') return REQUIRED_FIELDS[ACTION_HOOK_TYPE[item.action]];
  if (item.answer === 'permission') return ['decision', 'message'];
  return item.answer === 'watchFiles' ? ['paths'] : ['message'];
}

export function newBlockOf(item: PaletteItem, values: Readonly<Record<string, string>>): NewBlock {
  if (item.kind === 'action') return { kind: 'action', action: item.action, fields: { ...values } };
  let then: ThenBlock;
  if (item.answer === 'permission') {
    then = { answer: 'permission', decision: values.decision as 'allow' | 'deny' | 'ask', message: values.message ?? '' };
  } else if (item.answer === 'watchFiles') {
    then = { answer: 'watchFiles', paths: (values.paths ?? '').split('\n').map((path) => path.trim()).filter(Boolean) };
  } else {
    then = { answer: item.answer, message: values.message ?? '' };
  }
  return { kind: 'then', then };
}

/** Why a palette block cannot go on this event in this file, or null when it fits. Uses part 1's own reasons. */
export function paletteFitReason(source: SettingsSource, event: string, item: PaletteItem): string | null {
  // Each sample value must pass its own rule, or the block greys out on every event.
  // "Send to a web address" refuses a web address that is not https or http.
  // "Watch these files" refuses a path that does not start with /.
  const samples: Readonly<Record<string, string>> = { url: 'https://example.com', paths: '/x', decision: 'ask' };
  const sample = Object.fromEntries(requiredFields(item).map((name) => [name, samples[name] ?? 'x']));
  const block = newBlockOf(item, sample);
  return block.kind === 'action' ? checkAction(source, event, block.action, block.fields) : checkThen(source, event, block.then);
}

export function blockName(block: HookBlock): string {
  if (block.kind === 'action') return ACTION_NAMES[block.action];
  return block.kind === 'then' ? THEN_NAMES[block.then.answer] : 'Kept as it is';
}

/** The one line a folded event block shows. */
export function foldedSummary(event: EventBlock): string {
  const hooks = event.groups.flatMap((group) => group.hooks);
  return hooks.length === 1 ? `1 action, ${blockName(hooks[0])}` : `${hooks.length} actions`;
}

/**
 * What happens when a hook runs past its time limit. The PreToolUse line was seen
 * live. The PreModelSwitch line comes from the Claude Code docs.
 */
export function giveUpText(event: string): string {
  if (event === 'PreToolUse') return 'If it gives up, the tool call goes ahead.';
  if (event === 'PreModelSwitch') return 'If it gives up, the model does not change.';
  return 'If it gives up, Claude Code carries on as if the hook was not there.';
}

/** An object as "key: value" lines, for headers and MCP tool input. */
export function linesOfObject(value: JsonValue | undefined): string {
  if (!isJsonObject(value)) return '';
  return Object.entries(value)
    .map(([name, item]) => `${name}: ${typeof item === 'string' ? item : JSON.stringify(item)}`)
    .join('\n');
}

/** "key: value" lines as an object. The first colon splits a line; a line with no colon is skipped. */
export function objectOfLines(text: string): JsonObject {
  const result: JsonObject = {};
  for (const line of text.split('\n')) {
    const at = line.indexOf(':');
    if (at <= 0) continue;
    result[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return result;
}

export type BlockKind = 'when' | 'onlyWhen' | 'action' | 'then' | 'opaque';

export const BLOCK_COLOURS: Readonly<Record<BlockKind, string>> = {
  when: 'var(--nim-purple)',
  onlyWhen: 'var(--nim-info)',
  action: 'var(--nim-success)',
  then: 'color-mix(in srgb, var(--nim-error) 55%, var(--nim-purple))',
  opaque: 'var(--nim-text-faint)',
};
