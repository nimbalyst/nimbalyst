// @vitest-environment node

/**
 * The hook editor screen's state without the screen: tabs, the stale-edit
 * guard, the save request, the plain change sentences, the "hooks are off"
 * rule and the "Only when" chips.
 */

import { expect, it } from 'vitest';

import type { OpenedFile } from '../../../../main/services/hookEditor/HookFileService';
import { NOT_PLAIN_JSON_REASON } from '../../../../shared/hookEditor/hookDocument';
import type { HookEdit } from '../../../../shared/hookEditor/hookEdits';
import {
  STALE_EDIT_REASON,
  afterSave,
  changeSentences,
  currentDocument,
  editTab,
  fileChangedNeedsSeed,
  hasUnsaved,
  hooksOffFile,
  openTab,
  pausedRows,
  redoTab,
  saveRequestOf,
  starterHookFor,
  undoTab,
  type EditorTab,
} from '../hookEditorState';
import { dropEdit } from '../hookDrops';
import {
  PALETTE_ITEMS,
  TOOL_CHIPS,
  chipsOf,
  inEventOrder,
  linesOfObject,
  matcherOfChips,
  objectOfLines,
  paletteFitReason,
} from '../hookEditorText';

const LOCAL = `{
  "model": "opus",
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "echo first" }] }
    ]
  }
}
`;
const LOCAL_PATH = '/work/app/.claude/settings.local.json';
const FIRST_KEY = { event: 'PreToolUse', groupIndex: 0, matcher: 'Bash', hookIndex: 0 };
const ADD_SECOND: HookEdit = {
  kind: 'add',
  place: { event: 'PreToolUse', matcher: 'Bash', groupIndex: 0 },
  block: { kind: 'action', action: 'runCommand', fields: { command: 'echo second' } },
};

function opened(text: string, filePath = LOCAL_PATH): OpenedFile {
  return { filePath, exists: text !== '', text, paused: [] };
}

function edited(tab: EditorTab, edit: HookEdit): EditorTab {
  const result = editTab(tab, currentDocument(tab)!, edit);
  expect(result.reason).toBeNull();
  return result.tab;
}

it('says what an added hook runs, and names the prompt of an agent in the same way', () => {
  const place = { event: 'PreToolUse', matcher: 'Bash', groupIndex: 0 };
  const sentenceOf = (block: Extract<HookEdit, { kind: 'add' }>['block']) =>
    changeSentences(edited(openTab('localSettings', opened(LOCAL)), { kind: 'add', place, block }));
  const WHERE = 'on PreToolUse, only when Bash.';

  expect(sentenceOf({ kind: 'action', action: 'runCommand', fields: { command: "echo 'hook editor demo'" } })).toEqual([
    `Adds "Run a command" (echo 'hook editor demo') ${WHERE}`,
  ]);
  expect(sentenceOf({ kind: 'action', action: 'sendToWeb', fields: { url: 'https://example.com/hook' } })).toEqual([
    `Adds "Send to a web address" (https://example.com/hook) ${WHERE}`,
  ]);
  expect(sentenceOf({ kind: 'action', action: 'callMcpTool', fields: { server: 'db', tool: 'query' } })).toEqual([
    `Adds "Call an MCP tool" (query on db) ${WHERE}`,
  ]);
  // A prompt of 60 characters or less stays whole. A longer one is cut to 60 characters, then "...".
  const sixty = 'a'.repeat(60);
  expect(sentenceOf({ kind: 'action', action: 'askAi', fields: { prompt: sixty } })).toEqual([`Adds "Ask the AI" (${sixty}) ${WHERE}`]);
  expect(sentenceOf({ kind: 'action', action: 'askAi', fields: { prompt: `${sixty}b` } })).toEqual([`Adds "Ask the AI" (${sixty}...) ${WHERE}`]);

  // "Run an agent" names its prompt the same way, cut to 60 characters.
  expect(sentenceOf({ kind: 'action', action: 'runAgent', fields: { prompt: 'check the diff' } })).toEqual([`Adds "Run an agent" (check the diff) ${WHERE}`]);
  expect(sentenceOf({ kind: 'action', action: 'runAgent', fields: { prompt: `${sixty}b` } })).toEqual([`Adds "Run an agent" (${sixty}...) ${WHERE}`]);
});

