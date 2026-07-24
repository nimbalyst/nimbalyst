/**
 * DiffErgonomicsFixture
 *
 * Runs the diff ergonomics test harness as a real file in the user's
 * already-open workspace. The flow mirrors a real AI edit:
 *
 *   1. Write the "before" markdown to <workspace>/diff-ergonomics-test.md
 *   2. Create a pending pre-edit history tag with the before content as baseline
 *   3. Overwrite the file with the "after" markdown
 *   4. Open the file in the workspace window as a normal tab
 *
 * When TabEditor mounts on the file it sees the pending tag, loads the
 * baseline as the editor's initial content, and dispatches
 * APPLY_MARKDOWN_REPLACE_COMMAND with the on-disk (after) content. The
 * normal WYSIWYG diff and unified diff header take over from there.
 *
 * Launched from Developer > Diff Ergonomics Test Harness.
 */

import { BrowserWindow } from 'electron';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { historyManager } from '../HistoryManager';
import { loadFileIntoWindow } from './FileOperations';
import { windowStates, getWindowId } from '../window/WindowManager';
import { HARNESS_BEFORE, HARNESS_AFTER } from './diffErgonomicsFixtureContent';

const FIXTURE_FILENAME = 'diff-ergonomics-test.md';

/**
 * Pick a workspace window: the focused one if it has a workspace, otherwise
 * the first window we find with a workspace. Menu clicks (esp. on macOS) can
 * leave the focused window pointing at a non-workspace window like the
 * Developer Dashboard, so we don't insist on the focused one.
 */
function pickWorkspaceWindow(focused: BrowserWindow | null): {
    window: BrowserWindow;
    workspacePath: string;
} | null {
    const candidates = focused ? [focused, ...BrowserWindow.getAllWindows()] : BrowserWindow.getAllWindows();
    const seen = new Set<number>();
    for (const win of candidates) {
        if (!win || win.isDestroyed() || seen.has(win.id)) continue;
        seen.add(win.id);
        const id = getWindowId(win);
        if (id === null) continue;
        const state = windowStates.get(id);
        if (state?.workspacePath) {
            return { window: win, workspacePath: state.workspacePath };
        }
    }
    return null;
}

export async function runDiffErgonomicsHarness(focused: BrowserWindow | null): Promise<void> {
    const target = pickWorkspaceWindow(focused);
    if (!target) {
        console.warn('[DiffErgonomicsFixture] No workspace window open; harness skipped.');
        return;
    }

    const { window, workspacePath } = target;
    const filePath = join(workspacePath, FIXTURE_FILENAME);

    try {
        writeFileSync(filePath, HARNESS_BEFORE, 'utf-8');

        const tagId = `diff-ergonomics-${Date.now()}`;
        const sessionId = `diff-ergonomics-session-${Date.now()}`;
        const toolUseId = `diff-ergonomics-tool-${Date.now()}`;

        await historyManager.createTag(
            workspacePath,
            filePath,
            tagId,
            HARNESS_BEFORE,
            sessionId,
            toolUseId
        );

        writeFileSync(filePath, HARNESS_AFTER, 'utf-8');

        loadFileIntoWindow(window, filePath);
    } catch (error) {
        console.error('[DiffErgonomicsFixture] Failed to set up harness:', error);
    }
}
