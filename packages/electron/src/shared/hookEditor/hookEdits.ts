/**
 * The hook editor's reducer. Each edit takes a document and gives back a new
 * one, or a plain reason and the same document. Nothing here touches the disk:
 * new and changed hook pack scripts wait in `scripts` until a save.
 */

import { eventRule } from './compatibility';
import {
  UNREADABLE_EVENT_REASON,
  groupAt,
  groupMatcher,
  readHook,
  type HookBlock,
  type HookDocument,
  type HookKey,
  type PausedHook,
} from './hookDocument';
import {
  GUARD_LINE_REASON,
  READ_ONLY_REASON,
  buildHookEntry,
  checkAction,
  checkField,
  checkMatcher,
  checkThen,
  doesNotFitReason,
  narrowNeverRunsReason,
  unknownEventReason,
} from './sourceRules';
import {
  GUARD_TIMEOUT_SECONDS,
  hookPackThenEntry,
  launcherCommand,
  settingsThenEntry,
  stripThenHeader,
  thenScriptPath,
} from './thenBlocks';
import { isJsonObject, type ActionKind, type HookType, type JsonObject, type JsonValue, type ThenBlock } from './types';

export type NewBlock = { kind: 'action'; action: ActionKind; fields: JsonObject } | { kind: 'then'; then: ThenBlock };

/**
 * Where a block goes. `index` is the position in the group; leave it out to add at the end.
 * `groupIndex` picks one group when the event has two groups with the same matcher. Leave it
 * out to use the first group with this matcher, or a new group at the end of the event.
 */
export interface Place {
  event: string;
  matcher: string | null;
  groupIndex?: number;
  index?: number;
}

export type HookEdit =
  | { kind: 'add'; place: Place; block: NewBlock }
  | { kind: 'remove'; key: HookKey }
  | { kind: 'move'; key: HookKey; to: Place }
  | { kind: 'copy'; key: HookKey; to: Place }
  | { kind: 'setField'; key: HookKey; name: string; value: JsonValue | undefined }
  | { kind: 'setThen'; key: HookKey; then: ThenBlock }
  | { kind: 'pause'; key: HookKey }
  | { kind: 'resume'; pausedIndex: number }
  | { kind: 'turnIntoScript'; key: HookKey }
  | { kind: 'setMatcher'; event: string; groupIndex: number; matcher: string | null };

export type EditResult = { ok: true; document: HookDocument } | { ok: false; reason: string; document: HookDocument };

const GONE_REASON = 'This hook is not at that place any more. Reload the file.';
const NOT_A_THEN_REASON = 'This block is not a Then block.';
const THEN_HAS_NO_FIELDS_REASON = 'Change a Then block through its answer and its message.';
const SETTINGS_SCRIPT_REASON = 'Only a hook pack keeps a Then block in a script file.';

/** A copy of the document that one edit may change. */
interface Draft extends HookDocument {
  hooks: JsonObject;
  scripts: Record<string, string>;
  paused: PausedHook[];
}

type EditableBlock = Exclude<HookBlock, { kind: 'opaque' }>;

interface Found {
  group: JsonObject;
  list: JsonValue[];
  block: EditableBlock;
}

/** The hook at a key, or the reason it cannot change. Opaque hooks never change. */
function editableHook(draft: Draft, key: HookKey): Found | string {
  const group = groupAt(draft, key.event, key.groupIndex);
  const list = group !== undefined && groupMatcher(group) === key.matcher ? (group.hooks as JsonValue[]) : [];
  if (group === undefined || key.hookIndex >= list.length) return GONE_REASON;
  const block = readHook(draft, key, list[key.hookIndex]);
  return block.kind === 'opaque' ? block.reason : { group, list, block };
}

function checkPlace(draft: Draft, place: Place): string | null {
  if (eventRule(place.event) === null) return unknownEventReason(place.event);
  const groups = draft.hooks[place.event];
  if (groups !== undefined && !Array.isArray(groups)) return UNREADABLE_EVENT_REASON;
  const matcherProblem = checkMatcher(place.event, place.matcher);
  if (matcherProblem !== null || place.groupIndex === undefined) return matcherProblem;
  // The screen named one group. It must still be there, with the matcher the screen saw.
  const group = groupAt(draft, place.event, place.groupIndex);
  return group !== undefined && groupMatcher(group) === place.matcher ? null : GONE_REASON;
}

/** The named group, else the first readable group on the event with this matcher, else a new group at the end. */
function groupFor(draft: Draft, place: Place): JsonObject {
  if (place.groupIndex !== undefined) {
    const named = groupAt(draft, place.event, place.groupIndex);
    // checkPlace confirmed this group before the edit changed anything.
    if (named === undefined) throw new Error('groupFor: the group that checkPlace confirmed is gone');
    return named;
  }
  const existing = draft.hooks[place.event];
  const groups: JsonValue[] = Array.isArray(existing) ? existing : [];
  if (groups !== existing) draft.hooks[place.event] = groups;
  for (const group of groups) {
    if (isJsonObject(group) && Array.isArray(group.hooks) && groupMatcher(group) === place.matcher) return group;
  }
  const group: JsonObject = place.matcher === null ? { hooks: [] } : { matcher: place.matcher, hooks: [] };
  groups.push(group);
  return group;
}

