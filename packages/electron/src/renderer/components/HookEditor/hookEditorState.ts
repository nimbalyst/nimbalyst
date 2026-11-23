/**
 * The hook editor screen's state, kept apart from React so node tests can run
 * it. One tab per settings file. Each tab holds its undo history, the text on
 * disk as last read or saved, and the document the review compares against.
 */

import type { OpenedFile, SaveRequest } from '../../../main/services/hookEditor/HookFileService';
import type { SettingsSource } from '../../../main/services/hookEditor/hookFiles';
import { hookId, openHookDocument, readBlocks, type HookBlock, type HookDocument, type PausedHook } from '../../../shared/hookEditor/hookDocument';
import { applyEdit, pausedHookInFile, type HookEdit, type NewBlock, type Place } from '../../../shared/hookEditor/hookEdits';
import {
  hasUnsavedChanges,
  markSaved,
  record,
  redo,
  startHistory,
  undo,
  type TabHistory,
} from '../../../shared/hookEditor/hookHistory';
import { baseOf, writeDocument, type WriteResult } from '../../../shared/hookEditor/hookWriter';
import { isJsonObject, type JsonObject } from '../../../shared/hookEditor/types';
import { blockName, newBlockOf, paletteFitReason, starterMatcher } from './hookEditorText';

export const STALE_EDIT_REASON = 'The hooks changed while you were working. Nothing was changed. Try again.';
export const SWITCH_TAB_REASON = 'Save or undo the changes in this file before you open another file.';

export interface EditorTab {
  source: SettingsSource;
  filePath: string;
  exists: boolean;
  /** The text on disk as last opened or saved. */
  diskText: string;
  /** Null when the file could not be opened. */
  history: TabHistory | null;
  openProblem: string | null;
  /** The document as last opened or saved. The review compares the current document with it. */
  savedDocument: HookDocument | null;
}

export function openTab(source: SettingsSource, opened: OpenedFile): EditorTab {
  const result = openHookDocument(opened.text, { source, paused: opened.paused });
  const tab = { source, filePath: opened.filePath, exists: opened.exists, diskText: opened.text };
  if (!result.ok) return { ...tab, history: null, openProblem: result.reason, savedDocument: null };
  return {
    ...tab,
    history: startHistory(result.document, baseOf(opened.text, result.document)),
    openProblem: null,
    savedDocument: result.document,
  };
}

export const READ_FAILED_REASON = 'Nimbalyst could not read this settings file. The file is unchanged.';

/** A tab for a file that could not be read at all. It shows the reason instead of an empty canvas. */
export function unreadTab(source: SettingsSource): EditorTab {
  return { source, filePath: '', exists: false, diskText: '', history: null, openProblem: READ_FAILED_REASON, savedDocument: null };
}

export function currentDocument(tab: EditorTab): HookDocument | null {
  return tab.history?.present ?? null;
}

/**
 * Applies one edit. `seen` is the document the user looked at when they asked
 * for the edit. A key names a place in that document, and after any other edit
 * the same place can hold a different hook, so a stale edit is refused.
 */
export function editTab(tab: EditorTab, seen: HookDocument, edit: HookEdit): { tab: EditorTab; reason: string | null } {
  if (tab.history === null) return { tab, reason: tab.openProblem };
  if (seen !== tab.history.present) return { tab, reason: STALE_EDIT_REASON };
  const result = applyEdit(seen, edit);
  if (!result.ok) return { tab, reason: result.reason };
  return { tab: { ...tab, history: record(tab.history, result.document) }, reason: null };
}

export function undoTab(tab: EditorTab): EditorTab {
  return tab.history === null ? tab : { ...tab, history: undo(tab.history) };
}

export function redoTab(tab: EditorTab): EditorTab {
  return tab.history === null ? tab : { ...tab, history: redo(tab.history) };
}

export function writeTab(tab: EditorTab): WriteResult | null {
  return tab.history === null ? null : writeDocument(tab.history.base, tab.history.present);
}

export function hasUnsaved(tab: EditorTab): boolean {
  return tab.history !== null && hasUnsavedChanges(tab.history);
}

