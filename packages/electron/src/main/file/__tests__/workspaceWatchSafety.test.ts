// @vitest-environment node
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { validateWorkspaceWatchPath } from '../workspaceWatchSafety';

const win = (p: string) => validateWorkspaceWatchPath(p, { pathModule: path.win32, homeDir: 'C:\\Users\\me' });
const posix = (p: string) => validateWorkspaceWatchPath(p, { pathModule: path.posix, homeDir: '/Users/me' });

describe('validateWorkspaceWatchPath', () => {
  it('allows a Windows project directly under a drive root', () => {
    expect(win('d:\\XYZ')).toBeNull();
    expect(win('C:\\dev')).toBeNull();
    expect(win('\\\\server\\share\\project')).toBeNull();
  });

  it('rejects Windows roots, the home dir and its ancestors, and system dirs', () => {
    for (const p of ['D:\\', 'c:\\', '\\\\server\\share', 'C:\\Users', 'c:\\users\\ME', 'C:\\Windows', 'D:\\Program Files']) {
      expect(win(p), p).not.toBeNull();
    }
  });

  it('allows shallow POSIX projects outside container dirs', () => {
    expect(posix('/srv/app')).toBeNull();
    expect(posix('/Users/me/project')).toBeNull();
    expect(posix('/Volumes/Data/project')).toBeNull();
  });

  it('rejects POSIX roots, the home dir and its ancestors, and container dirs', () => {
    for (const p of ['/', '/Users', '/Users/me', '/Volumes', '/home', '/tmp']) {
      expect(posix(p), p).not.toBeNull();
    }
  });
});
