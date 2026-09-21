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
/** PROJECT_A reached through a symlink: one directory, two spellings (#1551). */
const REAL_A = '/Volumes/disk/project-a';
const WORKTREE_REAL_A = '/Volumes/disk/project-a-worktrees/feature';

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

    /**
     * GitHub #1551. A project reached through a symlink (or spelled with
     * different case) has two names for one directory. The window rail holds the
     * spelling the project was opened by, while a worktree resolves to the
     * realpath'd parent, so the exact-string tiers miss and a queued prompt for
     * a session in that worktree is deferred forever with `no-window`.
     *
     * The resolvers stay injected: alias-awareness arrives as another resolver,
     * `resolveProjectPathCandidates`, so the matcher still has no filesystem.
     */
    // Untyped so the extra resolver is passed through without an excess-property
    // error while `WorktreeResolvers` still carries it as optional.

    /** Two checkouts of one repo: same parent, different working directories. */
    const REPO_B = '/Users/dev/repo-b';
    const WORKTREE_B1 = '/Users/dev/repo-b-worktrees/branch-one';
    const WORKTREE_B2 = '/Users/dev/repo-b-worktrees/branch-two';
    const siblingWorktrees = {
        isWorktreePath: (p: string) => p.includes('-worktrees/'),
        resolveProjectPath: (p: string) => (p.includes('-worktrees/') ? p.split('-worktrees/')[0] : p),
        resolveProjectPathCandidates: (p: string) => [
            p.includes('-worktrees/') ? p.split('-worktrees/')[0] : p,
        ],
    };

    const aliasAware = {
        isWorktreePath: (p: string) => p.includes('-worktrees/'),
        resolveProjectPath: (p: string) => (p.includes('-worktrees/') ? p.split('-worktrees/')[0] : p),
        resolveProjectPathCandidates: (p: string) => {
            const root = p.includes('-worktrees/') ? p.split('-worktrees/')[0] : p;
            return root === REAL_A || root === PROJECT_A ? [REAL_A, PROJECT_A] : [root];
        },
    };

    it('matches a window holding the as-opened spelling when asked for the realpath', () => {
        const candidates: WorkspaceWindowCandidate[] = [
            { windowId: 1, workspacePath: PROJECT_A, activeWorkspacePath: PROJECT_A },
        ];

        expect(matchWorkspaceWindow(candidates, REAL_A, aliasAware)).toEqual({
            windowId: 1,
            // The window's own key, so focus/activate messages address it by the
            // string it registered under.
            matchedPath: PROJECT_A,
            isActive: true,
            kind: 'active',
        });
    });

    it("matches a worktree request against the parent's as-opened spelling", () => {
        const candidates: WorkspaceWindowCandidate[] = [
            { windowId: 2, workspacePath: PROJECT_A, activeWorkspacePath: PROJECT_A },
        ];

        expect(matchWorkspaceWindow(candidates, WORKTREE_REAL_A, aliasAware)).toEqual({
            windowId: 2,
            matchedPath: PROJECT_A,
            isActive: true,
            kind: 'worktree-parent',
        });
    });

    it('does not treat an unrelated project as an alias', () => {
        expect(
            matchWorkspaceWindow([{ windowId: 3, workspacePath: PROJECT_B }], REAL_A, aliasAware)
        ).toBeNull();
    });

    it('does not collapse two worktrees of one repo into each other', () => {
        // Sibling checkouts share a parent, so their candidate lists are equal.
        // They are still different working directories: a prompt for branch-one
        // must not be delivered to the window holding branch-two.
        const candidates: WorkspaceWindowCandidate[] = [
            { windowId: 1, workspacePath: WORKTREE_B2, activeWorkspacePath: WORKTREE_B2 },
        ];

        expect(matchWorkspaceWindow(candidates, WORKTREE_B1, siblingWorktrees)).toBeNull();
    });

    it('still matches the real parent project for a worktree request', () => {
        const candidates: WorkspaceWindowCandidate[] = [
            { windowId: 1, workspacePath: WORKTREE_B2 },
            { windowId: 2, workspacePath: REPO_B, activeWorkspacePath: REPO_B },
        ];

        expect(matchWorkspaceWindow(candidates, WORKTREE_B1, siblingWorktrees)).toEqual({
            windowId: 2,
            matchedPath: REPO_B,
            isActive: true,
            kind: 'worktree-parent',
        });
    });

    it('reports the spelling the window is showing when its rail holds two aliases', () => {
        // The rail's first entry and the visible project are the same directory
        // under two names; answering with the inactive one would send a switch
        // message to a window that is already there.
        const candidates: WorkspaceWindowCandidate[] = [
            {
                windowId: 1,
                workspacePath: REAL_A,
                activeWorkspacePath: PROJECT_A,
                additionalWorkspacePaths: [PROJECT_A],
            },
        ];

        expect(matchWorkspaceWindow(candidates, REAL_A, aliasAware)).toEqual({
            windowId: 1,
            matchedPath: PROJECT_A,
            isActive: true,
            kind: 'active',
        });
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
