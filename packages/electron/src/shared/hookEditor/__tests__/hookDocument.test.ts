// @vitest-environment node

/**
 * One realistic settings file runs through open, edit, write, checks and
 * history. The Stop group uses the layout that jsonc-parser writes, so an
 * insertion there must change no other byte. The PreToolUse hooks sit one per
 * line, the way people write them by hand, beside a hook type the editor does
 * not know.
 */

import { describe, expect, it } from 'vitest';

import {
  NOT_PLAIN_JSON_REASON,
  findHook,
  openHookDocument,
  readBlocks,
  type HookDocument,
  type HookKey,
  type OpenOptions,
} from '../hookDocument';
import { runChecks } from '../hookChecks';
import { applyEdit, pausedHookInFile, type HookEdit } from '../hookEdits';
import { hasUnsavedChanges, markSaved, record, redo, startHistory, undo } from '../hookHistory';
import { baseOf, writeDocument, type WriteBase } from '../hookWriter';
import { GUARD_LINE_REASON } from '../sourceRules';
import { launcherCommand, settingsThenEntry, stripThenHeader, thenScriptText } from '../thenBlocks';
import type { JsonObject, ThenBlock } from '../types';

const SETTINGS = `{
  "permissions": { "allow": ["Bash(git status)"], "deny": [] },
  "env": { "LOG_LEVEL": "debug" },
  "model": "opus",
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": "python3 ~/.claude/hooks/model-gate-git.py", "timeout": 10, "futureField": true },
          { "type": "command", "command": "echo two" },
          { "type": "wasm", "module": "x.wasm" }
        ]
      }
    ],
    "SessionStart": [
      {
        "matcher": "startup",
        "hooks": [
          {
            "type": "mcp_tool",
            "server": "memory",
            "tool": "load"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "prompt",
            "prompt": "Did Claude finish the task?"
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "http",
            "url": "https://example.com/hook",
            "allowedEnvVars": [
              "API_TOKEN"
            ]
          },
          {
            "type": "agent",
            "prompt": "Check the prompt for secrets"
          }
        ]
      }
    ]
  }
}
`;

function open(text: string, options: OpenOptions = { source: 'userSettings' }): HookDocument {
  const result = openHookDocument(text, options);
  if (!result.ok) throw new Error(result.reason);
  return result.document;
}

const BASE: WriteBase = { text: SETTINGS, scripts: {} };

/** The SETTINGS document with the hooks value of other text. The writer must turn SETTINGS into that text. */
function withHooksOf(text: string): HookDocument {
  return { ...open(SETTINGS), hooks: open(text).hooks };
}

/** True when every byte of `before` is still in `after`, as one prefix and one suffix. */
function insertedOnly(before: string, after: string): boolean {
  let start = 0;
  while (start < before.length && before[start] === after[start]) start += 1;
  return after.length > before.length && after.endsWith(before.slice(start));
}

const ONE_MORE_STOP_HOOK = SETTINGS.replace(
  '"Did Claude finish the task?"\n          }',
  '"Did Claude finish the task?"\n          },\n          { "type": "prompt", "prompt": "Did Claude stop early?" }',
);

function key(event: string, groupIndex: number, matcher: string | null, hookIndex: number): HookKey {
  return { event, groupIndex, matcher, hookIndex };
}

function edit(doc: HookDocument, change: HookEdit): HookDocument {
  const result = applyEdit(doc, change);
  if (!result.ok) throw new Error(result.reason);
  return result.document;
}

/** Checks that an edit is refused and leaves the document as it was. Returns the reason. */
function refused(doc: HookDocument, change: HookEdit): string {
  const result = applyEdit(doc, change);
  expect(result.ok).toBe(false);
  expect(result.document).toBe(doc);
  return result.ok ? '' : result.reason;
}

function actionsOf(doc: HookDocument, eventIndex: number): string[] {
  return readBlocks(doc)[eventIndex].groups[0].hooks.map((hook) => (hook.kind === 'action' ? hook.action : hook.kind));
}

