// @vitest-environment node

/**
 * The compatibility table is the one place that says which hook types,
 * matchers, "Narrow to" rules and Then answers each Claude Code event takes.
 * The palette, the drop slots and the reducer all read it, so these tests
 * pin it to the SDK event list and to the counts in the 2026-10-08 research.
 */

import { HOOK_EVENTS } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { EVENT_RULES, defaultTimeoutSeconds, eventRule, type EventRule } from '../compatibility';
import {
  HOOK_PACK_COMMAND_REASON,
  READ_ONLY_REASON,
  actionOfEntry,
  buildHookEntry,
  checkAction,
  checkField,
  checkMatcher,
  checkThen,
  settingsScriptOf,
} from '../sourceRules';
import { PLUGIN_ROOT_TOKEN, launcherCommand } from '../thenBlocks';

const TOOL_EVENTS = ['PermissionDenied', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure', 'PreToolUse'];

function eventsWhere(keep: (rule: EventRule) => boolean): string[] {
  return Object.entries(EVENT_RULES)
    .filter(([, rule]) => keep(rule))
    .map(([event]) => event)
    .sort();
}

describe.skipIf(process.platform === 'win32')('compatibility table', () => {
  it('lists exactly the SDK hook events and matches the research counts', () => {
    expect(Object.keys(EVENT_RULES).sort()).toEqual([...HOOK_EVENTS].sort());
    expect(eventsWhere((rule) => rule.hookTypes.length === 5)).toHaveLength(12);
    expect(eventsWhere((rule) => rule.matcher.kind === 'none')).toHaveLength(10);
    expect(eventsWhere((rule) => rule.matcher.kind === 'toolName')).toEqual(TOOL_EVENTS);
    expect(eventsWhere((rule) => rule.ifRuns)).toEqual(TOOL_EVENTS);
    expect(eventsWhere((rule) => rule.exit2Blocks)).toHaveLength(16);
    expect(eventsWhere((rule) => rule.thenAnswers.includes('stopClaude'))).toEqual([
      'PostToolBatch',
      'TaskCompleted',
      'TeammateIdle',
    ]);
    expect(eventsWhere((rule) => rule.thenAnswers.includes('permission'))).toEqual(['PreToolUse']);
    expect(EVENT_RULES.Setup.hookTypes).toEqual(['command']);
    expect(EVENT_RULES.SessionStart.hookTypes).toEqual(['command', 'mcp_tool']);
    expect(EVENT_RULES.DirectoryAdded.thenAnswers).toEqual([]);
    expect(eventRule('NotAnEvent')).toBeNull();
  });

  it('uses the event default timeout before the hook type default', () => {
    expect(defaultTimeoutSeconds('PreToolUse', 'command')).toBe(600);
    expect(defaultTimeoutSeconds('PreToolUse', 'prompt')).toBe(30);
    expect(defaultTimeoutSeconds('Stop', 'agent')).toBe(60);
    expect(defaultTimeoutSeconds('UserPromptSubmit', 'command')).toBe(30);
    expect(defaultTimeoutSeconds('MessageDisplay', 'http')).toBe(10);
  });
});

describe.skipIf(process.platform === 'win32')('source rules', () => {
  it('allows each action only where Claude Code and the source take it', () => {
    expect(checkAction('userSettings', 'PreToolUse', 'runCommand', { command: 'echo hi' })).toBeNull();
    expect(checkAction('hookPackDraft', 'PreToolUse', 'runCommand', { command: 'echo hi' })).toBe(HOOK_PACK_COMMAND_REASON);
    expect(checkAction('readOnly', 'PreToolUse', 'runCommand', { command: 'echo hi' })).toBe(READ_ONLY_REASON);
    expect(checkAction('projectSettings', 'SessionStart', 'askAi', { prompt: 'ok?' })).toMatch(/SessionStart/);
    // "Run an agent" needs the prompt field that the SDK requires on agent hooks.
    expect(checkAction('localSettings', 'Stop', 'runAgent', {})).toEqual(expect.any(String));
    expect(checkAction('localSettings', 'Stop', 'runAgent', { prompt: 'Check that the tests ran' })).toBeNull();
    // "Narrow to" (if) runs on tool events only.
    expect(checkAction('userSettings', 'Stop', 'runCommand', { command: 'echo hi', if: 'Bash(git *)' })).toMatch(/Stop/);
    expect(checkAction('userSettings', 'PreToolUse', 'runCommand', { command: 'echo hi', if: 'Bash(git *)' })).toBeNull();
    expect(checkAction('userSettings', 'PreToolUse', 'sendToWeb', { url: 'not a web address' })).toEqual(expect.any(String));
    expect(checkAction('userSettings', 'PreToolUse', 'runCommand', { command: 'echo hi', model: 'x' })).toEqual(expect.any(String));
    // A guard hook keeps timeout 30, and a script path never holds a quote.
    expect(checkAction('hookPackDraft', 'PreToolUse', 'runScript', { script: 'hooks/check.py', timeout: 60 })).toEqual(expect.any(String));
    // Removing the timeout from a guard hook is refused too (ADR 0001).
    expect(checkField('hookPackDraft', 'PreToolUse', 'runScript', 'timeout', undefined)).toEqual(expect.any(String));
    expect(checkField('userSettings', 'PreToolUse', 'runScript', 'timeout', undefined)).toBeNull();
    expect(checkAction('hookPackDraft', 'PreToolUse', 'runScript', { script: "hooks/it's.py" })).toEqual(expect.any(String));
    expect(checkMatcher('Stop', 'Bash')).toMatch(/Stop/);
    expect(checkMatcher('Stop', null)).toBeNull();
    expect(checkMatcher('PreToolUse', 'Edit|Write')).toBeNull();
    expect(checkThen('userSettings', 'Stop', { answer: 'stopClaude', message: 'done' })).toMatch(/Stop/);
    expect(checkThen('userSettings', 'TaskCompleted', { answer: 'stopClaude', message: 'done' })).toBeNull();
    expect(checkThen('userSettings', 'SessionStart', { answer: 'watchFiles', paths: ['.env'] })).toEqual(expect.any(String));
    expect(checkThen('userSettings', 'PreToolUse', { answer: 'permission', decision: 'deny', message: ' ' })).toEqual(expect.any(String));
  });

  it('builds hook entries and reads the action back', () => {
    const launcher = '/data/hook-plugins/runtime/run-hook';
    expect(buildHookEntry('userSettings', 'Stop', 'runAgent', { prompt: 'Check' }, null)).toEqual({ type: 'agent', prompt: 'Check' });

    const guard = buildHookEntry('hookPackDraft', 'PreToolUse', 'runScript', { script: 'hooks/check.py' }, launcher);
    expect(guard).toEqual({ type: 'command', command: launcherCommand(launcher, 'hooks/check.py', true), timeout: 30 });
    const plain = buildHookEntry('hookPackDraft', 'PostToolUse', 'runScript', { script: 'hooks/log.py', statusMessage: 'Logging' }, launcher);
    expect(plain).toEqual({ type: 'command', command: launcherCommand(launcher, 'hooks/log.py', false), statusMessage: 'Logging' });

    expect(actionOfEntry('hookPackDraft', guard, launcher)).toBe('runScript');
    // The hook builder writes non-guard hooks in exec form. The hook editor still reads them.
    const execForm = { type: 'command', command: launcher, args: [`${PLUGIN_ROOT_TOKEN}/hooks/log.py`] };
    expect(actionOfEntry('hookPackDraft', execForm, launcher)).toBe('runScript');
    expect(actionOfEntry('userSettings', { type: 'command', command: 'python3 ~/.claude/hooks/model-gate-git.py' }, null)).toBe('runScript');
    expect(actionOfEntry('userSettings', { type: 'command', command: 'echo hi' }, null)).toBe('runCommand');
    expect(actionOfEntry('userSettings', { type: 'mcp_tool', server: 'memory', tool: 'load' }, null)).toBe('callMcpTool');
    expect(settingsScriptOf('"$CLAUDE_PROJECT_DIR"/.claude/hooks/check.sh --fast')).toBe('$CLAUDE_PROJECT_DIR/.claude/hooks/check.sh');
  });
});
