/**
 * Opens a settings file or a hook pack draft and reads its hooks as blocks.
 *
 * The document keeps only the "hooks" value. Every other key stays in the
 * file text, and the writer never touches it. A hook the editor cannot read
 * becomes an opaque block: it shows as read-only and stays exactly as it is.
 */

import { REQUIRED_FIELDS, eventRule } from './compatibility';
import { actionOfEntry, hookPackScriptOf, settingsScriptOf, unknownEventReason } from './sourceRules';
import { readSettingsThen, readThenScript } from './thenBlocks';
import {
  isHookType,
  isJsonObject,
  type ActionKind,
  type HookSourceKind,
  type HookType,
  type JsonObject,
  type JsonValue,
  type ThenBlock,
} from './types';

export const NOT_PLAIN_JSON_REASON =
  'This file is not plain JSON. It may have comments, trailing commas or a typo. Claude Code reads settings files as strict JSON, so the hook editor will not change this file.';
export const NOT_AN_OBJECT_REASON = 'This file does not hold one JSON object, so the hook editor will not change it.';
export const NO_LAUNCHER_REASON = 'A hook pack needs the hook launcher path, and none was given.';
export const HOOKS_NOT_OBJECT_REASON =
  'The "hooks" value is not an object. Claude Code skips it, and the hook editor will not change it.';
const UNREADABLE_GROUP_REASON = 'This group is not in the shape Claude Code reads. The hook editor keeps it as it is.';
export const UNREADABLE_EVENT_REASON = 'This event does not hold a list of groups. The hook editor keeps it as it is.';

/** A hook the user took out of the file for now. Part 2 stores the list beside the file. */
export interface PausedHook {
  event: string;
  matcher: string | null;
  entry: JsonValue;
}

export interface OpenOptions {
  source: HookSourceKind;
  /** The full path of the hook launcher. A hook pack draft needs it. */
  launcherPath?: string;
  /** Every .py file under hooks/ in the draft, path to text. New script names never reuse one of these. */
  scriptTexts?: Readonly<Record<string, string>>;
  /** The paused hooks for this file, as Part 2 stores them. */
  paused?: readonly PausedHook[];
}

export interface HookDocument {
  source: HookSourceKind;
  launcherPath: string | null;
  /** The "hooks" value, or undefined when the file has none. */
  hooks: JsonValue | undefined;
  /** Set when "hooks" is not an object. Every edit is then refused. */
  hooksProblem: string | null;
  /** Hook pack script texts: the ones on disk plus the ones the editor made or changed. */
  scripts: Readonly<Record<string, string>>;
  paused: readonly PausedHook[];
}

export type OpenResult = { ok: true; document: HookDocument } | { ok: false; reason: string };

export function openHookDocument(text: string, options: OpenOptions): OpenResult {
  const launcherPath = options.launcherPath ?? null;
  if (options.source === 'hookPackDraft' && launcherPath === null) return { ok: false, reason: NO_LAUNCHER_REASON };
  let root: unknown;
  try {
    // An empty or missing file is an empty settings file.
    root = text.trim() === '' ? {} : JSON.parse(text);
  } catch {
    return { ok: false, reason: NOT_PLAIN_JSON_REASON };
  }
  if (!isJsonObject(root)) return { ok: false, reason: NOT_AN_OBJECT_REASON };
  const { hooks } = root;
  return {
    ok: true,
    document: {
      source: options.source,
      launcherPath,
      hooks,
      hooksProblem: hooks === undefined || isJsonObject(hooks) ? null : HOOKS_NOT_OBJECT_REASON,
      scripts: { ...options.scriptTexts },
      paused: [...(options.paused ?? [])],
    },
  };
}

export interface HookKey {
  event: string;
  groupIndex: number;
  matcher: string | null;
  hookIndex: number;
}

export type HookBlock =
  | { kind: 'action'; key: HookKey; id: string; action: ActionKind; entry: JsonObject; extraFields: string[] }
  | { kind: 'then'; key: HookKey; id: string; then: ThenBlock; entry: JsonObject; scriptPath: string | null }
  | { kind: 'opaque'; key: HookKey; id: string; raw: JsonValue; reason: string };

export interface GroupBlock {
  id: string;
  event: string;
  groupIndex: number;
  matcher: string | null;
  readOnlyReason: string | null;
  hooks: HookBlock[];
}

export interface EventBlock {
  id: string;
  event: string;
  readOnlyReason: string | null;
  groups: GroupBlock[];
}

export function hookId(key: HookKey): string {
  return `${key.event}/${key.groupIndex}/${key.hookIndex}`;
}

export function groupId(event: string, groupIndex: number): string {
  return `${event}/${groupIndex}`;
}

/** The fields the hook editor shows for each hook type. Any other field shows as "kept as it is". */
const EDITABLE_FIELDS: Readonly<Record<HookType, readonly string[]>> = {
  command: ['type', 'command', 'timeout', 'statusMessage', 'if'],
  http: ['type', 'url', 'headers', 'allowedEnvVars', 'timeout', 'statusMessage', 'if'],
  prompt: ['type', 'prompt', 'continueOnBlock', 'timeout', 'statusMessage', 'if'],
  agent: ['type', 'prompt', 'timeout', 'statusMessage', 'if'],
  mcp_tool: ['type', 'server', 'tool', 'input', 'timeout', 'statusMessage', 'if'],
};

