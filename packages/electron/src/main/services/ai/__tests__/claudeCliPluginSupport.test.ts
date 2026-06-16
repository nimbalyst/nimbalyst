import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  parseClaudeVersion,
  claudeVersionOutputSupportsPluginDir,
  resolveClaudeCliSupportsPluginDir,
  __resetClaudeCliPluginSupportCache,
  MIN_CLAUDE_CLI_VERSION_FOR_PLUGIN_DIR,
} from '../claudeCliPluginSupport';

/**
 * Version gate for `--plugin-dir` (NIM-845). The genuine CLI's `--plugin-dir`
 * flag — the mechanism that loads extension Claude-plugins (namespaced slash
 * commands) into a `claude-code-cli` session — only exists on modern CLIs
 * (≥ 2.1.142). On older CLIs commander rejects the unknown option and the launch
 * fails, so we must detect support by parsing `claude --version` BEFORE passing
 * the flags. Pure (deps injected) so it verifies without spawning a process.
 */
describe('parseClaudeVersion', () => {
  it('parses the `<x.y.z> (Claude Code)` format the CLI emits', () => {
    expect(parseClaudeVersion('2.1.177 (Claude Code)')).toEqual({ major: 2, minor: 1, patch: 177 });
  });

  it('parses a bare semver and tolerates surrounding whitespace/newlines', () => {
    expect(parseClaudeVersion('  1.0.72\n')).toEqual({ major: 1, minor: 0, patch: 72 });
  });

  it('returns null for unparseable output', () => {
    expect(parseClaudeVersion('')).toBeNull();
    expect(parseClaudeVersion('not a version')).toBeNull();
  });
});

describe('claudeVersionOutputSupportsPluginDir', () => {
  it('supports the floor version and anything newer (incl. 2.1.141 and the agents-flags 2.1.142)', () => {
    expect(claudeVersionOutputSupportsPluginDir(`${MIN_CLAUDE_CLI_VERSION_FOR_PLUGIN_DIR} (Claude Code)`)).toBe(true);
    // The flag predates the 2.1.142 `claude agents` batch — 2.1.76..2.1.141 are supported too.
    expect(claudeVersionOutputSupportsPluginDir('2.1.141 (Claude Code)')).toBe(true);
    expect(claudeVersionOutputSupportsPluginDir('2.1.177 (Claude Code)')).toBe(true);
    expect(claudeVersionOutputSupportsPluginDir('3.0.0 (Claude Code)')).toBe(true);
  });

  it('does NOT support versions below the floor (the documented repeated-flag arity is absent)', () => {
    expect(claudeVersionOutputSupportsPluginDir('1.0.72 (Claude Code)')).toBe(false);
    expect(claudeVersionOutputSupportsPluginDir('2.1.75 (Claude Code)')).toBe(false);
    expect(claudeVersionOutputSupportsPluginDir('2.0.99 (Claude Code)')).toBe(false);
  });

  it('treats unparseable version output as unsupported (fail closed)', () => {
    expect(claudeVersionOutputSupportsPluginDir('garbage')).toBe(false);
  });
});

describe('resolveClaudeCliSupportsPluginDir', () => {
  beforeEach(() => __resetClaudeCliPluginSupportCache());

  it('probes `--version` via the injected runner and reports support', () => {
    const runVersionCommand = vi.fn(() => '2.1.177 (Claude Code)');
    expect(resolveClaudeCliSupportsPluginDir('/usr/local/bin/claude', { runVersionCommand })).toBe(true);
    expect(runVersionCommand).toHaveBeenCalledWith('/usr/local/bin/claude');
  });

  it('reports no support for an old CLI', () => {
    const runVersionCommand = vi.fn(() => '1.0.72 (Claude Code)');
    expect(resolveClaudeCliSupportsPluginDir('/opt/old/claude', { runVersionCommand })).toBe(false);
  });

  it('caches per executable (probes once, re-uses the result)', () => {
    const runVersionCommand = vi.fn(() => '2.1.177 (Claude Code)');
    resolveClaudeCliSupportsPluginDir('/usr/local/bin/claude', { runVersionCommand });
    resolveClaudeCliSupportsPluginDir('/usr/local/bin/claude', { runVersionCommand });
    expect(runVersionCommand).toHaveBeenCalledTimes(1);
  });

  it('re-probes when the resolved executable path changes', () => {
    const runVersionCommand = vi.fn((exe: string) => (exe.includes('old') ? '1.0.72' : '2.1.177'));
    expect(resolveClaudeCliSupportsPluginDir('/opt/old/claude', { runVersionCommand })).toBe(false);
    expect(resolveClaudeCliSupportsPluginDir('/usr/local/bin/claude', { runVersionCommand })).toBe(true);
    expect(runVersionCommand).toHaveBeenCalledTimes(2);
  });

  it('fails closed (no support) when the probe throws, and caches the negative', () => {
    const runVersionCommand = vi.fn(() => {
      throw new Error('ENOENT: claude not found');
    });
    expect(resolveClaudeCliSupportsPluginDir('/missing/claude', { runVersionCommand })).toBe(false);
    expect(resolveClaudeCliSupportsPluginDir('/missing/claude', { runVersionCommand })).toBe(false);
    expect(runVersionCommand).toHaveBeenCalledTimes(1);
  });
});