/** What the screen sends to `hook-editor:save`. It carries the paused list, so the tray is kept beside the file. */
export function saveRequestOf(tab: EditorTab): SaveRequest | null {
  const written = writeTab(tab);
  if (written === null || tab.history === null) return null;
  return { source: tab.source, openedText: tab.history.base.text, newText: written.text, paused: [...tab.history.present.paused] };
}

/**
 * After a save the saved text becomes the base. The undo steps stay. The save
 * answer can arrive after the user made another edit, so the base must describe
 * the document that wrote `savedText`, not the document on screen now. Then the
 * later edit still shows as unsaved. The same holds for the paused list: `savedPaused` is
 * the list the save sent, not the list on screen now.
 */
export function afterSave(tab: EditorTab, savedText: string, savedPaused: readonly PausedHook[]): EditorTab {
  if (tab.history === null) return tab;
  const present = tab.history.present;
  const common = { ...tab, exists: true, diskText: savedText };
  if (writeTab(tab)?.text === savedText) {
    const samePaused = JSON.stringify(present.paused) === JSON.stringify(savedPaused);
    const savedDocument = samePaused ? present : { ...present, paused: [...savedPaused] };
    return { ...common, history: markSaved(tab.history, baseOf(savedText, present), savedPaused), savedDocument };
  }
  // Read the saved text the way a file is read at open.
  const reread = openTab(tab.source, { filePath: tab.filePath, exists: true, text: savedText, paused: [...savedPaused] });
  if (reread.history === null) return { ...common, history: markSaved(tab.history, baseOf(savedText, present), savedPaused) };
  return { ...common, history: markSaved(tab.history, reread.history.base, savedPaused), savedDocument: reread.savedDocument };
}

interface Item {
  event: string;
  groupIndex: number;
  matcher: string | null;
  name: string;
  /** What the hook runs, in plain words for the add sentence. Empty when the hook has no main value. */
  main: string;
  json: string;
}

const PROMPT_SHOWN_LENGTH = 60;

/** What a hook runs: its command, web address, prompt (cut to 60 characters) or MCP tool. Empty for any other block. */
function mainValueOf(block: HookBlock): string {
  if (block.kind !== 'action') return '';
  const { entry } = block;
  const text = (value: unknown) => (typeof value === 'string' ? value : '');
  switch (block.action) {
    case 'runScript':
    case 'runCommand':
      return text(entry.command);
    case 'sendToWeb':
      return text(entry.url);
    case 'askAi':
    case 'runAgent': {
      const prompt = text(entry.prompt);
      return prompt.length > PROMPT_SHOWN_LENGTH ? `${prompt.slice(0, PROMPT_SHOWN_LENGTH)}...` : prompt;
    }
    case 'callMcpTool':
      return text(entry.server) !== '' && text(entry.tool) !== '' ? `${text(entry.tool)} on ${text(entry.server)}` : '';
    default:
      return '';
  }
}

function itemsOf(doc: HookDocument): Item[] {
  const entryOf = (block: HookBlock) => (block.kind === 'opaque' ? block.raw : block.entry);
  return readBlocks(doc).flatMap((event) =>
    event.groups.flatMap((group) =>
      group.hooks.map((block) => ({
        event: event.event,
        groupIndex: group.groupIndex,
        matcher: group.matcher,
        name: blockName(block),
        main: mainValueOf(block),
        json: JSON.stringify(entryOf(block)),
      })),
    ),
  );
}

/** Each group as one line of text: its event, its "Only when" and its hooks. Two equal lists mean the same grouping. */
function groupLines(items: readonly Item[]): string[] {
  const lines = new Map<string, string>();
  for (const item of items) {
    const at = `${item.event}\n${item.groupIndex}`;
    lines.set(at, `${lines.get(at) ?? `${item.event}\n${item.matcher}`}\n${item.json}`);
  }
  return [...lines.values()];
}

/**
 * Groups whose "Only when" changed while their hooks stayed the same, as "event, group number" keys,
 * each with one sentence. Without this, every hook in such a group reads as one add and one remove.
 */
