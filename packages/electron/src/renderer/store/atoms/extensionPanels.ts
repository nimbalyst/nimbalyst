/**
 * Extension Panel Atoms
 *
 * Manages state for extension panels, including AI context sharing.
 * Used to bridge extension panel state with the AI chat system.
 */

import { atom } from 'jotai';

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
