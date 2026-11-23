/**
 * Workspace association for the hidden screenshot capture window.
 *
 * The capture window (`?mode=capture`) is created directly by
 * `OffscreenEditorManager`, not by `WindowManager`, so it has no `WindowState`
 * and `resolveActiveWorkspacePathForWindowId` returns undefined for it. Any
 * main-process handler that resolves "the project this window is looking at"
 * therefore has nothing to work with when the sender is the capture window —
 * which is how a themed `capture_editor_screenshot` came to render every
 * extension with a backend module in an error state: the extension's renderer
 * half calls a backend tool without an explicit workspacePath (the editor-scoped
 * SDK signature does not accept one) and the call threw "No workspace path
 * available for backend tool call".
 *
 * The offscreen mount already knows the file's workspace, so it records it here
 * keyed by the capture window's `webContents.id`. Handlers resolve a sender's
 * workspace through `resolveSenderWorkspacePath`, which prefers a real window's
 * active project and falls back to the capture window's current mount.
 */

import { resolveActiveWorkspacePathForWindowId } from './windowState';

/**
 * webContents id -> mounted file path -> workspace path.
 *
 * Insertion-ordered, so the most recent mount is the one a backend tool call is
 * about: the capture window mounts a file, gets screenshotted, and unmounts.
 */
const captureMounts = new Map<number, Map<string, string>>();

/** Record the workspace an offscreen editor was mounted for. */
export function registerCaptureWindowMount(
    webContentsId: number,
    filePath: string,
    workspacePath: string
): void {
    let mounts = captureMounts.get(webContentsId);
    if (!mounts) {
        mounts = new Map();
        captureMounts.set(webContentsId, mounts);
    }
    // Re-insert so the newest mount stays last even when the file was already mounted.
    mounts.delete(filePath);
    mounts.set(filePath, workspacePath);
}

/** Drop a single mount; the window keeps any other files it still has mounted. */
export function unregisterCaptureWindowMount(webContentsId: number, filePath: string): void {
    const mounts = captureMounts.get(webContentsId);
    if (!mounts) return;
    mounts.delete(filePath);
    if (mounts.size === 0) {
        captureMounts.delete(webContentsId);
    }
}

/** Drop every mount for a window (window closed, or manager cleanup). */
export function clearCaptureWindowMounts(webContentsId: number): void {
    captureMounts.delete(webContentsId);
}

/** The workspace of the most recently mounted offscreen editor in this window. */
export function getCaptureWindowWorkspacePath(
    webContentsId: number | null | undefined
): string | undefined {
    if (webContentsId === null || webContentsId === undefined) return undefined;
    const mounts = captureMounts.get(webContentsId);
    if (!mounts || mounts.size === 0) return undefined;
    let latest: string | undefined;
    for (const workspacePath of mounts.values()) {
        latest = workspacePath;
    }
    return latest;
}

/**
 * Resolve the workspace an IPC request from this sender should act on.
 *
 * A real window's active project always wins (it honors the project rail
 * selection). The capture-window mount is the fallback for windows that
 * `WindowManager` never registered.
 */
export function resolveSenderWorkspacePath(sender: {
    windowId?: number | null;
    webContentsId?: number | null;
}): string | undefined {
    return (
        resolveActiveWorkspacePathForWindowId(sender.windowId) ??
        getCaptureWindowWorkspacePath(sender.webContentsId)
    );
}

/**
 * The project a backend tool call acts on. The caller names it; the on-screen
 * project is never substituted, because the caller may be background or agent
 * work for another project (#1299). The one exception is the capture window,
 * whose single mounted file fixes the project.
 */
export function resolveBackendToolCallWorkspacePath(call: {
    requested: string | undefined;
    webContentsId?: number | null;
}): string | undefined {
    return call.requested || getCaptureWindowWorkspacePath(call.webContentsId);
}