it('edits a tab, refuses a stale edit, saves, and counts an undo after the save as a change', () => {
  const tab = openTab('localSettings', opened(LOCAL));
  const seenAtOpen = currentDocument(tab)!;
  const added = edited(tab, ADD_SECOND);
  expect(changeSentences(added)).toEqual(['Adds "Run a command" (echo second) on PreToolUse, only when Bash.']);

  // The screen still shows the document from before the add, so its key may name another hook now.
  const stale = editTab(added, seenAtOpen, { kind: 'remove', key: FIRST_KEY });
  expect(stale.tab).toBe(added);
  expect(stale.reason).toBe(STALE_EDIT_REASON);

  // A refused edit (not the stale guard) also hands back the very same tab.
  const refused = editTab(tab, currentDocument(tab)!, {
    kind: 'add',
    place: { event: 'SessionStart', matcher: null },
    block: { kind: 'action', action: 'sendToWeb', fields: { url: 'https://example.com' } },
  });
  expect(refused.tab).toBe(tab);
  expect(refused.reason).not.toBeNull();
  expect(refused.reason).not.toBe(STALE_EDIT_REASON);

  expect(changeSentences(undoTab(added))).toEqual([]);
  const request = saveRequestOf(redoTab(undoTab(added)))!;
  expect(request.openedText).toBe(LOCAL);
  expect(JSON.parse(request.newText).model).toBe('opus');
  expect(JSON.parse(request.newText).hooks.PreToolUse[0].hooks).toHaveLength(2);

  const saved = afterSave(added, request.newText, request.paused);
  expect(hasUnsaved(saved)).toBe(false);
  expect(changeSentences(saved)).toEqual([]);
  // The user edits again while the save is in flight. Its answer then names the earlier text.
  const laterEdit: HookEdit = { kind: 'remove', key: FIRST_KEY };
  const later = edited(added, laterEdit);
  const answered = afterSave(later, request.newText, request.paused);
  expect(hasUnsaved(answered)).toBe(true);
  expect(changeSentences(answered)).toEqual(['Removes "Run a command" on PreToolUse, only when Bash.']);

  const undone = undoTab(saved);
  expect(changeSentences(undone)).toEqual(['Removes "Run a command" on PreToolUse, only when Bash.']);
  expect(saveRequestOf(undone)!.openedText).toBe(request.newText);

  // A new "Only when" on a saved group of two hooks reads as one change, not as an add and a remove for each hook.
  const matcherChanged = edited(saved, { kind: 'setMatcher', event: 'PreToolUse', groupIndex: 0, matcher: 'Bash|Edit' });
  expect(changeSentences(matcherChanged)).toEqual(['Changes "Only when" on PreToolUse from Bash to Bash|Edit.']);
});

it('says "Pauses" and "Turns back on" for a paused hook, and names paused hooks as the Review does', () => {
  const first = '{ "type": "command", "command": "echo first" }';
  const second = '{ "type": "command", "command": "echo second" }';
  const text = `{ "hooks": { "PreToolUse": [{ "matcher": "Bash", "hooks": [${first}, ${second}] }] } }\n`;
  const WHERE = 'on PreToolUse, only when Bash.';

  const pausedTab = edited(openTab('localSettings', opened(text)), { kind: 'pause', key: FIRST_KEY });
  // One sentence for the pause. The hook leaving the file does not also read as a removal.
  expect(changeSentences(pausedTab)).toEqual([`Pauses "Run a command" ${WHERE}`]);
  expect(pausedRows(currentDocument(pausedTab)!)).toEqual([{ index: 0, name: 'Run a command', main: 'echo first', place: WHERE, inFile: false }]);

  // The user pauses the other hook while the first save is in flight. The answer names the paused list that was sent.
  const sent = saveRequestOf(pausedTab)!;
  const whileSaving = edited(pausedTab, { kind: 'pause', key: FIRST_KEY });
  expect(changeSentences(afterSave(whileSaving, sent.newText, sent.paused))).toEqual([`Pauses "Run a command" ${WHERE}`]);

  // After the save the paused hook is the saved state. Turning it back on is then the change.
  const saved = afterSave(pausedTab, sent.newText, sent.paused);
  expect(changeSentences(saved)).toEqual([]);
  expect(saved.savedDocument!.paused).toHaveLength(1);
  const resumed = edited(saved, { kind: 'resume', pausedIndex: 0 });
  expect(changeSentences(resumed)).toEqual([`Turns back on "Run a command" ${WHERE}`]);
  expect(pausedRows(currentDocument(resumed)!)).toEqual([]);

  // The hook is turned back on and then deleted. It is in neither file, so the Review says it leaves the paused list for good.
  const resumedThenDeleted = edited(resumed, { kind: 'remove', key: { ...FIRST_KEY, hookIndex: 1 } });
  expect(changeSentences(resumedThenDeleted)).toEqual(['Deletes "Run a command" from the paused list.']);

  // A restored backup brings a paused hook back into the file. The tray row says so, and turning it on adds no second copy.
  const pausedList = [{ event: 'PreToolUse', matcher: 'Bash', entry: { type: 'command', command: 'echo first' } }];
  const restored = openTab('localSettings', { ...opened(text), paused: pausedList });
  expect(pausedRows(currentDocument(restored)!)).toEqual([{ index: 0, name: 'Run a command', main: 'echo first', place: WHERE, inFile: true }]);
  const cleared = edited(restored, { kind: 'resume', pausedIndex: 0 });
  expect(changeSentences(cleared)).toEqual(['Takes "Run a command" off the paused list. It is already in the file.']);
  expect(JSON.parse(saveRequestOf(cleared)!.newText).hooks.PreToolUse[0].hooks).toHaveLength(2);
  expect(pausedRows(currentDocument(cleared)!)).toEqual([]);
});

