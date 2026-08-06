/**
 * Built-in tracker item type identity — the icon and accent color for `bug`,
 * `task`, `decision` and friends.
 *
 * This lives on its own, with no imports, because two very different surfaces
 * need it and only one of them can afford the tracker plugin:
 *
 * - The tracker table (`trackerColumns.ts`), which consults `globalRegistry`
 *   first so an extension-registered type wins, then falls back to here.
 * - The messaging Inbox in the organization window, which renders a delivery
 *   about a tracker item it may never have synced. There is no registry there
 *   and no item to read — only the type name the delivery carried — so the
 *   built-in map is the whole answer.
 *
 * Keeping one copy is the point: a duplicated map drifts silently the moment a
 * type is added, and the drift shows up as the wrong icon rather than an error.
 */

export const DEFAULT_TRACKER_TYPE_ICONS: Readonly<Record<string, string>> = {
  bug: 'bug_report',
  task: 'check_box',
  plan: 'assignment',
  idea: 'lightbulb',
  decision: 'gavel',
  automation: 'auto_mode',
  feature: 'rocket_launch',
};

export const DEFAULT_TRACKER_TYPE_COLORS: Readonly<Record<string, string>> = {
  bug: '#dc2626',
  task: '#2563eb',
  plan: '#7c3aed',
  idea: '#ca8a04',
  decision: '#8b5cf6',
  automation: '#60a5fa',
  feature: '#10b981',
};

/** Icon for a built-in tracker type; `label` for anything unrecognized. */
export function defaultTrackerTypeIcon(type: string): string {
  return DEFAULT_TRACKER_TYPE_ICONS[type] ?? 'label';
}

/** Accent for a built-in tracker type; neutral gray for anything unrecognized. */
export function defaultTrackerTypeColor(type: string): string {
  return DEFAULT_TRACKER_TYPE_COLORS[type] ?? '#6b7280';
}
