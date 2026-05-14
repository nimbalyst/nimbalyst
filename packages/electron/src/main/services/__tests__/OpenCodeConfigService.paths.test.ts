/**
 * Path-resolution tests for OpenCodeConfigService.
 *
 * Regression: PR fixing #284 - opencode model picker not showing configured
 * providers on Windows. Before the fix the path was hardcoded to
 * `~/.config/opencode/opencode.json` on every platform, so on Windows the
 * service silently looked at a file opencode-ai never writes. opencode-ai
 * itself writes to `%APPDATA%\opencode\opencode.json` by default.
 *
 * These tests pin the candidate-resolution + first-existing pick logic
 * against the opencode-ai Go binary's own search order:
 *   1. $XDG_CONFIG_HOME/opencode/opencode.json
 *   2. Windows: %APPDATA%/opencode/opencode.json
 *   3. Fallback: ~/.config/opencode/opencode.json
 */
import { describe, it, expect } from 'vitest';
import * as path from 'path';
import {
  resolveOpenCodeConfigCandidates,
  pickFirstExisting,
} from '../OpenCodeConfigService';

const HOME_UNIX = '/home/user';
const HOME_WIN = 'C:\\Users\\user';
const APPDATA = 'C:\\Users\\user\\AppData\\Roaming';
const XDG = '/custom/xdg';

describe('resolveOpenCodeConfigCandidates', () => {
  it('on linux with no XDG override, returns only the ~/.config fallback', () => {
    const out = resolveOpenCodeConfigCandidates({
      platform: 'linux',
      xdgConfigHome: undefined,
      appData: undefined,
      homedir: HOME_UNIX,
    });
    expect(out).toEqual([path.join(HOME_UNIX, '.config', 'opencode', 'opencode.json')]);
  });

  it('on linux with XDG override, XDG path comes before the home fallback', () => {
    const out = resolveOpenCodeConfigCandidates({
      platform: 'linux',
      xdgConfigHome: XDG,
      appData: undefined,
      homedir: HOME_UNIX,
    });
    expect(out).toEqual([
      path.join(XDG, 'opencode', 'opencode.json'),
      path.join(HOME_UNIX, '.config', 'opencode', 'opencode.json'),
    ]);
  });

  it('on win32 without APPDATA, falls back to ~/.config (degraded mode)', () => {
    const out = resolveOpenCodeConfigCandidates({
      platform: 'win32',
      xdgConfigHome: undefined,
      appData: undefined,
      homedir: HOME_WIN,
    });
    expect(out).toEqual([path.join(HOME_WIN, '.config', 'opencode', 'opencode.json')]);
  });

  it('on win32 with APPDATA, APPDATA precedes the home fallback', () => {
    const out = resolveOpenCodeConfigCandidates({
      platform: 'win32',
      xdgConfigHome: undefined,
      appData: APPDATA,
      homedir: HOME_WIN,
    });
    expect(out).toEqual([
      path.join(APPDATA, 'opencode', 'opencode.json'),
      path.join(HOME_WIN, '.config', 'opencode', 'opencode.json'),
    ]);
  });

  it('on win32 with both XDG and APPDATA, XDG wins over APPDATA wins over fallback', () => {
    const out = resolveOpenCodeConfigCandidates({
      platform: 'win32',
      xdgConfigHome: XDG,
      appData: APPDATA,
      homedir: HOME_WIN,
    });
    expect(out).toEqual([
      path.join(XDG, 'opencode', 'opencode.json'),
      path.join(APPDATA, 'opencode', 'opencode.json'),
      path.join(HOME_WIN, '.config', 'opencode', 'opencode.json'),
    ]);
  });

  it('deduplicates identical paths (XDG override pointing at ~/.config)', () => {
    // Edge case: a user sets XDG_CONFIG_HOME to its own default value.
    const out = resolveOpenCodeConfigCandidates({
      platform: 'linux',
      xdgConfigHome: path.join(HOME_UNIX, '.config'),
      appData: undefined,
      homedir: HOME_UNIX,
    });
    expect(out).toEqual([path.join(HOME_UNIX, '.config', 'opencode', 'opencode.json')]);
  });

  it('treats empty-string XDG as absent (defensive)', () => {
    const out = resolveOpenCodeConfigCandidates({
      platform: 'linux',
      xdgConfigHome: '',
      appData: undefined,
      homedir: HOME_UNIX,
    });
    expect(out).toEqual([path.join(HOME_UNIX, '.config', 'opencode', 'opencode.json')]);
  });
});

describe('pickFirstExisting', () => {
  it('returns the first candidate that exists', () => {
    const candidates = ['/a', '/b', '/c'];
    const out = pickFirstExisting(candidates, (p) => p === '/b' || p === '/c');
    expect(out).toBe('/b');
  });

  it('returns the first candidate when none exist (write fallback)', () => {
    const candidates = ['/a', '/b', '/c'];
    const out = pickFirstExisting(candidates, () => false);
    // Returning candidates[0] means a fresh write goes to the
    // platform-native canonical location (APPDATA on Windows, ~/.config elsewhere).
    expect(out).toBe('/a');
  });

  it('tolerates thrown errors from existsFn (e.g. EPERM) and keeps probing', () => {
    const candidates = ['/perm-denied', '/found'];
    const out = pickFirstExisting(candidates, (p) => {
      if (p === '/perm-denied') throw new Error('EACCES');
      return p === '/found';
    });
    expect(out).toBe('/found');
  });

  it('with single candidate, returns it whether it exists or not', () => {
    expect(pickFirstExisting(['/only'], () => true)).toBe('/only');
    expect(pickFirstExisting(['/only'], () => false)).toBe('/only');
  });
});

describe('integration: AnisminC #284 scenario', () => {
  it('Windows user with APPDATA + opencode.json there resolves to APPDATA path', () => {
    const candidates = resolveOpenCodeConfigCandidates({
      platform: 'win32',
      xdgConfigHome: undefined,
      appData: APPDATA,
      homedir: HOME_WIN,
    });
    const expected = path.join(APPDATA, 'opencode', 'opencode.json');
    const chosen = pickFirstExisting(candidates, (p) => p === expected);
    expect(chosen).toBe(expected);
  });

  it('Windows user who manually created ~/.config/opencode/opencode.json still works', () => {
    const candidates = resolveOpenCodeConfigCandidates({
      platform: 'win32',
      xdgConfigHome: undefined,
      appData: APPDATA,
      homedir: HOME_WIN,
    });
    const expected = path.join(HOME_WIN, '.config', 'opencode', 'opencode.json');
    const chosen = pickFirstExisting(candidates, (p) => p === expected);
    expect(chosen).toBe(expected);
  });

  it('Windows user with neither file gets APPDATA as the write target', () => {
    const candidates = resolveOpenCodeConfigCandidates({
      platform: 'win32',
      xdgConfigHome: undefined,
      appData: APPDATA,
      homedir: HOME_WIN,
    });
    const chosen = pickFirstExisting(candidates, () => false);
    expect(chosen).toBe(path.join(APPDATA, 'opencode', 'opencode.json'));
  });
});
