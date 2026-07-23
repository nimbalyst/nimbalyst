import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const mocks = vi.hoisted(() => ({
  findWindowByWorkspace: vi.fn(),
  getByPath: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn() },
}));

vi.mock('../../window/WindowManager', () => ({
  findWindowByWorkspace: mocks.findWindowByWorkspace,
}));

vi.mock('../../database/initialize', () => ({
  getDatabase: vi.fn(() => ({})),
}));

vi.mock('../../services/WorktreeStore', () => ({
  createWorktreeStore: vi.fn(() => ({ getByPath: mocks.getByPath })),
}));

vi.mock('../backendToolRegistry', () => ({
  getBackendTools: vi.fn(() => []),
  getVoiceEnabledBackendTools: vi.fn(() => []),
}));

import {
  findWindowIdForWorkspacePath,
  workspaceToWindowMap,
} from '../mcpWorkspaceResolver';

function createLinkedWorktree(mainRepoPath: string, worktreePath: string, worktreeName: string): void {
  fs.mkdirSync(path.join(mainRepoPath, '.git'), { recursive: true });
  const registrationDir = path.join(mainRepoPath, '.git', 'worktrees', worktreeName);
  fs.mkdirSync(registrationDir, { recursive: true });
  fs.mkdirSync(worktreePath, { recursive: true });
  fs.writeFileSync(path.join(worktreePath, '.git'), `gitdir: ${registrationDir}\n`);
  fs.writeFileSync(path.join(registrationDir, 'gitdir'), `${path.join(worktreePath, '.git')}\n`);
}

describe('findWindowIdForWorkspacePath linked-worktree fallback', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-mcp-worktree-route-'));
    workspaceToWindowMap.clear();
    mocks.findWindowByWorkspace.mockReset();
    mocks.getByPath.mockReset();
    mocks.getByPath.mockResolvedValue(null);
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    workspaceToWindowMap.clear();
  });

  it('routes a valid out-of-tree linked worktree to its already-open parent project window without WorktreeStore', async () => {
    const projectPath = path.join(tmpRoot, 'project');
    const worktreePath = path.join(tmpRoot, 'dedicated-volume', 'external-worktree');
    createLinkedWorktree(projectPath, worktreePath, 'external-worktree');
    const canonicalProjectPath = fs.realpathSync.native(projectPath);
    const parentWindow = { id: 47, isDestroyed: () => false };
    mocks.findWindowByWorkspace.mockImplementation((workspacePath: string) =>
      workspacePath === canonicalProjectPath ? parentWindow : null,
    );

    await expect(findWindowIdForWorkspacePath(worktreePath)).resolves.toBe(47);

    expect(mocks.findWindowByWorkspace).toHaveBeenCalledWith(worktreePath);
    expect(mocks.findWindowByWorkspace).toHaveBeenCalledWith(canonicalProjectPath);
    expect(workspaceToWindowMap.get(canonicalProjectPath)).toBe(47);
    expect(mocks.getByPath).not.toHaveBeenCalled();
  });

  it('fails closed for a forged worktree pointer and never routes it to the victim project window', async () => {
    const victimProjectPath = path.join(tmpRoot, 'victim');
    const legitimateWorktreePath = path.join(tmpRoot, 'legitimate-worktree');
    createLinkedWorktree(victimProjectPath, legitimateWorktreePath, 'legitimate');
    const forgedPath = path.join(tmpRoot, 'attacker');
    fs.mkdirSync(forgedPath, { recursive: true });
    fs.writeFileSync(
      path.join(forgedPath, '.git'),
      `gitdir: ${path.join(victimProjectPath, '.git', 'worktrees', 'legitimate')}\n`,
    );
    const canonicalVictimPath = fs.realpathSync.native(victimProjectPath);
    mocks.findWindowByWorkspace.mockImplementation((workspacePath: string) =>
      workspacePath === canonicalVictimPath ? { id: 91, isDestroyed: () => false } : null,
    );

    await expect(findWindowIdForWorkspacePath(forgedPath)).resolves.toBeNull();

    expect(mocks.findWindowByWorkspace).not.toHaveBeenCalledWith(canonicalVictimPath);
    expect(workspaceToWindowMap.has(canonicalVictimPath)).toBe(false);
  });

  it('fails closed for a stale registration without a back-pointer', async () => {
    const projectPath = path.join(tmpRoot, 'project');
    const registrationDir = path.join(projectPath, '.git', 'worktrees', 'stale');
    const stalePath = path.join(tmpRoot, 'stale-worktree');
    fs.mkdirSync(registrationDir, { recursive: true });
    fs.mkdirSync(stalePath, { recursive: true });
    fs.writeFileSync(path.join(stalePath, '.git'), `gitdir: ${registrationDir}\n`);
    const canonicalProjectPath = fs.realpathSync.native(projectPath);
    mocks.findWindowByWorkspace.mockImplementation((workspacePath: string) =>
      workspacePath === canonicalProjectPath ? { id: 99, isDestroyed: () => false } : null,
    );

    await expect(findWindowIdForWorkspacePath(stalePath)).resolves.toBeNull();

    expect(mocks.findWindowByWorkspace).not.toHaveBeenCalledWith(canonicalProjectPath);
    expect(workspaceToWindowMap.has(canonicalProjectPath)).toBe(false);
  });
});