function matcherChanges(before: readonly Item[], after: readonly Item[]): Map<string, string> {
  const hooksOf = (items: readonly Item[], key: string) => items.filter((item) => `${item.event}\n${item.groupIndex}` === key);
  const changes = new Map<string, string>();
  for (const item of after) {
    const key = `${item.event}\n${item.groupIndex}`;
    if (changes.has(key)) continue;
    const old = hooksOf(before, key);
    const now = hooksOf(after, key);
    if (old.length === 0 || old[0].matcher === item.matcher) continue;
    if (old.map((hook) => hook.json).join('\n') !== now.map((hook) => hook.json).join('\n')) continue;
    const text = (matcher: string | null) => matcher ?? 'any';
    changes.set(key, `Changes "Only when" on ${item.event} from ${text(old[0].matcher)} to ${text(item.matcher)}.`);
  }
  return changes;
}

function placeText(item: Item): string {
  return item.matcher === null ? `on ${item.event}.` : `on ${item.event}, only when ${item.matcher}.`;
}

/** A hook in the "Paused hooks" tray, named the way the Review names it. */
export interface PausedRow {
  index: number;
  name: string;
  main: string;
  place: string;
  /** True when the file already holds this hook, so turning it on only clears it from the tray. */
  inFile: boolean;
}

/** A paused hook read as a one-hook file, so its name matches the Review sentences. Undefined when it cannot be read. */
function itemOfPaused(doc: HookDocument, hook: PausedHook): Item | undefined {
  const group: JsonObject = hook.matcher === null ? { hooks: [hook.entry] } : { matcher: hook.matcher, hooks: [hook.entry] };
  return itemsOf({ ...doc, hooks: { [hook.event]: [group] }, hooksProblem: null })[0];
}

/** The paused hooks of a file. Each one is read as a one-hook file, so its name matches the Review sentences. */
export function pausedRows(doc: HookDocument): PausedRow[] {
  return doc.paused.flatMap((hook, index) => {
    const item = itemOfPaused(doc, hook);
    return item === undefined ? [] : [{ index, name: item.name, main: item.main, place: placeText(item), inFile: pausedHookInFile(doc, hook) }];
  });
}

/**
 * One plain sentence for each hook added, changed, removed, paused or turned back on since
 * the last open or save, and one for each changed "Only when". Every unsaved change gets at
 * least one sentence.
 */
