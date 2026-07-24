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
import type { SettingsDestination, SettingsScope } from '../../components/Settings/settingsRoutes';

// ============================================================
// Types
// ============================================================

export type { SettingsScope } from '../../components/Settings/settingsRoutes';

export interface SettingsNavigationState {
  /** Initial category to navigate to */
  initialCategory?: SettingsCategory;
  /** Initial scope (user or project) */
  initialScope?: SettingsScope;
  destination?: SettingsDestination;
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

export const settingsDestinationAtom = atom(
  (get) => get(settingsNavigationAtom).destination
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
  (get, set, params: { category: SettingsCategory; scope?: SettingsScope; destination?: SettingsDestination }) => {
    const current = get(settingsNavigationAtom);
    set(settingsNavigationAtom, {
      initialCategory: params.category,
      initialScope: params.scope,
      destination: params.destination,
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
      destination: undefined,
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

export const setSettingsDestinationAtom = atom(
  null,
  (get, set, destination: SettingsDestination | undefined) => {
    const current = get(settingsNavigationAtom);
    set(settingsNavigationAtom, { ...current, destination });
  }
);

/**
 * In-place settings navigation (scope/category) that ALWAYS clears any stale
 * deep-link `destination` and bumps the remount key. Every non-command entry
 * point (menu items, restore, permission deep links) must use this: only the
 * `openSettingsCommand` path carries a `destination`, and a leftover one would
 * otherwise override a newer scope/category and land the user on the wrong
 * scope (settings review finding). Category/scope are only overwritten when
 * provided, so callers can update just one.
 */
export const navigateSettingsInPlaceAtom = atom(
  null,
  (
    get,
    set,
    params: { category?: SettingsCategory; scope?: SettingsScope },
  ) => {
    const current = get(settingsNavigationAtom);
    set(settingsNavigationAtom, {
      ...current,
      initialCategory: params.category ?? current.initialCategory,
      initialScope: params.scope ?? current.initialScope,
      destination: undefined,
      key: current.key + 1,
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
  destination?: SettingsDestination;
  /** Optional data-testid to scrollIntoView once the selected panel renders. */
  anchor?: string;
  timestamp: number;
} | null>(null);