it('greys out only the blocks an event cannot take', () => {
  const item = (name: string) => PALETTE_ITEMS.find((candidate) => (candidate.kind === 'action' ? candidate.action : candidate.answer) === name)!;
  expect(paletteFitReason('projectSettings', 'PreToolUse', item('sendToWeb'))).toBeNull();
  expect(paletteFitReason('projectSettings', 'SessionStart', item('sendToWeb'))).not.toBeNull();
  expect(paletteFitReason('projectSettings', 'SessionStart', item('watchFiles'))).toBeNull();
});

it('starts a missing file with its first hook, gives a broken file no save, and finds the file that turns hooks off', () => {
  const withStop = edited(openTab('localSettings', opened('')), {
    kind: 'add',
    place: { event: 'Stop', matcher: null },
    block: { kind: 'action', action: 'askAi', fields: { prompt: 'Did Claude finish?' } },
  });
  const request = saveRequestOf(withStop)!;
  expect(request.openedText).toBe('');
  expect(JSON.parse(request.newText)).toEqual({ hooks: { Stop: [{ hooks: [{ type: 'prompt', prompt: 'Did Claude finish?' }] }] } });

  const broken = openTab('localSettings', opened('{ "hooks": '));
  expect(broken.openProblem).toBe(NOT_PLAIN_JSON_REASON);
  expect(saveRequestOf(broken)).toBeNull();

  const user = (text: string) => openTab('userSettings', opened(text, '/home/me/.claude/settings.json'));
  const local = (text: string) => openTab('localSettings', opened(text));
  expect(hooksOffFile([user('{ "disableAllHooks": true }'), local('{}')])).toBe('/home/me/.claude/settings.json');
  // The local file wins over the user file.
  expect(hooksOffFile([user('{ "disableAllHooks": true }'), local('{ "disableAllHooks": false }')])).toBeNull();
  expect(hooksOffFile([user('{ "disableAllHooks": false }'), local('{ "hooks": ')])).toBeNull();
});

it('shows a matcher as chips only when every part is a chip, and reads key: value lines', () => {
  expect(chipsOf('Edit|Write', TOOL_CHIPS)).toEqual(['Edit', 'Write']);
  expect(matcherOfChips(['Edit', 'Write'])).toBe('Edit|Write');
  expect(chipsOf(null, TOOL_CHIPS)).toEqual([]);
  expect(matcherOfChips([])).toBeNull();
  for (const typed of ['mcp__memory__.*', 'Bash|Foo', 'Bash(git *)', '']) expect(chipsOf(typed, TOOL_CHIPS)).toBeNull();

  const headers = { Authorization: 'Bearer $TOKEN', 'X-Team': 'a: b' };
  expect(objectOfLines(linesOfObject(headers))).toEqual(headers);
  expect(objectOfLines('  \nno colon here\nKey:  spaced  ')).toEqual({ Key: 'spaced' });
});

