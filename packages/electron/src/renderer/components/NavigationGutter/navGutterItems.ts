/**
 * Navigation gutter item registry types and helpers.
 *
 * The gutter is built by iterating a declarative registry of `GutterItem`
 * descriptors instead of hand-writing each button. The registry drives three
 * consumers that must agree: the gutter render, the right-click context menu,
 * and the "Customize Gutter" popover.
 *
 * Visibility (hidden set) and ordering are stored as a GLOBAL app setting (see
 * appSettings.ts `gutterCustomizationAtom`) so a user's "I never use Voice
 * Mode" / "put Tracker above Agent" preference applies across all projects.
 * Capability gating (a project has no team, no git remote, terminal disabled)
 * stays per-project and automatic — it filters which registry items exist at
 * all, so we never offer to "show" something the project can't support.
 */

import type { ReactNode } from 'react';

/**
 * Logical grouping of a gutter item. Sections render top-to-bottom in
 * GUTTER_SECTION_ORDER and are the unit of drag-to-reorder (order is within a
 * section only).
 */
export type GutterSection = 'modes' | 'panels' | 'indicators';

/**
 * Metadata for a single gutter item — everything the context menu and the
 * customize popover need to list/label it, independent of how it renders.
 */
export interface GutterItemMeta {
  /** Stable id, unique across the whole gutter (e.g. 'files', 'sync-status', an extension panel id). */
  id: string;
  section: GutterSection;
  /** Material Symbol name, shown in the context menu / popover row. */
  icon: string;
  /** Human-readable label, shown in the context menu / popover row. */
  label: string;
  /**
   * Whether the user is allowed to hide this item. `false` for always-on items
   * (the user menu). Content modes are individually hideable but a separate
   * keep-one-mode guard prevents removing the last visible mode.
   */
  hideable: boolean;
}

/**
 * A fully-realized gutter item: metadata plus the render function that produces
 * its button/indicator. Built inside NavigationGutter so `render` can close
 * over component state and handlers.
 */
export interface GutterItem extends GutterItemMeta {
  render: () => ReactNode;
}

/**
 * Persisted, global gutter customization. `order` is sparse — a section absent
 * from the map uses the registry's declared default order.
 */
export interface GutterCustomizationState {
  hiddenItems: string[];
  order: Partial<Record<GutterSection, string[]>>;
}

export const DEFAULT_GUTTER_CUSTOMIZATION: GutterCustomizationState = {
  hiddenItems: [],
  order: {},
};

/** App-settings store keys (generic app-settings:get/set channel). */
export const HIDDEN_GUTTER_ITEMS_KEY = 'hiddenGutterItems';
export const GUTTER_ITEM_ORDER_KEY = 'gutterItemOrder';

/** Top-to-bottom render order of the sections, and the popover group order. */
export const GUTTER_SECTION_ORDER: GutterSection[] = ['modes', 'panels', 'indicators'];

/** Section headers shown in the customize popover. */
export const GUTTER_SECTION_LABELS: Record<GutterSection, string> = {
  modes: 'Navigation Modes',
  panels: 'Panels',
  indicators: 'Indicators',
};

/**
 * Sort a section's items by the user's saved order. Items not present in the
 * saved order (newly added modes, freshly installed extension panels) fall to
 * the end, preserving their declared registry order among themselves.
 */
export function sortBySavedOrder<T extends { id: string }>(
  items: T[],
  savedOrder: string[] | undefined,
): T[] {
  if (!savedOrder || savedOrder.length === 0) return items;
  const rank = new Map<string, number>();
  savedOrder.forEach((id, i) => rank.set(id, i));
  const END = Number.MAX_SAFE_INTEGER;
  // Decorate-sort-undecorate to keep the sort stable for equal ranks (unknowns).
  return items
    .map((item, i) => ({ item, i, r: rank.get(item.id) ?? END }))
    .sort((a, b) => (a.r - b.r) || (a.i - b.i))
    .map((d) => d.item);
}

/**
 * Apply the keep-one-mode guard: returns true if hiding `id` would be allowed.
 * Hiding is blocked only when `id` is the last visible content mode.
 *
 * @param id item being hidden
 * @param modeIds all ids currently in the `modes` section (available items)
 * @param hiddenItems currently hidden ids
 */
export function canHideGutterItem(
  id: string,
  meta: GutterItemMeta,
  modeIds: string[],
  hiddenItems: string[],
): boolean {
  if (!meta.hideable) return false;
  if (meta.section !== 'modes') return true;
  const visibleModes = modeIds.filter((m) => !hiddenItems.includes(m));
  // Blocked only if this is the sole remaining visible mode.
  return !(visibleModes.length <= 1 && visibleModes[0] === id);
}