function insert(draft: Draft, place: Place, entry: JsonValue): void {
  const list = groupFor(draft, place).hooks as JsonValue[];
  list.splice(place.index ?? list.length, 0, entry);
}

/** Removes a group with no hooks and no other keys, then an event with no groups. */
function dropIfEmpty(draft: Draft, event: string, group: JsonObject): void {
  const groups = draft.hooks[event];
  if (!Array.isArray(groups)) return;
  const onlyMatcherAndHooks = Object.keys(group).every((name) => name === 'matcher' || name === 'hooks');
  if ((group.hooks as JsonValue[]).length === 0 && onlyMatcherAndHooks) groups.splice(groups.indexOf(group), 1);
  if (groups.length === 0) delete draft.hooks[event];
}

/** A Then block's hook entry. In a hook pack it also puts the generated script into the draft. */
function thenEntry(draft: Draft, event: string, then: ThenBlock, scriptPath: string | null): JsonObject {
  if (draft.source !== 'hookPackDraft') return settingsThenEntry(event, then);
  if (draft.launcherPath === null) throw new Error('A hook pack document always has the hook launcher path.');
  const path = scriptPath ?? thenScriptPath(event, new Set(Object.keys(draft.scripts)));
  const made = hookPackThenEntry(event, then, draft.launcherPath, path);
  draft.scripts[made.script.path] = made.script.text;
  return made.entry;
}

/** In a hook pack, a script or Then block on PreToolUse is a guard hook. It cannot cross to or from another event. */
function crossesGuardLine(draft: Draft, block: EditableBlock, to: string): boolean {
  const scriptKind = block.kind === 'then' || block.action === 'runScript';
  return draft.source === 'hookPackDraft' && scriptKind && (block.key.event === 'PreToolUse') !== (to === 'PreToolUse');
}

/** Checks that an existing block fits another event. */
function checkFits(draft: Draft, block: EditableBlock, to: string): string | null {
  if (crossesGuardLine(draft, block, to)) return GUARD_LINE_REASON;
  if (block.kind === 'then') return checkThen(draft.source, to, block.then);
  const rule = eventRule(to);
  if (rule === null) return unknownEventReason(to);
  if (!rule.hookTypes.includes(block.entry.type as HookType)) return doesNotFitReason(block.action, to);
  return block.entry.if !== undefined && !rule.ifRuns ? narrowNeverRunsReason(to) : null;
}

function addBlock(draft: Draft, place: Place, block: NewBlock): string | null {
  const problem = checkPlace(draft, place);
  if (problem !== null) return problem;
  if (block.kind === 'then') {
    const thenProblem = checkThen(draft.source, place.event, block.then);
    if (thenProblem !== null) return thenProblem;
    insert(draft, place, thenEntry(draft, place.event, block.then, null));
    return null;
  }
  const actionProblem = checkAction(draft.source, place.event, block.action, block.fields);
  if (actionProblem !== null) return actionProblem;
  insert(draft, place, buildHookEntry(draft.source, place.event, block.action, block.fields, draft.launcherPath));
  return null;
}

function remove(draft: Draft, key: HookKey): string | null {
  const found = editableHook(draft, key);
  if (typeof found === 'string') return found;
  // The script file of a removed hook stays on disk. The user may still want it.
  found.list.splice(key.hookIndex, 1);
  dropIfEmpty(draft, key.event, found.group);
  return null;
}

function relocate(draft: Draft, key: HookKey, to: Place, copy: boolean): string | null {
  const found = editableHook(draft, key);
  if (typeof found === 'string') return found;
  const { block } = found;
  const problem = checkPlace(draft, to) ?? checkFits(draft, block, to.event);
  if (problem !== null) return problem;
  let entry: JsonObject = structuredClone(block.entry);
  // A Then block is made again on a new event. A hook pack copy also gets its own script.
  if (block.kind === 'then' && (to.event !== key.event || (copy && draft.source === 'hookPackDraft'))) {
    entry = { ...entry, ...thenEntry(draft, to.event, block.then, null) };
  }
  if (!copy) found.list.splice(key.hookIndex, 1);
  insert(draft, to, entry);
  if (!copy) dropIfEmpty(draft, key.event, found.group);
  return null;
}

function setField(draft: Draft, key: HookKey, name: string, value: JsonValue | undefined): string | null {
  const found = editableHook(draft, key);
  if (typeof found === 'string') return found;
  const { block } = found;
  if (block.kind === 'then') return THEN_HAS_NO_FIELDS_REASON;
  const problem = checkField(draft.source, key.event, block.action, name, value);
  if (problem !== null) return problem;
  if (name === 'script' && typeof value === 'string' && draft.launcherPath !== null) {
    // A hook builder entry in exec form turns into the shell form here (settled decision 2).
    delete block.entry.args;
    block.entry.command = launcherCommand(draft.launcherPath, value, key.event === 'PreToolUse');
    // The guard form needs its 30 s limit, or Claude Code stops the hook first and the tool call goes ahead.
    if (key.event === 'PreToolUse') block.entry.timeout = GUARD_TIMEOUT_SECONDS;
  } else if (value === undefined) {
    delete block.entry[name];
  } else {
    block.entry[name] = value;
  }
  return null;
}