describe.skipIf(process.platform === 'win32')('hook document', () => {
  it('reads a settings file into event, group and hook blocks', () => {
    const blocks = readBlocks(open(SETTINGS));
    const summary = blocks.map((event) => [
      event.id,
      event.groups.map((group) => [group.matcher, group.hooks.map((hook) => (hook.kind === 'action' ? hook.action : hook.kind))]),
    ]);
    expect(summary).toEqual([
      ['PreToolUse', [['Bash', ['runScript', 'runCommand', 'opaque']]]],
      ['SessionStart', [['startup', ['callMcpTool']]]],
      ['Stop', [[null, ['askAi']]]],
      ['UserPromptSubmit', [[null, ['sendToWeb', 'runAgent']]]],
    ]);
    const first = blocks[0].groups[0].hooks[0];
    expect(first.id).toBe('PreToolUse/0/0');
    expect(first.kind === 'action' ? first.extraFields : null).toEqual(['futureField']);
  });

  it('refuses text that is not plain JSON and keeps a broken hooks value read-only', () => {
    const refused = { ok: false, reason: NOT_PLAIN_JSON_REASON };
    expect(openHookDocument('{\n  // note\n  "model": "opus"\n}', { source: 'userSettings' })).toEqual(refused);
    expect(openHookDocument('{ "model": "opus", }', { source: 'userSettings' })).toEqual(refused);
    expect(openHookDocument('[1]', { source: 'userSettings' }).ok).toBe(false);
    expect(openHookDocument('{}', { source: 'hookPackDraft' }).ok).toBe(false);
    expect(open('{"hooks": []}').hooksProblem).toEqual(expect.any(String));
    expect(readBlocks(open(''))).toEqual([]);

    const doc = open(SETTINGS);
    expect(findHook(doc, { event: 'PreToolUse', groupIndex: 0, matcher: 'Bash', hookIndex: 1 })).toEqual({
      type: 'command',
      command: 'echo two',
    });
    expect(findHook(doc, { event: 'PreToolUse', groupIndex: 0, matcher: 'Edit', hookIndex: 1 })).toBeUndefined();
  });
});