it('turns a drop into one move, asks for fields on a palette drop, and moves like arrayMove', () => {
  const key = { event: 'PreToolUse', groupIndex: 0, matcher: 'Bash', hookIndex: 0 };
  const hook = { kind: 'hook' as const, key };
  expect(dropEdit(hook, { event: 'PreToolUse', matcher: 'Bash', groupIndex: 0, index: 0 }, 'localSettings')).toEqual({ kind: 'none' });
  expect(dropEdit(hook, { event: 'PreToolUse', matcher: 'Bash', groupIndex: 0, index: 2 }, 'localSettings')).toEqual({
    kind: 'edit',
    edit: { kind: 'move', key, to: { event: 'PreToolUse', matcher: 'Bash', groupIndex: 0, index: 2 } },
  });
  expect(dropEdit(hook, { event: 'PostToolUse', matcher: null, groupIndex: null, index: null }, 'localSettings')).toEqual({
    kind: 'edit',
    edit: { kind: 'move', key, to: { event: 'PostToolUse', matcher: null } },
  });
  const item = { kind: 'action' as const, action: 'runCommand' as const };
  expect(dropEdit({ kind: 'palette', item }, { event: 'Stop', matcher: null, groupIndex: 0, index: 1 }, 'localSettings')).toEqual({
    kind: 'askFields',
    item,
    place: { event: 'Stop', matcher: null, groupIndex: 0, index: 1 },
  });

  const three = `{ "hooks": { "Stop": [{ "hooks": [
    { "type": "command", "command": "echo a" }, { "type": "command", "command": "echo b" }, { "type": "command", "command": "echo c" }
  ] }] } }`;
  const tab = openTab('localSettings', opened(three));
  const first = { event: 'Stop', groupIndex: 0, matcher: null, hookIndex: 0 };
  const result = dropEdit({ kind: 'hook', key: first }, { event: 'Stop', matcher: null, groupIndex: 0, index: 2 }, 'localSettings');
  if (result.kind !== 'edit') throw new Error('expected an edit');
  const moved = edited(tab, result.edit);
  const commands = JSON.parse(saveRequestOf(moved)!.newText).hooks.Stop[0].hooks.map((hook: { command: string }) => hook.command);
  expect(commands).toEqual(['echo b', 'echo c', 'echo a']);

  // Two groups with no "Only when". The second hook moves into the first group: the hooks keep their order,
  // but the file changes, so the change must still have a sentence. Without one, Review and Close miss it.
  const twoGroups = openTab('localSettings', opened(`{ "hooks": { "Stop": [
    { "hooks": [{ "type": "command", "command": "echo a" }] }, { "hooks": [{ "type": "command", "command": "echo b" }] }
  ] } }`));
  const joined = dropEdit(
    { kind: 'hook', key: { event: 'Stop', groupIndex: 1, matcher: null, hookIndex: 0 } },
    { event: 'Stop', matcher: null, groupIndex: 0, index: null },
    'localSettings',
  );
  if (joined.kind !== 'edit') throw new Error('expected an edit');
  const regrouped = edited(twoGroups, joined.edit);
  expect(JSON.parse(saveRequestOf(regrouped)!.newText).hooks.Stop).toHaveLength(1);
  expect(hasUnsaved(regrouped)).toBe(true);
  expect(changeSentences(regrouped)).not.toEqual([]);
});

it('refuses a palette drop on an event the block does not fit, and writes a new group with no matcher key', () => {
  const webItem = { kind: 'action' as const, action: 'sendToWeb' as const };
  const refused = dropEdit({ kind: 'palette', item: webItem }, { event: 'SessionStart', matcher: null, groupIndex: 0, index: 0 }, 'localSettings');
  expect(refused.kind).toBe('refused');
  if (refused.kind === 'refused') expect(refused.reason).not.toBe('');
  const fits = dropEdit({ kind: 'palette', item: webItem }, { event: 'PreToolUse', matcher: null, groupIndex: null, index: null }, 'localSettings');
  expect(fits.kind).toBe('askFields');

  const tab = openTab('localSettings', opened(LOCAL));
  const moved = dropEdit({ kind: 'hook', key: FIRST_KEY }, { event: 'PostToolUse', matcher: null, groupIndex: null, index: null }, 'localSettings');
  if (moved.kind !== 'edit') throw new Error('expected an edit');
  const group = JSON.parse(saveRequestOf(edited(tab, moved.edit))!.newText).hooks.PostToolUse[0];
  expect('matcher' in group).toBe(false);
});

