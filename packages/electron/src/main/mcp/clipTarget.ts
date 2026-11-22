/** What the clip endpoint needs to know about one open window. */
export interface ClipTargetCandidate {
  windowId: number;
  mode?: string | null;
  workspacePath?: string | null;
  /** The rail project the window is showing; falls back to `workspacePath`. */
  activeWorkspacePath?: string | null;
  focusOrder: number;
}

/**
 * The project a web clip is saved into: the one showing in the most recently
 * focused workspace window. A window's `workspacePath` is the project it was
 * opened for, which after a rail switch is not the project on screen.
 */
export function pickClipTarget(
  candidates: ClipTargetCandidate[],
): { windowId: number; workspacePath: string } | null {
  let best: { windowId: number; workspacePath: string; focusOrder: number } | null = null;
  for (const candidate of candidates) {
    if (candidate.mode !== 'workspace' && candidate.mode !== 'agentic-coding') continue;
    const workspacePath = candidate.activeWorkspacePath || candidate.workspacePath;
    if (!workspacePath) continue;
    if (!best || candidate.focusOrder > best.focusOrder) {
      best = { windowId: candidate.windowId, workspacePath, focusOrder: candidate.focusOrder };
    }
  }
  return best ? { windowId: best.windowId, workspacePath: best.workspacePath } : null;
}