describe.skipIf(process.platform === 'win32')('hook writer', () => {
  // The gate for the jsonc-parser approach. If this test fails, stop and report. Do not change the test.
  it('adds one hook and changes no other byte', () => {
    const result = writeDocument(BASE, withHooksOf(ONE_MORE_STOP_HOOK));
    expect(JSON.parse(result.text)).toEqual(JSON.parse(ONE_MORE_STOP_HOOK));
    expect(insertedOnly(SETTINGS, result.text)).toBe(true);
  });

  it('keeps CRLF and tab indentation', () => {
    const tabs =
      '{\r\n\t"model": "opus",\r\n\t"hooks": {\r\n\t\t"Stop": [\r\n\t\t\t{\r\n\t\t\t\t"hooks": [\r\n' +
      '\t\t\t\t\t{\r\n\t\t\t\t\t\t"type": "prompt",\r\n\t\t\t\t\t\t"prompt": "Done?"\r\n\t\t\t\t\t}\r\n' +
      '\t\t\t\t]\r\n\t\t\t}\r\n\t\t]\r\n\t}\r\n}\r\n';
    const hooks: JsonObject = {
      Stop: [{ hooks: [{ type: 'prompt', prompt: 'Done?' }, { type: 'command', command: 'echo hi' }] }],
      PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'echo edited' }] }],
    };
    const { text } = writeDocument({ text: tabs, scripts: {} }, { ...open(tabs), hooks });
    expect(JSON.parse(text).hooks).toEqual(hooks);
    expect(text.startsWith('{\r\n\t"model": "opus",\r\n')).toBe(true);
    expect(text).not.toMatch(/[^\r]\n/);
    expect(text).not.toMatch(/\n +/);
  });

  it('maps lines to blocks and leaves an unchanged file alone', () => {
    const result = writeDocument(BASE, withHooksOf(ONE_MORE_STOP_HOOK));
    const lines = result.text.split('\n');
    const blockAt = (needle: string) => result.lineMap[lines.findIndex((line) => line.includes(needle))];
    expect(blockAt('Did Claude stop early?')).toBe('Stop/0/1');
    expect(blockAt('"matcher": "Bash"')).toBe('PreToolUse/0');
    expect(blockAt('"UserPromptSubmit"')).toBe('UserPromptSubmit');
    expect(blockAt('"permissions"')).toBeNull();
    // A line diff pairs the old closing brace with the new last brace, so the
    // insert reads as 4 added lines and no changed line.
    expect(result.diff).toMatchObject({ added: 4, changed: 0, removed: 0 });

    expect(writeDocument(BASE, open(SETTINGS))).toMatchObject({
      text: SETTINGS,
      scriptWrites: [],
      diff: { added: 0, changed: 0, removed: 0 },
    });
    // An empty file with no hooks stays empty: no "hooks": {} appears.
    expect(writeDocument({ text: '', scripts: {} }, { ...open(''), hooks: {} }).text).toBe('');
  });

  it('removes, moves and adds hooks without changing the text of any other hook', () => {
    // JSON.parse cannot keep this number text: 5.0 reads as 5, and the long id loses digits.
    const precise = SETTINGS.replace('"echo two" }', '"echo two", "timeout": 5.0, "id": 12345678901234567890 }');
    const base: WriteBase = { text: precise, scripts: {} };
    const doc = open(precise);
    const lineWith = (needle: string) => precise.split('\n').find((line) => line.includes(needle)) as string;
    const [gate, two, wasm] = [lineWith('model-gate'), lineWith('echo two'), lineWith('x.wasm')];

    const removed = edit(doc, { kind: 'remove', key: key('PreToolUse', 0, 'Bash', 0) });
    expect(writeDocument(base, removed).text).toBe(precise.replace(`${gate}\n`, ''));
    const moved = edit(doc, { kind: 'move', key: key('PreToolUse', 0, 'Bash', 0), to: { event: 'PreToolUse', matcher: 'Bash', index: 1 } });
    expect(writeDocument(base, moved).text).toBe(precise.replace(`${gate}\n${two}`, `${two}\n${gate}`));
    const lastRemoved = edit(doc, { kind: 'remove', key: key('UserPromptSubmit', 0, null, 1) });
    const agent = ',\n          {\n            "type": "agent",\n            "prompt": "Check the prompt for secrets"\n          }';
    expect(writeDocument(base, lastRemoved).text).toBe(precise.replace(agent, ''));
    const added = edit(doc, {
      kind: 'add',
      place: { event: 'PreToolUse', matcher: 'Bash' },
      block: { kind: 'action', action: 'runCommand', fields: { command: 'echo four' } },
    });
    expect(writeDocument(base, added).text).toContain(`${wasm.trimEnd()},\n`);
  });
});

