/**
 * Settings Navigation State Atoms
 *
 * Manages deep linking to specific settings panels.
 * This replaces useState in App.tsx for settings navigation,
 * allowing any component to trigger navigation to specific settings.
 *
 * @example
 * // Navigate to agent permissions settings
 * const navigate = useSetAtom(navigateToSettingsAtom);
 * navigate({ category: 'agent-permissions', scope: 'project' });
 */

import { atom } from 'jotai';
import { store } from '@nimbalyst/runtime/store';
import type { SettingsCategory } from '../../components/Settings/SettingsSidebar';

// ============================================================
// Types
// ============================================================

export type SettingsScope = 'user' | 'organization' | 'project';

export interface SettingsNavigationState {
  /** Initial category to navigate to */
  initialCategory?: SettingsCategory;
  /** Initial scope (user or project) */
  initialScope?: SettingsScope;
  /** Incrementing key to force SettingsView remount */
  key: number;
}

// ============================================================
// Atoms
// ============================================================

/**
 * Settings navigation state atom.
 */
export const settingsNavigationAtom = atom<SettingsNavigationState>({
  initialCategory: undefined,
  initialScope: undefined,
  key: 0,
});

// Derived atoms for individual fields
export const settingsInitialCategoryAtom = atom(
  (get) => get(settingsNavigationAtom).initialCategory
);

export const settingsInitialScopeAtom = atom(
  (get) => get(settingsNavigationAtom).initialScope
);

export const settingsKeyAtom = atom(
  (get) => get(settingsNavigationAtom).key
);

// ============================================================
// Setter Atoms
// ============================================================

/**
 * Navigate to a specific settings panel.
 * This sets the initial category/scope and increments the key to force remount.
 */
export const navigateToSettingsAtom = atom(
  null,
  (get, set, params: { category: SettingsCategory; scope?: SettingsScope }) => {
    const current = get(settingsNavigationAtom);
    set(settingsNavigationAtom, {
      initialCategory: params.category,
      initialScope: params.scope,
      key: current.key + 1,
    });
  }
);

/**
 * Clear settings navigation state.
 * Called when leaving settings to reset the initial values.
 */
export const clearSettingsNavigationAtom = atom(
  null,
  (get, set) => {
    const current = get(settingsNavigationAtom);
    set(settingsNavigationAtom, {
      initialCategory: undefined,
      initialScope: undefined,
      key: current.key,
    });
  }
);

/**
 * Set initial category directly.
 */
export const setSettingsInitialCategoryAtom = atom(
  null,
  (get, set, category: SettingsCategory | undefined) => {
    const current = get(settingsNavigationAtom);
    set(settingsNavigationAtom, {
      ...current,
      initialCategory: category,
    });
  }
);

/**
 * Set initial scope directly.
 */
export const setSettingsInitialScopeAtom = atom(
  null,
  (get, set, scope: SettingsScope | undefined) => {
    const current = get(settingsNavigationAtom);
    set(settingsNavigationAtom, {
      ...current,
      initialScope: scope,
    });
  }
);

/**
 * Increment settings key to force remount.
 */
export const incrementSettingsKeyAtom = atom(
  null,
  (get, set) => {
    const current = get(settingsNavigationAtom);
    set(settingsNavigationAtom, {
      ...current,
      key: current.key + 1,
    });
  }
);

/**
 * Command atom for requesting settings navigation from outside App.tsx.
 * Set this atom to trigger App.tsx to switch to settings mode with a specific category.
 * App.tsx watches this atom and handles the mode switch.
 */
export const openSettingsCommandAtom = atom<{
  category: SettingsCategory;
  scope?: SettingsScope;
  /** Optional data-testid to scrollIntoView once the selected panel renders. */
  anchor?: string;
  timestamp: number;
} | null>(null);
