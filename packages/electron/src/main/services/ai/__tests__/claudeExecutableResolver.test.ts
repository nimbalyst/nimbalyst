import { describe, it, expect } from 'vitest';
import path from 'path';
import { resolveClaudeExecutablePath, isClaudeExecutableInstalled } from '../claudeExecutableResolver';

const HOME = '/Users/tester';
const LOCAL_BIN = path.join(HOME, '.claude', 'local', 'node_modules', '.bin', 'claude');
const LOCAL_WRAPPER = path.join(HOME, '.claude', 'local', 'claude');
const HOMEBREW = '/opt/homebrew/bin/claude';
const REPO_LOCAL = '/Users/tester/sources/node_modules/.bin/claude';

const make = (existing: string[], enhancedPath?: string) =>
  resolveClaudeExecutablePath({
    homedir: HOME,
    pathExists: (p: string) => existing.includes(p),
    enhancedPath,
    pathDelimiter: ':',
  });

describe('resolveClaudeExecutablePath', () => {
  it('prefers the official ~/.claude/local install over a stale homebrew global', () => {
    // Regression for NIM-806: homebrew had v1.0.123, ~/.claude/local had 2.x.
    const enhancedPath = `${HOME}/.claude/local/node_modules/.bin:/opt/homebrew/bin`;
    expect(make([LOCAL_BIN, HOMEBREW], enhancedPath)).toBe(LOCAL_BIN);
  });

  it('falls back to the ~/.claude/local wrapper when the .bin symlink is absent', () => {
    expect(make([LOCAL_WRAPPER, HOMEBREW])).toBe(LOCAL_WRAPPER);
  });

  it('uses the first claude on the login-shell PATH when no local install exists', () => {
    const enhancedPath = `/opt/homebrew/bin:/usr/local/bin`;
    expect(make([HOMEBREW], enhancedPath)).toBe(HOMEBREW);
  });

  it('does not pick a repo-local node_modules/.bin claude ahead of the official install', () => {
    // The login PATH (home shell) lists ~/.claude/local before any repo bin.
    const enhancedPath = `${HOME}/.claude/local/node_modules/.bin:/Users/tester/sources/node_modules/.bin`;
    expect(make([LOCAL_BIN, REPO_LOCAL], enhancedPath)).toBe(LOCAL_BIN);
  });

  it('falls back to legacy hardcoded locations when PATH yields nothing', () => {
    expect(make([HOMEBREW])).toBe(HOMEBREW);
  });

  it('returns the bare command when nothing is found on disk', () => {
    expect(make([], '/nowhere:/also-nowhere')).toBe('claude');
  });
});

const installed = (existing: string[], enhancedPath?: string) =>
  isClaudeExecutableInstalled({
    homedir: HOME,
    pathExists: (p: string) => existing.includes(p),
    enhancedPath,
    pathDelimiter: ':',
  });

describe('isClaudeExecutableInstalled', () => {
  it('is false when nothing is found on disk or PATH', () => {
    expect(installed([], '/nowhere:/also-nowhere')).toBe(false);
    expect(installed([])).toBe(false);
  });

  it('is true when the official ~/.claude/local install exists', () => {
    expect(installed([LOCAL_BIN])).toBe(true);
  });

  it('is true when claude is found on the login-shell PATH', () => {
    expect(installed([HOMEBREW], '/opt/homebrew/bin:/usr/local/bin')).toBe(true);
  });

  it('is true when only a legacy hardcoded location exists', () => {
    expect(installed([HOMEBREW])).toBe(true);
  });
});

// #684: on Windows the launchable claude is claude.exe/claude.cmd, not the
// extensionless Unix sh-shim npm drops alongside them. The old resolver returned
// the shim, which node-pty cannot spawn (error 193 ERROR_BAD_EXE_FORMAT). Paths
// are built with the same path.join the resolver uses so the strings match on a
// Linux CI runner regardless of separator.
const WIN_HOME = 'C:\\Users\\tester';
const winMake = (existing: string[], enhancedPath?: string) =>
  resolveClaudeExecutablePath({
    homedir: WIN_HOME,
    pathExists: (p: string) => existing.includes(p),
    enhancedPath,
    pathDelimiter: ';',
    platform: 'win32',
  });

describe('resolveClaudeExecutablePath on Windows (#684)', () => {
  const localBinBase = path.join(WIN_HOME, '.claude', 'local', 'node_modules', '.bin', 'claude');
  const dotLocalBase = path.join(WIN_HOME, '.local', 'bin', 'claude');
  const npmGlobalCmd = path.join(WIN_HOME, 'AppData', 'Roaming', 'npm', 'claude') + '.cmd';

  it('prefers claude.cmd over the extensionless sh-shim in ~/.claude/local', () => {
    expect(winMake([localBinBase, localBinBase + '.cmd'])).toBe(localBinBase + '.cmd');
  });

  it('prefers claude.exe over claude.cmd when both exist', () => {
    expect(winMake([localBinBase + '.cmd', localBinBase + '.exe'])).toBe(localBinBase + '.exe');
  });

  it('resolves claude.cmd from ~/.local/bin even when the sh-shim is also present', () => {
    // The exact #684 repro: where claude lists the shim first, next to claude.cmd.
    expect(winMake([dotLocalBase, dotLocalBase + '.cmd'])).toBe(dotLocalBase + '.cmd');
  });

  it('resolves claude.cmd from the Windows npm-global dir (AppData/Roaming/npm)', () => {
    expect(winMake([npmGlobalCmd])).toBe(npmGlobalCmd);
  });

  it('resolves claude.exe from a PATH entry', () => {
    const dir = 'C:\\tools\\bin';
    expect(winMake([path.join(dir, 'claude') + '.exe'], dir)).toBe(path.join(dir, 'claude') + '.exe');
  });

  it('still falls back to the bare command when nothing is on disk', () => {
    expect(winMake([], 'C:\\nowhere;C:\\also-nowhere')).toBe('claude');
  });
});
