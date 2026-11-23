// @vitest-environment node

/**
 * A Then block becomes code: an inline command in a settings file, or a small
 * Python script plus a hook launcher call in a hook pack. The user types the
 * message, so these tests run the real shell and the real Python on a message
 * full of quotes and shell characters, and read the answer back as JSON.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { shellQuote } from '../shellQuote';
import {
  hookPackThenEntry,
  readSettingsThen,
  readThenScript,
  scriptOfLauncherCommand,
  settingsThenEntry,
  stripThenHeader,
  thenOutput,
  thenScriptPath,
} from '../thenBlocks';
import type { ThenBlock } from '../types';

const HOSTILE = `it's "done" $(touch /tmp/hook-editor-pwned) \\ back\nnext line`;
const HAS_PYTHON = spawnSync('python3', ['--version']).status === 0;
const dir = mkdtempSync(path.join(tmpdir(), 'hook-then-'));

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function sh(command: string, env: Record<string, string> = {}) {
  return spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8', env: { ...process.env, ...env } });
}

describe.skipIf(process.platform === 'win32')('Then block code', () => {
  it('quotes any text so the shell reads it back unchanged', () => {
    for (const value of ['', 'plain', HOSTILE, "''", '!$HOME`id`', '-n']) {
      expect(sh(`printf '%s' ${shellQuote(value)}`).stdout).toBe(value);
    }
  });

  it('prints the exact answer for a hostile message', () => {
    const cases: Array<[string, ThenBlock]> = [
      ['PreToolUse', { answer: 'permission', decision: 'deny', message: HOSTILE }],
      ['Stop', { answer: 'block', message: HOSTILE }],
      ['TaskCompleted', { answer: 'stopClaude', message: HOSTILE }],
      ['SessionStart', { answer: 'watchFiles', paths: ["/tmp/it's here/.env"] }],
    ];
    for (const [event, then] of cases) {
      const command = settingsThenEntry(event, then).command as string;
      const result = sh(command);
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(thenOutput(event, then));
      expect(readSettingsThen(event, command)).toEqual(then);
    }
    // A command the user wrote by hand is not a Then block, and neither is a
    // Then command read under another event name.
    expect(readSettingsThen('Stop', `echo '{"decision":"block","reason":"x"}'`)).toBeNull();
    const preToolUse = settingsThenEntry('PreToolUse', cases[0][1]).command as string;
    expect(readSettingsThen('PostToolUse', preToolUse)).toBeNull();
  });

  it.skipIf(!HAS_PYTHON)('prints the exact answer for a hostile message from a hook pack script', () => {
    const then: ThenBlock = { answer: 'permission', decision: 'deny', message: HOSTILE };
    const made = hookPackThenEntry('PreToolUse', then, '/opt/run-hook', 'hooks/then_pre_tool_use_1.py');
    const file = path.join(dir, 'then.py');
    writeFileSync(file, made.script.text);
    const result = spawnSync('python3', [file], { input: '{"tool_name":"Bash"}', encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(thenOutput('PreToolUse', then));
    expect(readThenScript(made.script.text)).toEqual({ event: 'PreToolUse', then });
    // A script changed by hand, or one turned into the user's own script, is no longer a Then block.
    expect(readThenScript(`${made.script.text}# my own line\n`)).toBeNull();
    expect(readThenScript(stripThenHeader(made.script.text))).toBeNull();
  });

  it('calls the hook launcher with the guard form only on PreToolUse', () => {
    const folder = path.join(dir, "it's Application Support");
    mkdirSync(folder);
    const launcher = path.join(folder, 'run-hook');
    // A stand-in hook launcher: prints its arguments, then exits with FAKE_EXIT.
    writeFileSync(launcher, ['#!/bin/sh', "printf '%s\\n' \"$@\"", 'exit "$FAKE_EXIT"', ''].join('\n'));
    chmodSync(launcher, 0o755);
    const run = (command: string, fakeExit: string) => sh(command, { CLAUDE_PLUGIN_ROOT: dir, FAKE_EXIT: fakeExit });

    const guard = hookPackThenEntry(
      'PreToolUse', { answer: 'permission', decision: 'deny', message: 'no' }, launcher, 'hooks/then_pre_tool_use_1.py',
    ).entry;
    const plain = hookPackThenEntry(
      'PostToolUse', { answer: 'addContext', message: 'note' }, launcher, 'hooks/then_post_tool_use_1.py',
    ).entry;

    expect(guard.timeout).toBe(30);
    expect(plain.timeout).toBeUndefined();
    expect(run(guard.command as string, '0').stdout.split('\n')).toEqual([
      '--guard', '28', path.join(dir, 'hooks/then_pre_tool_use_1.py'), '',
    ]);
    expect(run(plain.command as string, '0').stdout.split('\n')).toEqual([
      path.join(dir, 'hooks/then_post_tool_use_1.py'), '',
    ]);
    // A failing guard hook blocks (exit 2). Any other hook fails open.
    expect(run(guard.command as string, '1').status).toBe(2);
    expect(run(plain.command as string, '1').status).toBe(1);

    expect(scriptOfLauncherCommand(launcher, guard.command as string)).toBe('hooks/then_pre_tool_use_1.py');
    expect(scriptOfLauncherCommand('/other/run-hook', guard.command as string)).toBeNull();
    expect(thenScriptPath('PreToolUse', new Set(['hooks/then_pre_tool_use_1.py']))).toBe('hooks/then_pre_tool_use_2.py');
  });
});
