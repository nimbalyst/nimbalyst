import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Trust-boundary coverage for the worktree/subfolder permission cascade.
 *
 * The subfolder cascade must inherit a project's trust for its own subfolders,
 * but must NOT let a distinct project (its own `.git`) nested under a trusted
 * parent directory inherit that trust - otherwise a freshly-cloned repo under a
 * once-trusted `~/code` would silently skip the trust prompt.
 *
 * getAgentPermissions/saveAgentPermissions are backed by an in-memory map so the
 * synchronous read path can run without the electron-store; findProjectRoot uses
 * the real filesystem, so the tests build actual `.git` markers in a temp tree.
 */

const store = new Map<string, { permissionMode: string | null }>();

vi.mock('../../utils/store', () => ({
  getAgentPermissions: (p: string) => store.get(p),
  saveAgentPermissions: (p: string, v: { permissionMode: string | null }) => {
    store.set(p, v);
  },
}));

import { PermissionService } from '../PermissionService';

describe('PermissionService trust boundary (nested projects vs subfolders)', () => {
  let tmpRoot: string;
  const service = PermissionService.getInstance();

  beforeEach(() => {
    store.clear();
    delete process.env.NIMBALYST_PERMISSION_MODE;
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-trust-'));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('a nested repo (own .git) does NOT inherit a trusted parent directory', () => {
    // Parent dir was trusted (e.g. `~/code` opened as a workspace, Allow All).
    store.set(tmpRoot, { permissionMode: 'allow-all' });
    // A freshly-cloned, never-trusted repo lives under it with its own .git.
    const clone = path.join(tmpRoot, 'some-fresh-clone');
    fs.mkdirSync(path.join(clone, '.git'), { recursive: true });

    expect(service.isWorkspaceTrusted(clone)).toBe(false);
    expect(service.getPermissionMode(clone)).toBe(null);
  });

  it('a real subfolder of a trusted git project DOES inherit its trust', () => {
    fs.mkdirSync(path.join(tmpRoot, '.git'));
    store.set(tmpRoot, { permissionMode: 'allow-all' });
    const sub = path.join(tmpRoot, 'packages', 'electron');
    fs.mkdirSync(sub, { recursive: true });

    expect(service.isWorkspaceTrusted(sub)).toBe(true);
    expect(service.getPermissionMode(sub)).toBe('allow-all');
  });

  it('the trusted project itself still reads as trusted', () => {
    fs.mkdirSync(path.join(tmpRoot, '.git'));
    store.set(tmpRoot, { permissionMode: 'bypass-all' });

    expect(service.isWorkspaceTrusted(tmpRoot)).toBe(true);
    expect(service.getPermissionMode(tmpRoot)).toBe('bypass-all');
  });
});
