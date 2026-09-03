/**
 * Decide which window should host an "open this project" request.
 *
 * A window keeps referencing every project that is warm in its rail, so the
 * window that was *created* for Project-A is still the right window to reuse
 * after the user switches it to Project-B. What the callers additionally need
 * to know is whether that window is already *showing* the requested project:
 * if it is not, focusing it is a silent no-op and the request has to be
 * followed by a navigation message (https://github.com/nimbalyst/nimbalyst/issues/1427).
 *
 * The decision lives here, away from `BrowserWindow`, so the tiers and the
 * active-over-referenced preference can be tested without an Electron window.
 */

export interface WorkspaceWindowCandidate {
    windowId: number;
    workspacePath?: string | null;
    /** The project visible in the window; falls back to `workspacePath`. */
    activeWorkspacePath?: string | null;
    /** Rail projects kept warm but not visible. */
    additionalWorkspacePaths?: string[] | null;
}

export type WorkspaceWindowMatchKind =
    /** The window already shows the requested path. */
    | 'active'
    /** The window references the requested path but shows something else. */
    | 'referenced'
    /** The request is for a worktree; the window hosts its parent project. */
    | 'worktree-parent'
    /** The request is for a project; the window hosts one of its worktrees. */
    | 'worktree-child';

export interface WorkspaceWindowMatch {
    windowId: number;
    /**
     * The path inside that window the request resolves to. Equal to the
     * requested path for the exact tiers; the parent project or the worktree
     * for the worktree tiers.
     */
    matchedPath: string;
    /** True when `matchedPath` is the project the window is already showing. */
    isActive: boolean;
    kind: WorkspaceWindowMatchKind;
}

export interface WorktreeResolvers {
    isWorktreePath(path: string): boolean;
    resolveProjectPath(path: string): string;
}

function visiblePath(candidate: WorkspaceWindowCandidate): string | null {
    return candidate.activeWorkspacePath ?? candidate.workspacePath ?? null;
}

function railPaths(candidate: WorkspaceWindowCandidate): string[] {
    const paths: string[] = [];
    if (candidate.workspacePath) paths.push(candidate.workspacePath);
    if (candidate.additionalWorkspacePaths) paths.push(...candidate.additionalWorkspacePaths);
    return paths;
}

/**
 * First candidate whose matched path is the one on screen, else the first that
 * merely references it. Two windows can legitimately hold the same project;
 * the visible one is the one the user meant.
 */
function pickPreferringActive(
    candidates: readonly WorkspaceWindowCandidate[],
    matchedPathFor: (candidate: WorkspaceWindowCandidate) => string | null
): { windowId: number; matchedPath: string; isActive: boolean } | null {
    let referenced: { windowId: number; matchedPath: string; isActive: boolean } | null = null;

    for (const candidate of candidates) {
        const matchedPath = matchedPathFor(candidate);
        if (!matchedPath) continue;

        if (visiblePath(candidate) === matchedPath) {
            return { windowId: candidate.windowId, matchedPath, isActive: true };
        }
        if (!referenced) {
            referenced = { windowId: candidate.windowId, matchedPath, isActive: false };
        }
    }

    return referenced;
}

export function matchWorkspaceWindow(
    candidates: readonly WorkspaceWindowCandidate[],
    workspacePath: string,
    resolvers: WorktreeResolvers
): WorkspaceWindowMatch | null {
    if (!workspacePath) return null;

    const exact = pickPreferringActive(candidates, (candidate) =>
        railPaths(candidate).includes(workspacePath) ? workspacePath : null
    );
    if (exact) {
        return { ...exact, kind: exact.isActive ? 'active' : 'referenced' };
    }

    if (resolvers.isWorktreePath(workspacePath)) {
        const projectPath = resolvers.resolveProjectPath(workspacePath);
        const parent = pickPreferringActive(candidates, (candidate) =>
            railPaths(candidate).includes(projectPath) ? projectPath : null
        );
        if (parent) return { ...parent, kind: 'worktree-parent' };
    }

    const child = pickPreferringActive(
        candidates,
        (candidate) =>
            railPaths(candidate).find(
                (path) => resolvers.isWorktreePath(path) && resolvers.resolveProjectPath(path) === workspacePath
            ) ?? null
    );
    if (child) return { ...child, kind: 'worktree-child' };

    return null;
}

/**
 * Main -> renderer request to make a project the visible one. The renderer
 * registers the path with this window if needed, then flips the rail, which is
 * what sends `workspace:set-active` back to main.
 */
export const WORKSPACE_ACTIVATE_CHANNEL = 'workspace:activate-project';

/** The subset of `BrowserWindow` reuse needs, so the decision is testable. */
export interface ReusableWorkspaceWindow {
    isDestroyed(): boolean;
    isMinimized(): boolean;
    restore(): void;
    focus(): void;
    webContents: {
        isDestroyed(): boolean;
        send(channel: string, payload: unknown): void;
    };
}

export type WorkspaceWindowReuseOutcome =
    /** The window was already on the project; focusing it was enough. */
    | 'focused'
    /** The window was showing another project and was told to switch. */
    | 'switched'
    /** The window died between the match and the reuse; open a new one. */
    | 'unavailable';

/**
 * Bring an already-open window forward on the requested project. Focus alone is
 * a no-op when the window is showing a different project (and when it is
 * already focused), which is what made "open project" appear to do nothing.
 */
export function reuseWorkspaceWindow(
    window: ReusableWorkspaceWindow,
    match: Pick<WorkspaceWindowMatch, 'matchedPath' | 'isActive'>
): WorkspaceWindowReuseOutcome {
    if (window.isDestroyed()) return 'unavailable';
    if (!match.isActive && window.webContents.isDestroyed()) return 'unavailable';

    if (window.isMinimized()) window.restore();
    window.focus();

    if (match.isActive) return 'focused';

    window.webContents.send(WORKSPACE_ACTIVATE_CHANNEL, { workspacePath: match.matchedPath });
    return 'switched';
}
