/**
 * Extension Panel Atoms
 *
 * Manages state for extension panels, including AI context sharing.
 * Used to bridge extension panel state with the AI chat system.
 */

import { atom } from 'jotai';
import { atomFamily } from '../debug/atomFamilyRegistry';
import { activeWorkspacePathAtom } from './openProjects';

/**
 * AI context from an extension panel.
 * This is made available to the AI chat when a fullscreen panel is active.
 */
export interface ExtensionPanelAIContext {
  /** Panel ID that provided this context */
  panelId: string;

  /** Extension ID that provides the panel */
  extensionId: string;

  /** Panel title (e.g., "SQLite Browser") */
  panelTitle: string;

  /** Dynamic context data from the panel (e.g., database name, table info) */
  context: Record<string, unknown>;
}

/**
 * Current active extension panel AI context.
 * Set by PanelContainer when a fullscreen panel with aiSupported=true is active.
 * Cleared when the panel is closed.
 */
export const extensionPanelAIContextAtom = atom<ExtensionPanelAIContext | null>(null);

/**
 * Getter for the current extension panel AI context.
 * Used by AgenticPanel to include context in messages.
 */
export const getExtensionPanelAIContextAtom = atom(
  (get) => get(extensionPanelAIContextAtom)
);

/**
 * Setter to update extension panel AI context.
 */
export const setExtensionPanelAIContextAtom = atom(
  null,
  (_get, set, context: ExtensionPanelAIContext | null) => {
    set(extensionPanelAIContextAtom, context);
  }
);

interface ExtensionPanelState {
  panelId: string | null;
  bottomPanelId: string | null;
  revision: number;
  hydrated: boolean;
}

export const extensionPanelStateAtomFamily = atomFamily((_workspacePath: string) =>
  atom<ExtensionPanelState>({ panelId: null, bottomPanelId: null, revision: 0, hydrated: false }),
);

function panelAtom(field: 'panelId' | 'bottomPanelId') {
  return atom(
    (get) => get(extensionPanelStateAtomFamily(get(activeWorkspacePathAtom) ?? ''))[field],
    (get, set, update: string | null | ((previous: string | null) => string | null)) => {
      const stateAtom = extensionPanelStateAtomFamily(get(activeWorkspacePathAtom) ?? '');
      const state = get(stateAtom);
      set(stateAtom, {
        ...state,
        [field]: typeof update === 'function' ? update(state[field]) : update,
        revision: state.revision + 1,
      });
    },
  );
}

export const activeExtensionPanelAtom = panelAtom('panelId');
export const activeExtensionBottomPanelAtom = panelAtom('bottomPanelId');

export const dismissExtensionPanelsAtom = atom(null, (get, set) => {
  const stateAtom = extensionPanelStateAtomFamily(get(activeWorkspacePathAtom) ?? '');
  const state = get(stateAtom);
  // Record even a same-mode navigation before panel hydration has finished.
  set(stateAtom, { ...state, panelId: null, bottomPanelId: null, revision: state.revision + 1 });
});