describe.skipIf(process.platform === 'win32')('hook edits', () => {
  it('adds, moves and copies blocks only where they fit', () => {
    const doc = open(SETTINGS);
    const added = edit(doc, {
      kind: 'add',
      place: { event: 'Stop', matcher: null },
      block: { kind: 'action', action: 'askAi', fields: { prompt: 'Did Claude stop early?' } },
    });
    expect(writeDocument(BASE, added).text).toBe(writeDocument(BASE, withHooksOf(ONE_MORE_STOP_HOOK)).text);

    const moved = edit(doc, { kind: 'move', key: key('PreToolUse', 0, 'Bash', 1), to: { event: 'PreToolUse', matcher: 'Bash', index: 0 } });
    expect(actionsOf(moved, 0)).toEqual(['runCommand', 'runScript', 'opaque']);
    expect(refused(doc, { kind: 'move', key: key('Stop', 0, null, 0), to: { event: 'SessionStart', matcher: 'startup' } })).toMatch(/SessionStart/);

    // A Then block made again for the new event: the event name is part of its answer.
    const then: ThenBlock = { answer: 'addContext', message: `Read "CLAUDE.md" first; don't guess $(whoami)` };
    const withThen = edit(doc, { kind: 'add', place: { event: 'PreToolUse', matcher: 'Bash' }, block: { kind: 'then', then } });
    const thenKey = key('PreToolUse', 0, 'Bash', 3);
    const copied = edit(withThen, { kind: 'copy', key: thenKey, to: { event: 'PostToolUse', matcher: 'Edit' } });
    expect(findHook(copied, thenKey)).toEqual(settingsThenEntry('PreToolUse', then));
    expect(findHook(copied, key('PostToolUse', 0, 'Edit', 0))).toEqual(settingsThenEntry('PostToolUse', then));
    expect(refused(withThen, { kind: 'copy', key: thenKey, to: { event: 'PermissionRequest', matcher: 'Bash' } })).toMatch(
      /PermissionRequest/,
    );
  });

  it('picks one of two groups with the same matcher, and changes a matcher in place', () => {
    const twoBashGroups = SETTINGS.replace(
      '      }\n    ],\n    "SessionStart"',
      '      },\n      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "echo second group" }] }\n    ],\n    "SessionStart"',
    );
    const doc = open(twoBashGroups);
    const base = baseOf(twoBashGroups, doc);

    const moved = edit(doc, { kind: 'move', key: key('PreToolUse', 0, 'Bash', 1), to: { event: 'PreToolUse', matcher: 'Bash', groupIndex: 1 } });
    expect(findHook(moved, key('PreToolUse', 1, 'Bash', 1))).toEqual({ type: 'command', command: 'echo two' });
    expect(findHook(moved, key('PreToolUse', 0, 'Bash', 1))).toEqual({ type: 'wasm', module: 'x.wasm' });
    // The group must still have the matcher the screen saw, and must still be there.
    expect(refused(doc, { kind: 'add', place: { event: 'PreToolUse', matcher: 'Edit', groupIndex: 1 }, block: { kind: 'action', action: 'runCommand', fields: { command: 'echo x' } } })).toMatch(/not at that place/);
    expect(refused(doc, { kind: 'move', key: key('PreToolUse', 0, 'Bash', 1), to: { event: 'PreToolUse', matcher: 'Bash', groupIndex: 5 } })).toMatch(/not at that place/);

    const changed = edit(doc, { kind: 'setMatcher', event: 'PreToolUse', groupIndex: 1, matcher: 'Edit|Write' });
    expect(writeDocument(base, changed).text).toBe(
      twoBashGroups.replace('{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "echo second group" }] }', '{ "matcher": "Edit|Write", "hooks": [{ "type": "command", "command": "echo second group" }] }'),
    );
    expect(refused(doc, { kind: 'setMatcher', event: 'Stop', groupIndex: 0, matcher: 'x' })).toMatch(/takes no "Only when" block/);
    expect(refused(doc, { kind: 'setMatcher', event: 'PreToolUse', groupIndex: 9, matcher: 'Bash' })).toMatch(/not at that place/);
  });

  it('cleans up empty groups and events and keeps every other key', () => {
    let doc = open(SETTINGS);
    doc = edit(doc, { kind: 'remove', key: key('SessionStart', 0, 'startup', 0) });
    doc = edit(doc, { kind: 'remove', key: key('Stop', 0, null, 0) });
    const text = writeDocument(BASE, doc).text;
    const { hooks, ...rest } = JSON.parse(text);
    const { hooks: oldHooks, ...oldRest } = JSON.parse(SETTINGS);
    expect(rest).toEqual(oldRest);
    expect(Object.keys(hooks)).toEqual(['PreToolUse', 'UserPromptSubmit']);
    expect(hooks.PreToolUse).toEqual(oldHooks.PreToolUse);
    expect(text).toContain('  "permissions": { "allow": ["Bash(git status)"], "deny": [] },\n');
    expect(text).toContain('          { "type": "wasm", "module": "x.wasm" }\n');

    // Two identical hooks: removing the second keeps the first. Removing the last keeps "hooks": {}.
    const echo = { type: 'command', command: 'echo a' };
    const twins = JSON.stringify({ hooks: { Stop: [{ hooks: [echo, echo] }] } }, null, 2);
    const one = edit(open(twins), { kind: 'remove', key: key('Stop', 0, null, 1) });
    expect(JSON.parse(writeDocument({ text: twins, scripts: {} }, one).text)).toEqual({ hooks: { Stop: [{ hooks: [echo] }] } });
    const none = edit(one, { kind: 'remove', key: key('Stop', 0, null, 0) });
    expect(JSON.parse(writeDocument({ text: twins, scripts: {} }, none).text)).toEqual({ hooks: {} });
  });

  it('keeps an opaque hook untouched beside an edited one', () => {
    const doc = open(SETTINGS);
    const changed = edit(doc, { kind: 'setField', key: key('PreToolUse', 0, 'Bash', 0), name: 'timeout', value: 20 });
    expect(writeDocument(BASE, changed).text).toBe(SETTINGS.replace('"timeout": 10', '"timeout": 20'));

    const wasm = key('PreToolUse', 0, 'Bash', 2);
    const opaqueEdits: HookEdit[] = [
      { kind: 'remove', key: wasm },
      { kind: 'move', key: wasm, to: { event: 'PreToolUse', matcher: 'Bash', index: 0 } },
      { kind: 'copy', key: wasm, to: { event: 'PostToolUse', matcher: 'Bash' } },
      { kind: 'setField', key: wasm, name: 'timeout', value: 5 },
      { kind: 'pause', key: wasm },
    ];
    for (const change of opaqueEdits) refused(doc, change);
  });

  it('pauses and resumes a hook, and refuses edits on a broken hooks value', () => {
    const doc = open(SETTINGS);
    const paused = edit(doc, { kind: 'pause', key: key('UserPromptSubmit', 0, null, 1) });
    expect(paused.paused).toEqual([
      { event: 'UserPromptSubmit', matcher: null, entry: { type: 'agent', prompt: 'Check the prompt for secrets' } },
    ]);
    expect(writeDocument(BASE, paused).text).not.toContain('Check the prompt for secrets');
    const resumed = edit(paused, { kind: 'resume', pausedIndex: 0 });
    expect(resumed.paused).toEqual([]);
    expect(writeDocument(BASE, resumed).text).toBe(SETTINGS);

    // A restored backup can bring a paused hook back into the file. Turning it on then only clears the tray.
    const alsoInFile: HookDocument = { ...paused, hooks: doc.hooks };
    expect(pausedHookInFile(paused, paused.paused[0])).toBe(false);
    expect(pausedHookInFile(alsoInFile, alsoInFile.paused[0])).toBe(true);
    const cleared = edit(alsoInFile, { kind: 'resume', pausedIndex: 0 });
    expect(cleared.paused).toEqual([]);
    expect(writeDocument(BASE, cleared).text).toBe(SETTINGS);

    refused(open('{"hooks": []}'), {
      kind: 'add',
      place: { event: 'Stop', matcher: null },
      block: { kind: 'action', action: 'runCommand', fields: { command: 'echo hi' } },
    });
  });

  it('keeps hook pack Then blocks in generated scripts until the user takes one over', () => {
    const launcher = '/data/hook-plugins/runtime/run-hook';
    // The first generated name is taken on disk already, so the new script gets the second one.
    const pack = open('{}', { source: 'hookPackDraft', launcherPath: launcher, scriptTexts: { 'hooks/then_pre_tool_use_1.py': 'print(1)\n' } });
    refused(pack, {
      kind: 'add',
      place: { event: 'PreToolUse', matcher: 'Bash' },
      block: { kind: 'action', action: 'runCommand', fields: { command: 'echo hi' } },
    });

    const deny: ThenBlock = { answer: 'permission', decision: 'deny', message: 'No force push' };
    const ask: ThenBlock = { answer: 'permission', decision: 'ask', message: 'No force push' };
    const path = 'hooks/then_pre_tool_use_2.py';
    const thenKey = key('PreToolUse', 0, 'Bash', 0);
    const added = edit(pack, { kind: 'add', place: { event: 'PreToolUse', matcher: 'Bash' }, block: { kind: 'then', then: deny } });
    expect(findHook(added, thenKey)).toEqual({ type: 'command', command: launcherCommand(launcher, path, true), timeout: 30 });
    expect(writeDocument(baseOf('{}', pack), added).scriptWrites).toEqual([{ path, text: thenScriptText('PreToolUse', deny) }]);

    const changed = edit(added, { kind: 'setThen', key: thenKey, then: ask });
    expect(changed.scripts[path]).toBe(thenScriptText('PreToolUse', ask));
    expect(refused(changed, { kind: 'move', key: thenKey, to: { event: 'PostToolUse', matcher: 'Bash' } })).toBe(GUARD_LINE_REASON);

    const owned = edit(changed, { kind: 'turnIntoScript', key: thenKey });
    expect(actionsOf(owned, 0)).toEqual(['runScript']);
    expect(owned.scripts[path]).toBe(stripThenHeader(thenScriptText('PreToolUse', ask)));
    refused(owned, { kind: 'setThen', key: thenKey, then: deny });

    // A new script on PreToolUse turns an exec form hook into a guard, so its time limit becomes 30 s.
    const execForm = { type: 'command', command: launcher, args: ['${CLAUDE_PLUGIN_ROOT}/hooks/old.py'], timeout: 10 };
    const execPack = open(JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [execForm] }] } }), {
      source: 'hookPackDraft',
      launcherPath: launcher,
    });
    const guarded = edit(execPack, { kind: 'setField', key: thenKey, name: 'script', value: 'hooks/new.py' });
    expect(findHook(guarded, thenKey)).toEqual({ type: 'command', command: launcherCommand(launcher, 'hooks/new.py', true), timeout: 30 });
  });
});

