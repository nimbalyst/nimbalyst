/**
 * NIM-806 Phase 4 (Direction A) — the `--settings` PreToolUse-hook payload and
 * the Electron-as-Node hook command. `--permission-prompt-tool` is ignored by the
 * interactive CLI; a PreToolUse hook is the mechanism that works interactively.
 */

import { describe, it, expect } from 'vitest';
import {
  buildPermissionHookSettings,
  buildPermissionHookSettingsJson,
  buildElectronNodeHookCommand,
  PERMISSION_HOOK_MATCHER,
  PERMISSION_HOOK_TIMEOUT_SEC,
} from '../claudeCliPermissionHookConfig';

describe('buildPermissionHookSettings', () => {
  it('registers a single PreToolUse command hook with the default matcher + timeout', () => {
    const s = buildPermissionHookSettings({ command: 'run-hook' });
    expect(s.hooks.PreToolUse).toHaveLength(1);
    const entry = s.hooks.PreToolUse[0];
    expect(entry.matcher).toBe(PERMISSION_HOOK_MATCHER);
    expect(entry.hooks[0]).toEqual({ type: 'command', command: 'run-hook', timeout: PERMISSION_HOOK_TIMEOUT_SEC });
  });

  it('matcher covers the prompting built-ins but not read-only tools', () => {
    expect(PERMISSION_HOOK_MATCHER).toContain('Bash');
    expect(PERMISSION_HOOK_MATCHER).toContain('Edit');
    expect(PERMISSION_HOOK_MATCHER).toContain('Write');
    expect(PERMISSION_HOOK_MATCHER).not.toContain('Read');
    expect(PERMISSION_HOOK_MATCHER).not.toContain('Grep');
  });

  it('honors custom matcher + timeout', () => {
    const s = buildPermissionHookSettings({ command: 'x', matcher: 'Bash', timeoutSec: 30 });
    expect(s.hooks.PreToolUse[0].matcher).toBe('Bash');
    expect(s.hooks.PreToolUse[0].hooks[0].timeout).toBe(30);
  });

  it('JSON form round-trips', () => {
    const json = buildPermissionHookSettingsJson({ command: 'c' });
    expect(JSON.parse(json)).toEqual(buildPermissionHookSettings({ command: 'c' }));
  });
});

describe('buildElectronNodeHookCommand', () => {
  it('runs the script under Electron-as-Node with quoted paths', () => {
    const cmd = buildElectronNodeHookCommand('/Apps/My App/electron', '/Apps/My App/resources/hook.cjs');
    expect(cmd).toBe('ELECTRON_RUN_AS_NODE=1 "/Apps/My App/electron" "/Apps/My App/resources/hook.cjs"');
  });
});
