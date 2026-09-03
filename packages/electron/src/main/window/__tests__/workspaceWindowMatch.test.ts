// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import {
    matchWorkspaceWindow,
    reuseWorkspaceWindow,
    WORKSPACE_ACTIVATE_CHANNEL,
    type ReusableWorkspaceWindow,
    type WorkspaceWindowCandidate,
} from '../workspaceWindowMatch';

const PROJECT_A = '/Users/dev/project-a';
const PROJECT_B = '/Users/dev/project-b';
const WORKTREE_A = '/Users/dev/project-a-worktrees/feature';

/** No worktrees unless a test opts in, so the exact tier is what is under test. */
const noWorktrees = {
    isWorktreePath: () => false,
    resolveProjectPath: (path: string) => path,
};

const worktreeAware = {
    isWorktreePath: (path: string) => path.includes('-worktrees/'),
    resolveProjectPath: (path: string) => path.split('-worktrees/')[0],
};

function fakeWindow(overrides: Partial<ReusableWorkspaceWindow> = {}) {
    const send = vi.fn();
    const focus = vi.fn();
    const restore = vi.fn();
    const window: ReusableWorkspaceWindow = {
        isDestroyed: () => false,
        isMinimized: () => false,
        restore,
        focus,
        webContents: { isDestroyed: () => false, send },
        ...overrides,
    };
    return { window, send, focus, restore };
}

describe('matchWorkspaceWindow', () => {
    it('reports a window that switched away from its create-time project as not active', () => {
        // The reporter's sequence: the window was created for Project-A, the
        // user then switched it to Project-B inside the window, and now asks
        // the Project Manager for Project-A again.
        const candidates: WorkspaceWindowCandidate[] = [
            {
                windowId: 1,
                workspacePath: PROJECT_A,
                activeWorkspacePath: PROJECT_B,
                additionalWorkspacePaths: [PROJECT_B],
            },
        ];

        const match = matchWorkspaceWindow(candidates, PROJECT_A, noWorktrees);

        expect(match).toEqual({
            windowId: 1,
            matchedPath: PROJECT_A,
            isActive: false,
            kind: 'referenced',
        });
    });

    it('prefers a window that is showing the project over one that only references it', () => {
        const candidates: WorkspaceWindowCandidate[] = [
            { windowId: 1, workspacePath: PROJECT_A, activeWorkspacePath: PROJECT_B },
            { windowId: 2, workspacePath: PROJECT_B, additionalWorkspacePaths: [PROJECT_A], activeWorkspacePath: PROJECT_A },
        ];

        expect(matchWorkspaceWindow(candidates, PROJECT_A, noWorktrees)).toMatchObject({
            windowId: 2,
            isActive: true,
            kind: 'active',
        });
    });

    it('treats a window with no explicit active path as showing its primary workspace', () => {
        const candidates: WorkspaceWindowCandidate[] = [{ windowId: 1, workspacePath: PROJECT_A }];

        expect(matchWorkspaceWindow(candidates, PROJECT_A, noWorktrees)).toMatchObject({
            isActive: true,
            kind: 'active',
        });
    });

    it('still reuses a multi-root window that only references the project as a rail extra', () => {
        const candidates: WorkspaceWindowCandidate[] = [
            {
                windowId: 7,
                workspacePath: PROJECT_B,
                activeWorkspacePath: PROJECT_B,
                additionalWorkspacePaths: ['/Users/dev/other', PROJECT_A],
            },
        ];

        expect(matchWorkspaceWindow(candidates, PROJECT_A, noWorktrees)).toEqual({
            windowId: 7,
            matchedPath: PROJECT_A,
            isActive: false,
            kind: 'referenced',
        });
    });

    it('falls back to the parent project window for a worktree path', () => {
        const candidates: WorkspaceWindowCandidate[] = [
            { windowId: 3, workspacePath: PROJECT_A, activeWorkspacePath: PROJECT_A },
        ];

        expect(matchWorkspaceWindow(candidates, WORKTREE_A, worktreeAware)).toEqual({
            windowId: 3,
            matchedPath: PROJECT_A,
            isActive: true,
            kind: 'worktree-parent',
        });
    });

    it('falls back to a worktree window for the parent project path', () => {
        const candidates: WorkspaceWindowCandidate[] = [
            { windowId: 4, workspacePath: WORKTREE_A, activeWorkspacePath: PROJECT_B, additionalWorkspacePaths: [PROJECT_B] },
        ];

        expect(matchWorkspaceWindow(candidates, PROJECT_A, worktreeAware)).toEqual({
            windowId: 4,
            matchedPath: WORKTREE_A,
            isActive: false,
            kind: 'worktree-child',
        });
    });

    it('returns null when no window references the project', () => {
        expect(
            matchWorkspaceWindow([{ windowId: 1, workspacePath: PROJECT_B }], PROJECT_A, noWorktrees)
        ).toBeNull();
    });
});

describe('reuseWorkspaceWindow', () => {
    it('tells a window that switched away to go back to the requested project', () => {
        // Composed exactly as `workspace-manager:open-workspace` composes them.
        const match = matchWorkspaceWindow(
            [{ windowId: 1, workspacePath: PROJECT_A, activeWorkspacePath: PROJECT_B }],
            PROJECT_A,
            noWorktrees
        );
        const { window, send, focus } = fakeWindow();

        expect(reuseWorkspaceWindow(window, match!)).toBe('switched');
        expect(focus).toHaveBeenCalled();
        expect(send).toHaveBeenCalledWith(WORKSPACE_ACTIVATE_CHANNEL, { workspacePath: PROJECT_A });
    });

    it('only focuses when the window is already on the project', () => {
        const { window, send, focus } = fakeWindow();

        expect(reuseWorkspaceWindow(window, { matchedPath: PROJECT_A, isActive: true })).toBe('focused');
        expect(focus).toHaveBeenCalled();
        expect(send).not.toHaveBeenCalled();
    });

    it('restores a minimized window before focusing it', () => {
        const { window, restore } = fakeWindow({ isMinimized: () => true });

        reuseWorkspaceWindow(window, { matchedPath: PROJECT_A, isActive: true });

        expect(restore).toHaveBeenCalled();
    });

    it('reports unavailable rather than silently succeeding when the window cannot be told to switch', () => {
        const destroyed = fakeWindow({ isDestroyed: () => true });
        expect(reuseWorkspaceWindow(destroyed.window, { matchedPath: PROJECT_A, isActive: false })).toBe(
            'unavailable'
        );

        const send = vi.fn();
        const goneRenderer = fakeWindow({ webContents: { isDestroyed: () => true, send } });
        expect(reuseWorkspaceWindow(goneRenderer.window, { matchedPath: PROJECT_A, isActive: false })).toBe(
            'unavailable'
        );
        expect(send).not.toHaveBeenCalled();
    });
});