/** A group's matcher: the text, null when there is none, or undefined when the value is not text. */
export function groupMatcher(group: JsonObject): string | null | undefined {
  if (group.matcher === undefined) return null;
  return typeof group.matcher === 'string' ? group.matcher : undefined;
}

/** The group object at a position, or undefined when it is missing or not in a shape Claude Code reads. */
export function groupAt(doc: HookDocument, event: string, groupIndex: number): JsonObject | undefined {
  if (!isJsonObject(doc.hooks)) return undefined;
  const groups = doc.hooks[event];
  const group = Array.isArray(groups) ? groups[groupIndex] : undefined;
  return isJsonObject(group) && Array.isArray(group.hooks) && groupMatcher(group) !== undefined ? group : undefined;
}

export function findHook(doc: HookDocument, key: HookKey): JsonValue | undefined {
  const group = groupAt(doc, key.event, key.groupIndex);
  if (!group || groupMatcher(group) !== key.matcher) return undefined;
  return (group.hooks as JsonValue[])[key.hookIndex];
}

/** The Then block behind a hook entry, or null when the entry is not one the editor made. */
function readThen(doc: HookDocument, event: string, entry: JsonObject): { then: ThenBlock; scriptPath: string | null } | null {
  if (entry.type !== 'command' || typeof entry.command !== 'string') return null;
  if (doc.source !== 'hookPackDraft') {
    const then = readSettingsThen(event, entry.command);
    return then === null ? null : { then, scriptPath: null };
  }
  const scriptPath = hookPackScriptOf(entry, doc.launcherPath);
  const text = scriptPath === null ? undefined : doc.scripts[scriptPath];
  const saved = text === undefined ? null : readThenScript(text);
  // A Then script copied by hand onto another event is a plain script, not a Then block.
  return saved !== null && saved.event === event ? { then: saved.then, scriptPath } : null;
}

export function readHook(doc: HookDocument, key: HookKey, entry: JsonValue): HookBlock {
  const id = hookId(key);
  const opaque = (reason: string): HookBlock => ({ kind: 'opaque', key, id, raw: entry, reason });
  const rule = eventRule(key.event);
  if (rule === null) return opaque(unknownEventReason(key.event));
  if (!isJsonObject(entry)) return opaque('This hook is not a JSON object. The hook editor keeps it as it is.');
  const { type } = entry;
  if (!isHookType(type)) return opaque('The hook editor does not know this hook type. It keeps the hook as it is.');
  if (REQUIRED_FIELDS[type].some((name) => typeof entry[name] !== 'string' || entry[name] === '')) {
    return opaque(`This ${type} hook is missing a field Claude Code needs. The hook editor keeps it as it is.`);
  }
  if (!rule.hookTypes.includes(type)) return opaque(`Claude Code does not run ${type} hooks on ${key.event}.`);
  const then = readThen(doc, key.event, entry);
  if (then !== null) return { kind: 'then', key, id, then: then.then, entry, scriptPath: then.scriptPath };
  return {
    kind: 'action',
    key,
    id,
    action: actionOfEntry(doc.source, entry, doc.launcherPath),
    entry,
    extraFields: Object.keys(entry).filter((name) => !EDITABLE_FIELDS[type].includes(name)),
  };
}

function readGroup(doc: HookDocument, event: string, group: JsonValue, groupIndex: number): GroupBlock {
  const id = groupId(event, groupIndex);
  const matcher = isJsonObject(group) ? groupMatcher(group) : undefined;
  if (!isJsonObject(group) || matcher === undefined || !Array.isArray(group.hooks)) {
    return { id, event, groupIndex, matcher: matcher ?? null, readOnlyReason: UNREADABLE_GROUP_REASON, hooks: [] };
  }
  const hooks = group.hooks.map((entry, hookIndex) => readHook(doc, { event, groupIndex, matcher, hookIndex }, entry));
  return { id, event, groupIndex, matcher, readOnlyReason: null, hooks };
}

/** The block tree, in file order. */
export function readBlocks(doc: HookDocument): EventBlock[] {
  if (!isJsonObject(doc.hooks)) return [];
  return Object.entries(doc.hooks).map(([event, groups]) => {
    const readOnlyReason =
      eventRule(event) === null ? unknownEventReason(event) : Array.isArray(groups) ? null : UNREADABLE_EVENT_REASON;
    return {
      id: event,
      event,
      readOnlyReason,
      groups: Array.isArray(groups) ? groups.map((group, groupIndex) => readGroup(doc, event, group, groupIndex)) : [],
    };
  });
}

/**
 * Every script file the hooks run. Settings file paths are as written, with
 * ~ or $CLAUDE_PROJECT_DIR left in: Part 2 turns them into full paths. Hook
 * pack paths are relative to the draft root.
 */
export function scriptPathsOf(doc: HookDocument): string[] {
  const paths = new Set<string>();
  for (const event of readBlocks(doc)) {
    for (const group of event.groups) {
      for (const hook of group.hooks) {
        if (hook.kind === 'then' && hook.scriptPath !== null) paths.add(hook.scriptPath);
        if (hook.kind !== 'action' || hook.action !== 'runScript') continue;
        const command = typeof hook.entry.command === 'string' ? hook.entry.command : '';
        const path =
          doc.source === 'hookPackDraft' ? hookPackScriptOf(hook.entry, doc.launcherPath) : settingsScriptOf(command);
        if (path !== null) paths.add(path);
      }
    }
  }
  return [...paths];
}
