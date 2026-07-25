import { atom } from 'jotai';
import { trackerPersonalStateService, type TrackerPersonalStateDto } from '../../services/RendererTrackerPersonalStateService';

interface TrackerPersonalStateSnapshot {
  workspacePath: string | null;
  scope: string | null;
  identityEmail: string | null;
  hydrated: boolean;
  rowsByItemId: Map<string, TrackerPersonalStateDto>;
}

const emptySnapshot = (workspacePath: string | null, identityEmail: string | null): TrackerPersonalStateSnapshot => ({
  workspacePath,
  scope: null,
  identityEmail,
  hydrated: false,
  rowsByItemId: new Map(),
});

export const trackerPersonalStateAtom = atom<TrackerPersonalStateSnapshot>(emptySnapshot(null, null));
export const trackerPersonalStateHydratedAtom = atom((get) => get(trackerPersonalStateAtom).hydrated);
export const favoriteTrackerItemIdsAtom = atom((get) => {
  const ids = new Set<string>();
  for (const row of get(trackerPersonalStateAtom).rowsByItemId.values()) {
    if (row.isFavorite) ids.add(row.itemId);
  }
  return ids as ReadonlySet<string>;
});
export const trackerSnoozedUntilByItemIdAtom = atom((get) => {
  const snoozed = new Map<string, number>();
  for (const row of get(trackerPersonalStateAtom).rowsByItemId.values()) {
    if (row.snoozedUntil != null) snoozed.set(row.itemId, row.snoozedUntil);
  }
  return snoozed as ReadonlyMap<string, number>;
});
export const trackerViewedAtByItemIdAtom = atom((get) => {
  const viewed = new Map<string, number>();
  for (const row of get(trackerPersonalStateAtom).rowsByItemId.values()) {
    if (row.lastOpenedAt != null) viewed.set(row.itemId, row.lastOpenedAt);
  }
  return viewed as ReadonlyMap<string, number>;
});

/** Clear first, then hydrate; the key check prevents stale account/workspace responses leaking in. */
export const hydrateTrackerPersonalStateAtom = atom(null, async (_get, set, input: {
  workspacePath: string | undefined;
  identityEmail: string | null;
}) => {
  const workspacePath = input.workspacePath ?? null;
  set(trackerPersonalStateAtom, emptySnapshot(workspacePath, input.identityEmail));
  if (!workspacePath) return;
  try {
    const hydration = await trackerPersonalStateService.getForScope(workspacePath);
    set(trackerPersonalStateAtom, (current) => {
      if (current.workspacePath !== workspacePath || current.identityEmail !== input.identityEmail) return current;
      return {
        ...current,
        scope: hydration.scope,
        hydrated: true,
        rowsByItemId: new Map(hydration.rows.map((row) => [row.itemId, row])),
      };
    });
  } catch (error) {
    console.error('[trackerPersonalState] Failed to hydrate:', error);
    set(trackerPersonalStateAtom, (current) => current.workspacePath === workspacePath
      && current.identityEmail === input.identityEmail ? { ...current, hydrated: true } : current);
  }
});

export const setTrackerFavoriteAtom = atom(null, async (get, set, input: { itemId: string; isFavorite: boolean }) => {
  const current = get(trackerPersonalStateAtom);
  if (!current.workspacePath || !current.scope || !current.hydrated) return;
  const favoriteUpdatedAt = Date.now();
  const previous = current.rowsByItemId.get(input.itemId);
  const optimistic: TrackerPersonalStateDto = {
    userEmail: current.identityEmail ?? '',
    scope: current.scope,
    itemId: input.itemId,
    isFavorite: input.isFavorite,
    favoriteUpdatedAt,
    lastOpenedAt: previous?.lastOpenedAt ?? null,
    snoozedUntil: previous?.snoozedUntil ?? null,
    updatedAt: Math.max(previous?.updatedAt ?? 0, favoriteUpdatedAt),
  };
  set(trackerPersonalStateAtom, { ...current, rowsByItemId: new Map(current.rowsByItemId).set(input.itemId, optimistic) });
  try {
    const row = await trackerPersonalStateService.setFavorite({
      workspacePath: current.workspacePath,
      itemId: input.itemId,
      isFavorite: input.isFavorite,
      favoriteUpdatedAt,
    });
    if (row) set(applyTrackerPersonalStateRowAtom, row);
  } catch (error) {
    console.error('[trackerPersonalState] Failed to set favorite:', error);
    set(trackerPersonalStateAtom, (latest) => {
      if (latest.rowsByItemId.get(input.itemId)?.favoriteUpdatedAt !== favoriteUpdatedAt) return latest;
      const rows = new Map(latest.rowsByItemId);
      if (previous) rows.set(input.itemId, previous); else rows.delete(input.itemId);
      return { ...latest, rowsByItemId: rows };
    });
  }
});

