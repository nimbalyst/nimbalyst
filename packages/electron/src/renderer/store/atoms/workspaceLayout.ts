/**
 * Per-workspace UI layout atoms
 *
 * Sidebar width, AI chat panel width and collapse state are stored as atom
 * families keyed by workspace path. With the project rail, multiple
 * workspaces can be hosted in a single window: each one needs its own
 * layout slot so that switching between projects keeps each project's
 * widths and collapse state intact.
 *
 * The atoms are pure storage — components are responsible for seeding from
 * persisted state (e.g. `electronAPI.getSidebarWidth`) on first mount and
 * for writing back when the user resizes.
 */

import { atom } from 'jotai';
import { atomFamily } from '../debug/atomFamilyRegistry';

const DEFAULT_SIDEBAR_WIDTH = 250;
const DEFAULT_AI_CHAT_WIDTH = 350;

/**
 * Workspace sidebar width in pixels.
 */
export const sidebarWidthAtomFamily = atomFamily((_workspacePath: string) =>
  atom<number>(DEFAULT_SIDEBAR_WIDTH)
);

/**
 * Whether the workspace sidebar is collapsed.
 */
export const sidebarCollapsedAtomFamily = atomFamily((_workspacePath: string) =>
  atom<boolean>(false)
);

/**
 * Width to restore when un-collapsing the sidebar.
 */
export const sidebarPreCollapseWidthAtomFamily = atomFamily((_workspacePath: string) =>
  atom<number>(DEFAULT_SIDEBAR_WIDTH)
);

/**
 * AI chat panel width in pixels.
 */
export const aiChatWidthAtomFamily = atomFamily((_workspacePath: string) =>
  atom<number>(DEFAULT_AI_CHAT_WIDTH)
);

/**
 * Whether the AI chat panel is collapsed.
 */
export const aiChatCollapsedAtomFamily = atomFamily((_workspacePath: string) =>
  atom<boolean>(false)
);

/** Drop every layout slot held for a workspace path. */
export function pruneWorkspaceLayout(workspacePath: string): void {
  sidebarWidthAtomFamily.remove(workspacePath);
  sidebarCollapsedAtomFamily.remove(workspacePath);
  sidebarPreCollapseWidthAtomFamily.remove(workspacePath);
  aiChatWidthAtomFamily.remove(workspacePath);
  aiChatCollapsedAtomFamily.remove(workspacePath);
}
