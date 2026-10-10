/**
 * Gutter badges set by extension panels through `host.setGutterBadge`, and by
 * their backend modules through `ctx.services.panels.setGutterBadge` (applied
 * by store/listeners/panelGutterBadgeListeners.ts). Last writer wins.
 *
 * The value lives here, not in the panel: a fullscreen panel unmounts when the
 * user leaves it, and the badge is how they know to come back. It is cleared
 * by a writer or when the panel stops being registered (the extension was
 * disabled or unloaded), so a removed extension never leaves a count behind on
 * a button that no longer exists. A backend-set badge for a panel that has not
 * registered yet is held until it does: the module can set one before the
 * renderer has loaded the extension.
 */

export type PanelGutterBadgeTone = 'default' | 'warning';

export interface PanelGutterBadge {
  /** 0 renders a dot; a positive count renders the number. */
  count: number;
  tone: PanelGutterBadgeTone;
}

let badges = new Map<string, PanelGutterBadge>();
/** Panel ids registered at the last prune. */
let lastRegistered: ReadonlySet<string> = new Set();
/** Backend-set badges whose panel has not registered yet; prune keeps them. */
const awaitingRegistration = new Set<string>();
const listeners = new Set<() => void>();

function publish(next: Map<string, PanelGutterBadge>): void {
  badges = next;
  for (const listener of listeners) listener();
}

/**
 * `null` clears. Counts are floored at 0; a non-finite count clears.
 * `holdUntilRegistered` (backend writes) keeps the badge through prunes until
 * the panel first registers.
 */
export function setPanelGutterBadge(
  panelId: string,
  value: number | null,
  tone: PanelGutterBadgeTone = 'default',
  options?: { holdUntilRegistered?: boolean },
): void {
  const current = badges.get(panelId);
  if (value === null || !Number.isFinite(value)) {
    awaitingRegistration.delete(panelId);
    if (!current) return;
    const next = new Map(badges);
    next.delete(panelId);
    publish(next);
    return;
  }
  const count = Math.max(0, Math.floor(value));
  if (options?.holdUntilRegistered && !lastRegistered.has(panelId)) awaitingRegistration.add(panelId);
  if (current && current.count === count && current.tone === tone) return;
  publish(new Map(badges).set(panelId, { count, tone }));
}

/** Drop badges for panels that are no longer registered. */
export function prunePanelGutterBadges(registeredPanelIds: ReadonlySet<string>): void {
  lastRegistered = new Set(registeredPanelIds);
  for (const id of registeredPanelIds) awaitingRegistration.delete(id);
  const stale = [...badges.keys()].filter((id) => !registeredPanelIds.has(id) && !awaitingRegistration.has(id));
  if (stale.length === 0) return;
  const next = new Map(badges);
  for (const id of stale) next.delete(id);
  publish(next);
}

export function getPanelGutterBadge(panelId: string): PanelGutterBadge | undefined {
  return badges.get(panelId);
}

export function subscribePanelGutterBadges(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