describe.skipIf(process.platform === 'win32')('hook checks', () => {
  it('runs the JSON, schema and script checks in order and skips the rest after a failure', () => {
    const doc = open(SETTINGS);
    const statusesOf = (text: string) =>
      runChecks({ text, document: doc, scriptWrites: [], fileExists: () => true }).map((result) => result.status);
    expect(statusesOf(SETTINGS)).toEqual(['passed', 'passed', 'passed']);
    expect(statusesOf('{ "hooks": ')).toEqual(['failed', 'skipped', 'skipped']);
    expect(statusesOf('{"hooks": {"Stop": [{"hooks": [{"type": "command"}]}]}}')).toEqual(['passed', 'failed', 'skipped']);

    const missing = runChecks({ text: SETTINGS, document: doc, scriptWrites: [], fileExists: () => false });
    expect(missing[2]).toEqual({
      check: 'scripts',
      status: 'failed',
      problems: [expect.stringContaining('~/.claude/hooks/model-gate-git.py')],
    });

    // A Then script that the save will write counts as present.
    const draft = open('{}', { source: 'hookPackDraft', launcherPath: '/data/hook-plugins/runtime/run-hook' });
    const pack = edit(draft, {
      kind: 'add',
      place: { event: 'Stop', matcher: null },
      block: { kind: 'then', then: { answer: 'block', message: 'Run the tests first' } },
    });
    const written = writeDocument(baseOf('{}', draft), pack);
    const pending = { text: written.text, document: pack, fileExists: () => false };
    expect(runChecks({ ...pending, scriptWrites: written.scriptWrites })[2].status).toBe('passed');
    expect(runChecks({ ...pending, scriptWrites: [] })[2].status).toBe('failed');
  });

  it('words each schema problem the same way, in the order the file holds them', () => {
    const doc = open(SETTINGS);
    const problemsOf = (hooks: unknown) =>
      runChecks({ text: JSON.stringify({ hooks }), document: doc, scriptWrites: [], fileExists: () => true })[1].problems;

    expect(problemsOf(5)).toEqual(['"hooks" must be an object.']);
    expect(problemsOf({ Stop: 3 })).toEqual(['hooks.Stop must be a list.']);
    expect(problemsOf({ Stop: [3, { hooks: 1, matcher: 2 }] })).toEqual([
      'hooks.Stop[0] must be an object with a "hooks" list.',
      'hooks.Stop[1] must be an object with a "hooks" list.',
    ]);
    expect(
      problemsOf({
        Stop: [
          {
            matcher: 5,
            hooks: [
              { type: 'command' },
              { command: 'x' },
              { type: 'http', url: '', timeout: 0 },
              { type: 'future', timeout: 'x' },
              { type: 'command', command: 'x', timeout: 2 },
            ],
          },
        ],
        Other: [{ hooks: [{ type: 'prompt', prompt: 'p', timeout: -1 }] }],
      }),
    ).toEqual([
      'hooks.Stop[0].matcher must be text.',
      'hooks.Stop[0].hooks[0] needs "command".',
      'hooks.Stop[0].hooks[1] needs a "type".',
      'hooks.Stop[0].hooks[2] needs "url".',
      'hooks.Stop[0].hooks[2].timeout must be a number of seconds above 0.',
      'hooks.Stop[0].hooks[3].timeout must be a number of seconds above 0.',
      'hooks.Other[0].hooks[0].timeout must be a number of seconds above 0.',
    ]);
    // Unknown events and unknown hook types pass.
    expect(problemsOf({ FutureEvent: [{ hooks: [{ type: 'future' }] }] })).toEqual([]);
  });
});