function setThen(draft: Draft, key: HookKey, then: ThenBlock): string | null {
  const found = editableHook(draft, key);
  if (typeof found === 'string') return found;
  const { block } = found;
  if (block.kind !== 'then') return NOT_A_THEN_REASON;
  const problem = checkThen(draft.source, key.event, then);
  if (problem !== null) return problem;
  found.list[key.hookIndex] = { ...block.entry, ...thenEntry(draft, key.event, then, block.scriptPath) };
  return null;
}

function pause(draft: Draft, key: HookKey): string | null {
  const found = editableHook(draft, key);
  if (typeof found === 'string') return found;
  found.list.splice(key.hookIndex, 1);
  draft.paused.push({ event: key.event, matcher: key.matcher, entry: found.block.entry });
  dropIfEmpty(draft, key.event, found.group);
  return null;
}

/**
 * True when the file already holds this paused hook: a group with the same "Only when" that
 * has an equal hook. This happens after a backup that still held the hook is restored.
 */
export function pausedHookInFile(doc: HookDocument, paused: PausedHook): boolean {
  if (!isJsonObject(doc.hooks)) return false;
  const groups = doc.hooks[paused.event];
  if (!Array.isArray(groups)) return false;
  const wanted = JSON.stringify(paused.entry);
  return groups.some(
    (group) =>
      isJsonObject(group) &&
      Array.isArray(group.hooks) &&
      groupMatcher(group) === paused.matcher &&
      group.hooks.some((entry) => JSON.stringify(entry) === wanted),
  );
}

function resume(draft: Draft, pausedIndex: number): string | null {
  const paused = draft.paused[pausedIndex];
  if (paused === undefined) return GONE_REASON;
  // The hook is in the file already, so turning it on only clears it from the tray. A second copy would run twice.
  if (pausedHookInFile(draft, paused)) {
    draft.paused.splice(pausedIndex, 1);
    return null;
  }
  const place: Place = { event: paused.event, matcher: paused.matcher };
  const problem = checkPlace(draft, place);
  if (problem !== null) return problem;
  // A copy, so that an older document in the undo history never shares this object.
  insert(draft, place, structuredClone(paused.entry));
  draft.paused.splice(pausedIndex, 1);
  return null;
}

function turnIntoScript(draft: Draft, key: HookKey): string | null {
  if (draft.source !== 'hookPackDraft') return SETTINGS_SCRIPT_REASON;
  const found = editableHook(draft, key);
  if (typeof found === 'string') return found;
  const { block } = found;
  if (block.kind !== 'then' || block.scriptPath === null) return NOT_A_THEN_REASON;
  // Without its header the script is the user's own. The block now reads as "Run a script".
  draft.scripts[block.scriptPath] = stripThenHeader(draft.scripts[block.scriptPath]);
  return null;
}

/** Changes the "Only when" value of one group. Every hook in the group keeps its text. */
function setMatcher(draft: Draft, event: string, groupIndex: number, matcher: string | null): string | null {
  if (eventRule(event) === null) return unknownEventReason(event);
  const problem = checkMatcher(event, matcher);
  if (problem !== null) return problem;
  const group = groupAt(draft, event, groupIndex);
  if (group === undefined) return GONE_REASON;
  if (matcher === null) delete group.matcher;
  else group.matcher = matcher;
  return null;
}

function run(draft: Draft, edit: HookEdit): string | null {
  switch (edit.kind) {
    case 'add':
      return addBlock(draft, edit.place, edit.block);
    case 'remove':
      return remove(draft, edit.key);
    case 'move':
      return relocate(draft, edit.key, edit.to, false);
    case 'copy':
      return relocate(draft, edit.key, edit.to, true);
    case 'setField':
      return setField(draft, edit.key, edit.name, edit.value);
    case 'setThen':
      return setThen(draft, edit.key, edit.then);
    case 'pause':
      return pause(draft, edit.key);
    case 'resume':
      return resume(draft, edit.pausedIndex);
    case 'turnIntoScript':
      return turnIntoScript(draft, edit.key);
    case 'setMatcher':
      return setMatcher(draft, edit.event, edit.groupIndex, edit.matcher);
  }
}

export function applyEdit(doc: HookDocument, edit: HookEdit): EditResult {
  if (doc.source === 'readOnly') return { ok: false, reason: READ_ONLY_REASON, document: doc };
  if (doc.hooksProblem !== null) return { ok: false, reason: doc.hooksProblem, document: doc };
  const draft: Draft = {
    ...doc,
    hooks: isJsonObject(doc.hooks) ? structuredClone(doc.hooks) : {},
    scripts: { ...doc.scripts },
    paused: [...doc.paused],
  };
  const reason = run(draft, edit);
  return reason === null ? { ok: true, document: draft } : { ok: false, reason, document: doc };
}
