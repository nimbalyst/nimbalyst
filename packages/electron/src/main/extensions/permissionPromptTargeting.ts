/**
 * Pure window-targeting logic for extension permission prompts.
 *
 * A first-use / re-prompt consent modal must reach a window the user can
 * actually act on, and the window that received it must be the one allowed to
 * resolve it. The original implementation matched only on a window's *active*
 * workspace (`activeWorkspacePath ?? workspacePath`) for both delivery and
 * resolution. That drifts in two real situations:
 *
 *   - Multi-Project rail: the workspace the prompt is for may be open in a
 *     window as an *additional* (background) rail project, or be the window's
 *     *primary* path while a different rail project is active — so an
 *     active-only match misses it and the prompt is silently dropped (the
 *     module parks in `awaiting-consent` forever).
 *   - Multiple windows: the prompt may be delivered to one window while the
 *     user is acting in another, and `list-pending` (which re-derived the
 *     active match) wouldn't surface it in the window the user is in.
 *
 * Fix: deliver to every window that *references* the workspace (primary,
 * active, or additional rail path), with a focused-window fallback so the
 * prompt is never undeliverable; then authorize resolution and pending-list
 * reads by the set of window ids the prompt was actually delivered to, rather
 * than re-deriving an active-path match that can drift.
 *
 * Kept dependency-free (no electron imports) so it is unit-testable.
 */

import type { WindowState } from '../types';

export interface WindowForTargeting {
  id: number;
  state: WindowState | undefined;
  /** Whether this window currently has OS focus. Used only for the fallback. */
  focused: boolean;
}

/**
 * True when a window has any binding to `workspacePath` — as its primary
 * path, its active (rail-visible) path, or a warm additional rail path. This
 * is the set of windows where showing the consent modal makes sense.
 */
export function windowBindsWorkspace(
  state: WindowState | undefined,
  workspacePath: string
): boolean {
  if (!state) return false;
  if (state.workspacePath === workspacePath) return true;
  if (state.activeWorkspacePath === workspacePath) return true;
  return state.additionalWorkspacePaths?.includes(workspacePath) === true;
}

/**
 * Choose which window ids a prompt for `workspacePath` should be delivered to.
 *
 * Preference order:
 *   1. Every window that binds the workspace (primary/active/additional).
 *   2. If none bind it, the focused window (so a native-code consent is never
 *      silently dropped — the modal names the workspace, so it is still
 *      actionable).
 *   3. If nothing is focused either, all windows.
 *
 * Returning [] is only possible when there are no windows at all.
 */
export function selectPromptTargetWindowIds(
  windows: WindowForTargeting[],
  workspacePath: string
): number[] {
  const binding = windows.filter((w) => windowBindsWorkspace(w.state, workspacePath));
  if (binding.length > 0) return binding.map((w) => w.id);

  const focused = windows.find((w) => w.focused);
  if (focused) return [focused.id];

  return windows.map((w) => w.id);
}

/**
 * A window may resolve a prompt iff the prompt was actually delivered to it.
 * Keyed on the delivered-to id set rather than a re-derived active match, so a
 * window that legitimately received the modal can always dismiss it.
 */
export function canWindowResolvePrompt(
  targetWindowIds: number[],
  senderWindowId: number | null
): boolean {
  if (senderWindowId === null) return false;
  return targetWindowIds.includes(senderWindowId);
}