it('warns about FileChanged only while no open file gives it a watch list', () => {
  const watcher = openTab('localSettings', opened(`{ "hooks": { "FileChanged": [
    { "matcher": ".env", "hooks": [{ "type": "command", "command": "echo changed" }] }
  ] } }`));
  const user = openTab('userSettings', opened('', '/home/me/.claude/settings.json'));
  const current = currentDocument(watcher)!;
  // The matcher names .env, but the event test showed that a matcher alone fires nothing.
  expect(fileChangedNeedsSeed(current, [current, currentDocument(user)!])).toBe(true);

  const seeded = edited(user, {
    kind: 'add',
    place: { event: 'SessionStart', matcher: null },
    block: { kind: 'then', then: { answer: 'watchFiles', paths: ['/work/app/.env'] } },
  });
  expect(fileChangedNeedsSeed(current, [current, currentDocument(seeded)!])).toBe(false);
  expect(fileChangedNeedsSeed(currentDocument(seeded)!, [currentDocument(seeded)!])).toBe(false);

  // A CwdChanged "watch these files" block also gives the watch list. A different answer on SessionStart does not.
  const cwdSeeded = edited(user, {
    kind: 'add',
    place: { event: 'CwdChanged', matcher: null },
    block: { kind: 'then', then: { answer: 'watchFiles', paths: ['/work/app/.env'] } },
  });
  expect(fileChangedNeedsSeed(current, [current, currentDocument(cwdSeeded)!])).toBe(false);
  const otherAnswer = edited(user, {
    kind: 'add',
    place: { event: 'SessionStart', matcher: null },
    block: { kind: 'then', then: { answer: 'tellUser', message: 'Hello' } },
  });
  expect(fileChangedNeedsSeed(current, [current, currentDocument(otherAnswer)!])).toBe(true);
});

it('builds the starter hook for a picked "When" block: an example "Only when" by event kind, a new group or the group that already has it', () => {
  const docOf = (text: string) => currentDocument(openTab('localSettings', opened(text)))!;
  const starter = (text: string, event: string) => starterHookFor('localSettings', docOf(text), event);

  // A tool event gets Bash, a fixed list gets its first value, and the other kinds get no matcher.
  expect(starter('', 'PostToolUse')?.place.matcher).toBe('Bash');
  expect(starter('', 'SessionStart')?.place.matcher).toBe('startup');
  expect(starter('', 'Stop')?.place.matcher).toBeNull();
  expect(starter('', 'SubagentStart')?.place.matcher).toBeNull();
  expect(starter('', 'PreToolUse')).toMatchObject({
    block: { kind: 'action', action: 'runCommand', fields: { command: "echo 'PreToolUse hook ran'" } },
    selectId: 'PreToolUse/0/0',
  });

  // The edit adds a new last group. The group that was there stays as it was.
  const readGroup = LOCAL.replace('"Bash"', '"Read"');
  const added = starter(readGroup, 'PreToolUse')!;
  expect(added.selectId).toBe('PreToolUse/1/0');
  const groups = JSON.parse(saveRequestOf(edited(openTab('localSettings', opened(readGroup)), { kind: 'add', place: added.place, block: added.block }))!.newText).hooks.PreToolUse;
  expect(groups).toHaveLength(2);
  expect(groups[0]).toEqual({ matcher: 'Read', hooks: [{ type: 'command', command: 'echo first' }] });
  expect(groups[1].matcher).toBe('Bash');

  // A group with the same "Only when" is already there. The starter joins it as its last hook, and the id points at that new hook.
  expect(starter(LOCAL, 'PreToolUse')?.selectId).toBe('PreToolUse/0/1');
  expect(starter('{ "hooks": { "Stop": [ { "hooks": [{ "type": "command", "command": "echo a" }] } ] } }', 'Stop')?.selectId).toBe('Stop/0/1');
});

it('puts events in the palette order, and unknown events last in file order', () => {
  const names = (events: string[]) => inEventOrder(events.map((event) => ({ event }))).map((item) => item.event);
  expect(names(['Stop', 'Zebra', 'SessionStart', 'Apple', 'PreToolUse'])).toEqual(['PreToolUse', 'SessionStart', 'Stop', 'Zebra', 'Apple']);
});