describe.skipIf(process.platform === 'win32')('tab history', () => {
  it('turns an undo after a save into a new unsaved change, and a reload starts fresh', () => {
    const doc = open(SETTINGS);
    let history = startHistory(doc, BASE);
    expect(hasUnsavedChanges(history)).toBe(false);
    // A refused edit returns the same document, and the history stays the same.
    expect(record(history, doc)).toBe(history);

    const added = edit(doc, {
      kind: 'add',
      place: { event: 'Stop', matcher: null },
      block: { kind: 'action', action: 'askAi', fields: { prompt: 'Did Claude stop early?' } },
    });
    history = record(history, added);
    expect(hasUnsavedChanges(history)).toBe(true);

    const saved = writeDocument(history.base, history.present).text;
    history = markSaved(history, baseOf(saved, history.present));
    expect(hasUnsavedChanges(history)).toBe(false);

    history = undo(history);
    expect(history.present).toBe(doc);
    expect(history.base.text).toBe(saved);
    expect(hasUnsavedChanges(history)).toBe(true);
    expect(JSON.parse(writeDocument(history.base, history.present).text)).toEqual(JSON.parse(SETTINGS));

    history = redo(history);
    expect(history.present).toBe(added);
    expect(hasUnsavedChanges(history)).toBe(false);

    const reloaded = startHistory(open(saved), { text: saved, scripts: {} });
    expect(undo(reloaded)).toBe(reloaded);

    // Pause a hook, then add an identical hook back. The text is the same as on disk, but the paused list is not.
    let paused = startHistory(doc, BASE);
    paused = record(paused, edit(doc, { kind: 'pause', key: key('PreToolUse', 0, 'Bash', 1) }));
    paused = record(paused, edit(paused.present, {
      kind: 'add',
      place: { event: 'PreToolUse', matcher: 'Bash', index: 1 },
      block: { kind: 'action', action: 'runCommand', fields: { command: 'echo two' } },
    }));
    expect(writeDocument(paused.base, paused.present).text).toBe(SETTINGS);
    expect(hasUnsavedChanges(paused)).toBe(true);
    paused = markSaved(paused, baseOf(SETTINGS, paused.present));
    expect(hasUnsavedChanges(paused)).toBe(false);
  });
});