/**
 * Snooze an item out of this user's triage inbox until `snoozedUntil`, or pass
 * null to bring it back now. Optimistic so the queue advances immediately.
 */
export const setTrackerSnoozeAtom = atom(null, async (get, set, input: { itemId: string; snoozedUntil: number | null }) => {
  const current = get(trackerPersonalStateAtom);
  if (!current.workspacePath || !current.scope || !current.hydrated) return;
  const updatedAt = Date.now();
  const previous = current.rowsByItemId.get(input.itemId);
  const optimistic: TrackerPersonalStateDto = {
    userEmail: current.identityEmail ?? '',
    scope: current.scope,
    itemId: input.itemId,
    isFavorite: previous?.isFavorite ?? false,
    favoriteUpdatedAt: previous?.favoriteUpdatedAt ?? 0,
    lastOpenedAt: previous?.lastOpenedAt ?? null,
    snoozedUntil: input.snoozedUntil,
    updatedAt,
  };
  set(trackerPersonalStateAtom, { ...current, rowsByItemId: new Map(current.rowsByItemId).set(input.itemId, optimistic) });
  try {
    const row = await trackerPersonalStateService.setSnooze({
      workspacePath: current.workspacePath,
      itemId: input.itemId,
      snoozedUntil: input.snoozedUntil,
    });
    if (row) set(applyTrackerPersonalStateRowAtom, row);
  } catch (error) {
    console.error('[trackerPersonalState] Failed to set snooze:', error);
    set(trackerPersonalStateAtom, (latest) => {
      if (latest.rowsByItemId.get(input.itemId)?.updatedAt !== updatedAt) return latest;
      const rows = new Map(latest.rowsByItemId);
      if (previous) rows.set(input.itemId, previous); else rows.delete(input.itemId);
      return { ...latest, rowsByItemId: rows };
    });
  }
});

export const recordTrackerOpenedAtom = atom(null, async (get, set, input: { itemId: string; openedAt: number }) => {
  const current = get(trackerPersonalStateAtom);
  if (!current.workspacePath || !current.scope || !current.hydrated) return;
  try {
    const row = await trackerPersonalStateService.recordOpened({
      workspacePath: current.workspacePath,
      itemId: input.itemId,
      lastOpenedAt: input.openedAt,
    });
    if (row) set(applyTrackerPersonalStateRowAtom, row);
  } catch (error) {
    console.error('[trackerPersonalState] Failed to record open:', error);
  }
});

export const applyTrackerPersonalStateRowAtom = atom(null, (get, set, row: TrackerPersonalStateDto) => {
  const current = get(trackerPersonalStateAtom);
  if (!current.hydrated || current.scope !== row.scope) return;
  if ((current.identityEmail ?? '').toLowerCase() !== row.userEmail.toLowerCase()) return;
  const previous = current.rowsByItemId.get(row.itemId);
  const merged = previous ? {
    ...row,
    isFavorite: row.favoriteUpdatedAt >= previous.favoriteUpdatedAt
      ? row.isFavorite
      : previous.isFavorite,
    favoriteUpdatedAt: Math.max(previous.favoriteUpdatedAt, row.favoriteUpdatedAt),
    lastOpenedAt: Math.max(previous.lastOpenedAt ?? 0, row.lastOpenedAt ?? 0) || null,
    // Snooze is last-write-wins on `updatedAt` -- taking the max would make an
    // un-snooze (null) impossible to express.
    snoozedUntil: row.updatedAt >= previous.updatedAt ? row.snoozedUntil : previous.snoozedUntil,
    updatedAt: Math.max(previous.updatedAt, row.updatedAt),
  } : row;
  set(trackerPersonalStateAtom, {
    ...current,
    rowsByItemId: new Map(current.rowsByItemId).set(row.itemId, merged),
  });
});