export function changeSentences(tab: EditorTab): string[] {
  const present = currentDocument(tab);
  const before = tab.savedDocument === null ? [] : itemsOf(tab.savedDocument);
  const after = present === null ? [] : itemsOf(present);
  const idOf = (item: Item) => `${item.event}\n${item.matcher}\n${item.json}`;
  const matchers = matcherChanges(before, after);
  const outsideMatcherChange = (item: Item) => !matchers.has(`${item.event}\n${item.groupIndex}`);
  const removed = before.filter(outsideMatcherChange);
  const added: Item[] = [];
  for (const item of after.filter(outsideMatcherChange)) {
    const at = removed.findIndex((old) => idOf(old) === idOf(item));
    if (at === -1) added.push(item);
    else removed.splice(at, 1);
  }
  const sentences: string[] = [...matchers.values()];
  // A paused hook leaves the file and joins the tray. A hook turned back on does the reverse.
  // Each reads as one sentence, not as a remove or an add.
  const pausedIdsOf = (doc: HookDocument | null) =>
    doc === null ? [] : doc.paused.map((hook) => `${hook.event}\n${hook.matcher}\n${JSON.stringify(hook.entry)}`);
  const onlyIn = (list: string[], other: string[]) => {
    const rest = [...other];
    return list.filter((id) => {
      const at = rest.indexOf(id);
      if (at === -1) return true;
      rest.splice(at, 1);
      return false;
    });
  };
  const pausedBefore = pausedIdsOf(tab.savedDocument);
  const pausedAfter = pausedIdsOf(present);
  for (const id of onlyIn(pausedAfter, pausedBefore)) {
    const at = removed.findIndex((item) => idOf(item) === id);
    if (at === -1) continue;
    sentences.push(`Pauses "${removed[at].name}" ${placeText(removed[at])}`);
    removed.splice(at, 1);
  }
  for (const id of onlyIn(pausedBefore, pausedAfter)) {
    const at = added.findIndex((item) => idOf(item) === id);
    if (at === -1) {
      // The hook was already in the file, so leaving the paused list added nothing.
      const inFile = after.find((item) => idOf(item) === id);
      if (inFile !== undefined) {
        sentences.push(`Takes "${inFile.name}" off the paused list. It is already in the file.`);
        continue;
      }
      // The hook is in neither the saved file nor the file now, so it was turned back on and then deleted.
      const gone = tab.savedDocument?.paused.find((hook) => `${hook.event}\n${hook.matcher}\n${JSON.stringify(hook.entry)}` === id);
      const goneItem = gone === undefined || tab.savedDocument === null ? undefined : itemOfPaused(tab.savedDocument, gone);
      if (goneItem !== undefined && !before.some((item) => idOf(item) === id)) {
        sentences.push(`Deletes "${goneItem.name}" from the paused list.`);
      }
      continue;
    }
    sentences.push(`Turns back on "${added[at].name}" ${placeText(added[at])}`);
    added.splice(at, 1);
  }
  for (const item of added) {
    // An added and a removed block of the same kind in the same place read as one change.
    const at = removed.findIndex((old) => old.event === item.event && old.matcher === item.matcher && old.name === item.name);
    if (at === -1) {
      sentences.push(`Adds "${item.name}"${item.main === '' ? '' : ` (${item.main})`} ${placeText(item)}`);
    } else {
      removed.splice(at, 1);
      sentences.push(`Changes "${item.name}" ${placeText(item)}`);
    }
  }
  for (const item of removed) sentences.push(`Removes "${item.name}" ${placeText(item)}`);
  if (sentences.length === 0 && before.map(idOf).join('\n\n') !== after.map(idOf).join('\n\n')) {
    sentences.push('Changes the order of hooks.');
  }
  // The same hooks in the same order can still sit in other groups, for example after a hook moves into the group above.
  if (sentences.length === 0 && groupLines(before).join('\n\n') !== groupLines(after).join('\n\n')) {
    sentences.push('Changes how hooks are grouped.');
  }
  // Last safety net: an unsaved change with no sentence would leave Review off and let Close skip its question.
  if (sentences.length === 0 && hasUnsaved(tab)) sentences.push('Changes how the hooks are written in the file.');
  return sentences;
}

/** The group a selected block sits in, as a place that names that one group. */
export function placeOfSelection(doc: HookDocument, id: string | null): Place | null {
  if (id === null) return null;
  const [event, groupIndex] = id.split('/');
  if (groupIndex === undefined) return null;
  const group = readBlocks(doc)
    .find((candidate) => candidate.event === event)
    ?.groups.find((candidate) => candidate.groupIndex === Number(groupIndex));
  return group === undefined ? null : { event, matcher: group.matcher, groupIndex: group.groupIndex };
}

/**
 * The example hook that picking a "When" block adds: a "Run a command" block
 * that echoes the event name, with an example "Only when". It also gives the
 * id of the new hook, so the screen can open its form.
 * The add edit puts the hook in the first group that has the same "Only when".
 * When the event has no such group, the hook starts a new last group. When it
 * has one, the hook joins it as the last hook. The hooks already there do not change.
 * Null when the block does not fit this event or file, or the event is unreadable.
 */
export function starterHookFor(source: SettingsSource, doc: HookDocument, event: string): { place: Place; block: NewBlock; selectId: string } | null {
  const item = { kind: 'action', action: 'runCommand' } as const;
  if (paletteFitReason(source, event, item) !== null) return null;
  const matcher = starterMatcher(event);
  const existing = readBlocks(doc).find((candidate) => candidate.event === event);
  if (existing !== undefined && existing.readOnlyReason !== null) return null;
  const groups = existing?.groups ?? [];
  const joined = groups.find((group) => group.readOnlyReason === null && group.matcher === matcher);
  return {
    place: { event, matcher },
    block: newBlockOf(item, { command: `echo '${event} hook ran'` }),
    selectId: hookId({ event, groupIndex: joined?.groupIndex ?? groups.length, matcher, hookIndex: joined?.hooks.length ?? 0 }),
  };
}

