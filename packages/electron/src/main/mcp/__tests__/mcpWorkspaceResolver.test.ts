// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ fromId: vi.fn(), findWindow: vi.fn(), getByPath: vi.fn() }));
vi.mock('electron', () => ({ BrowserWindow: { fromId: mocks.fromId } }));
vi.mock('../../window/WindowManager', () => ({ findWindowByWorkspace: mocks.findWindow }));
vi.mock('../../database/initialize', () => ({ getDatabase: () => ({}) }));
vi.mock('../../services/WorktreeStore', () => ({ createWorktreeStore: () => ({ getByPath: mocks.getByPath }) }));
import { findWindowIdForWorkspacePath, unregisterWindow, workspaceToWindowMap } from '../mcpWorkspaceResolver';

const live = { id: 22, isDestroyed: () => false };
describe('MCP workspace window lifecycle', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    workspaceToWindowMap.clear();
    mocks.getByPath.mockResolvedValue(null);
  });

  it.each([null, { id: 11, isDestroyed: () => true }])('replaces a stale cached window (%s)', async (stale) => {
    workspaceToWindowMap.set('/project', 11);
    mocks.fromId.mockReturnValue(stale);
    mocks.findWindow.mockReturnValue(live);
    expect(await findWindowIdForWorkspacePath('/project')).toBe(22);
    expect(workspaceToWindowMap.get('/project')).toBe(22);
    unregisterWindow(11); // Delayed old-window cleanup must preserve its replacement.
    expect(workspaceToWindowMap.get('/project')).toBe(22);
  });

  it('evicts a closed window and does not return an unrelated window', async () => {
    workspaceToWindowMap.set('/closed-project', 11);
    workspaceToWindowMap.set('/unrelated', 22);
    mocks.fromId.mockReturnValue(null);
    mocks.findWindow.mockReturnValue(null);
    expect(await findWindowIdForWorkspacePath('/closed-project')).toBeNull();
    expect(workspaceToWindowMap.has('/closed-project')).toBe(false);
    expect(workspaceToWindowMap.get('/unrelated')).toBe(22);
  });

  it('revalidates both database-resolved and cached worktree parent windows', async () => {
    mocks.getByPath.mockResolvedValue({ projectPath: '/parent' });
    mocks.fromId.mockReturnValue(null);
    mocks.findWindow.mockImplementation(path => path === '/parent' ? live : null);
    workspaceToWindowMap.set('/parent', 11);
    expect(await findWindowIdForWorkspacePath('/worktree')).toBe(22);
    workspaceToWindowMap.set('/parent', 11);
    expect(await findWindowIdForWorkspacePath('/worktree')).toBe(22);
    expect(mocks.getByPath).toHaveBeenCalledOnce();
  });

  it('keeps a live registration and unregisters only the closed Electron ID', async () => {
    workspaceToWindowMap.set('/project', 22);
    workspaceToWindowMap.set('/other', 33);
    mocks.fromId.mockReturnValue(live);
    expect(await findWindowIdForWorkspacePath('/project')).toBe(22);
    expect(mocks.findWindow).not.toHaveBeenCalled();
    unregisterWindow(22);
    expect([...workspaceToWindowMap]).toEqual([['/other', 33]]);
  });
});
