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
import { clearWorktreeIdentityCache } from '../../utils/workspaceDetection';

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

/**
 * #1419: a checkout reached through a symlink stores its permissions under the
 * path the user opened, but every worktree of it resolves its parent through
 * realpath. The two spellings never matched, so worktrees inherited nothing and
 * the user was prompted for every tool call.
 */
describe('PermissionService inheritance through a symlinked checkout (#1419)', () => {
  let tmpRoot: string;
  /** The project as the user opened it: through the symlink. */
  let openedProject: string;
  /** A worktree of that project, also reached through the symlink. */
  let openedWorktree: string;
  /** The same project directory, fully symlink-resolved. */
  let realProject: string;
  let symlinksSupported = true;
  const service = PermissionService.getInstance();

  beforeEach(() => {
    store.clear();
    delete process.env.NIMBALYST_PERMISSION_MODE;
    clearWorktreeIdentityCache();
    symlinksSupported = true;
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-symlink-trust-'));

    // <tmp>/real/{project, project_worktrees/wt}, reached via <tmp>/link.
    const realRoot = path.join(tmpRoot, 'real');
    realProject = path.join(realRoot, 'project');
    const realWorktree = path.join(realRoot, 'project_worktrees', 'wt');
    const registrationDir = path.join(realProject, '.git', 'worktrees', 'wt');
    fs.mkdirSync(registrationDir, { recursive: true });
    fs.mkdirSync(realWorktree, { recursive: true });
    fs.writeFileSync(path.join(realWorktree, '.git'), `gitdir: ${registrationDir}\n`);
    fs.writeFileSync(path.join(registrationDir, 'gitdir'), `${path.join(realWorktree, '.git')}\n`);

    const linkRoot = path.join(tmpRoot, 'link');
    try {
      fs.symlinkSync(realRoot, linkRoot, 'junction');
    } catch {
      // Symlink creation needs elevated privileges in some CI sandboxes.
      symlinksSupported = false;
    }
    openedProject = path.join(linkRoot, 'project');
    openedWorktree = path.join(linkRoot, 'project_worktrees', 'wt');
  });

  afterEach(() => {
    clearWorktreeIdentityCache();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('a worktree inherits the mode stored under the un-resolved (symlinked) project path', () => {
    if (!symlinksSupported) return;
    store.set(openedProject, { permissionMode: 'allow-all' });

    expect(service.getPermissionMode(openedWorktree)).toBe('allow-all');
    expect(service.isWorkspaceTrusted(openedWorktree)).toBe(true);
  });

  it('a project opened through the symlink inherits a mode stored under its real path', () => {
    // The reverse spelling: trust granted from inside a worktree is written
    // under the realpath'd parent, and must be visible from the opened project.
    if (!symlinksSupported) return;
    store.set(fs.realpathSync.native(realProject), { permissionMode: 'bypass-all' });

    expect(service.getPermissionMode(openedProject)).toBe('bypass-all');
  });

  it('does not invent trust when neither spelling of the project is trusted', () => {
    if (!symlinksSupported) return;
    expect(service.getPermissionMode(openedWorktree)).toBe(null);
    expect(service.isWorkspaceTrusted(openedProject)).toBe(false);
  });
});