/** Claude Code merges settings in this order. The first file that sets the value decides. */
const MERGE_ORDER: readonly SettingsSource[] = ['localSettings', 'projectSettings', 'userSettings'];

function disableAllHooksOf(text: string): boolean | undefined {
  try {
    const root: unknown = text.trim() === '' ? {} : JSON.parse(text);
    return isJsonObject(root) && typeof root.disableAllHooks === 'boolean' ? root.disableAllHooks : undefined;
  } catch {
    return undefined;
  }
}

/** The file that turns every hook off, or null when hooks run. */
export function hooksOffFile(tabs: readonly EditorTab[]): string | null {
  for (const source of MERGE_ORDER) {
    const tab = tabs.find((candidate) => candidate.source === source);
    const value = tab === undefined ? undefined : disableAllHooksOf(tab.diskText);
    if (value !== undefined) return value ? tab!.filePath : null;
  }
  return null;
}

/** Events whose "watch these files" answer starts the FileChanged watch list. */
const SEED_EVENTS: readonly string[] = ['SessionStart', 'CwdChanged'];

/**
 * True when this file has FileChanged hooks but no open file gives FileChanged
 * a watch list. In the event test a FileChanged matcher alone fired nothing,
 * so the matcher does not count.
 */
export function fileChangedNeedsSeed(current: HookDocument, open: readonly HookDocument[]): boolean {
  if (!readBlocks(current).some((event) => event.event === 'FileChanged')) return false;
  const seeds = (doc: HookDocument) =>
    readBlocks(doc).some(
      (event) =>
        SEED_EVENTS.includes(event.event) &&
        event.groups.some((group) => group.hooks.some((block) => block.kind === 'then' && block.then.answer === 'watchFiles')),
    );
  return !open.some(seeds);
}

export interface ScreenState {
  tabs: EditorTab[];
  activeSource: SettingsSource;
  notice: string | null;
}

export type ScreenAction =
  | { type: 'opened'; tab: EditorTab }
  | { type: 'show'; source: SettingsSource }
  | { type: 'edit'; seen: HookDocument; edit: HookEdit }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'saved'; text: string; paused: readonly PausedHook[] }
  | { type: 'notice'; text: string | null };

/** The screen's reducer. Edits, undo, redo and save act on the tab the user is looking at. */
export function screenReducer(state: ScreenState, action: ScreenAction): ScreenState {
  const active = state.tabs.find((tab) => tab.source === state.activeSource);
  const replace = (tab: EditorTab, notice: string | null = null): ScreenState => ({
    ...state,
    notice,
    tabs: state.tabs.map((other) => (other.source === tab.source ? tab : other)),
  });
  switch (action.type) {
    case 'opened': {
      const known = state.tabs.some((tab) => tab.source === action.tab.source);
      // A reload replaces the tab, so its old undo steps go with it.
      return known ? replace(action.tab) : { ...state, notice: null, tabs: [...state.tabs, action.tab] };
    }
    case 'show':
      if (active !== undefined && action.source !== active.source && hasUnsaved(active)) {
        return { ...state, notice: SWITCH_TAB_REASON };
      }
      return { ...state, activeSource: action.source, notice: null };
    case 'edit': {
      if (active === undefined) return state;
      const result = editTab(active, action.seen, action.edit);
      return replace(result.tab, result.reason);
    }
    case 'undo':
      return active === undefined ? state : replace(undoTab(active));
    case 'redo':
      return active === undefined ? state : replace(redoTab(active));
    case 'saved':
      return active === undefined ? state : replace(afterSave(active, action.text, action.paused));
    case 'notice':
      return { ...state, notice: action.text };
  }
}
