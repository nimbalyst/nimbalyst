/**
 * Host context for the shared tracker surfaces.
 *
 * Two hosts render these components and they differ in one structural way, not
 * in a hundred cosmetic ones: desktop has a personal lane (favorites, unread
 * dots, snooze) behind a personal JWT, and a browser tab does not.
 *
 * The affordances themselves are not gated here -- they are not in this package
 * at all. `TrackerBoardCard` and `TrackerListView` take the star and the dot as
 * slots the host fills, so a host with no personal lane has nothing to pass and
 * the modules never enter its bundle graph. That is structural; a capability
 * flag is only a conditional, and a conditional is one careless edit from being
 * inverted.
 *
 * What remains here is the part a slot cannot express: whether a saved view's
 * `favorite` / `viewed` clauses can be answered at all (`useTrackerViewRows`,
 * decision 11 -- a personal clause is marked, never silently dropped).
 *
 * **The default is no personal capabilities.** A host that means to enable them
 * says so; a tree rendered with no provider gets the safe answer rather than the
 * permissive one. Absence is deliberate and it is not faked: no local stand-in,
 * no localStorage shadow, nothing that would show one answer here and a
 * different one on desktop.
 */

import React, { createContext, useContext, useEffect, useMemo } from 'react';
import { Provider as JotaiProvider } from 'jotai';
import { store } from '@nimbalyst/runtime/store';
import type {
  TrackerDataSource,
  TrackerIdentity,
  TrackerViewMode,
} from '@nimbalyst/collab-client/trackers';
import { createTrackerDataStore, type TrackerDataStore } from './trackerDataStore';

export interface TrackerUICapabilities {
  /**
   * Personal-lane affordances: the favorite star, the unread dot, snooze.
   * False in a browser tab, which holds team auth only.
   */
  personalState: boolean;
  /** Saved-view modes this host can render without substituting another mode. */
  renderableViewModes: ReadonlySet<TrackerViewMode>;
}

/** Opt-in. Only a host that actually holds a personal JWT may pass this. */
export const DESKTOP_TRACKER_UI_CAPABILITIES: TrackerUICapabilities = {
  personalState: true,
  renderableViewModes: new Set<TrackerViewMode>(['list', 'table', 'kanban', 'timeline', 'radar', 'tag-board', 'inbox']),
};
/** The default, everywhere: no provider and no `capabilities` prop both land here. */
export const BROWSER_TRACKER_UI_CAPABILITIES: TrackerUICapabilities = {
  personalState: false,
  renderableViewModes: new Set<TrackerViewMode>(['list', 'table', 'kanban', 'timeline', 'radar', 'tag-board']),
};

export interface TrackersUIContextValue {
  /** Absent when a host renders a leaf component outside a tracker surface. */
  dataSource: TrackerDataSource | null;
  /** One projection store shared by every consumer below this provider. */
  dataStore: TrackerDataStore | null;
  /** Who "me" is, for assignment-based queues. Comes from the team JWT in the browser. */
  identity: TrackerIdentity | null;
  capabilities: TrackerUICapabilities;
}

/**
 * `null`, not a permissive default value: "no provider" and "a provider that
 * granted nothing" must be distinguishable, so the accessors below can fail
 * closed on the first and throw on the second where a host is genuinely
 * required.
 */
const TrackersUIContext = createContext<TrackersUIContextValue | null>(null);

export interface TrackersUIProviderProps {
  /** Optional: a host may mount navigation or a card before a room is joined. */
  dataSource?: TrackerDataSource | null;
  identity: TrackerIdentity | null;
  capabilities?: TrackerUICapabilities;
  children: React.ReactNode;
}

export function TrackersUIProvider({
  dataSource,
  identity,
  capabilities = BROWSER_TRACKER_UI_CAPABILITIES,
  children,
}: TrackersUIProviderProps) {
  const dataStore = useMemo(
    () => dataSource ? createTrackerDataStore(dataSource) : null,
    [dataSource],
  );
  useEffect(() => {
    dataStore?.start();
    return () => dataStore?.stop();
  }, [dataStore]);
  const value = useMemo(
    () => ({ dataSource: dataSource ?? null, dataStore, identity, capabilities }),
    [dataSource, dataStore, identity, capabilities],
  );
  return (
    <JotaiProvider store={store}>
      <TrackersUIContext.Provider value={value}>{children}</TrackersUIContext.Provider>
    </JotaiProvider>
  );
}

export function useTrackersUI(): TrackersUIContextValue {
  const value = useContext(TrackersUIContext);
  if (!value) throw new Error('Tracker surfaces must be rendered inside TrackersUIProvider');
  return value;
}

/**
 * Deliberately non-throwing, and deliberately closed: a leaf rendered with no
 * provider gets no personal capabilities. The permissive answer used to be the
 * default, which made every consumer's safety a property of who happened to
 * mount it rather than of this file.
 */
export function useTrackerUICapabilities(): TrackerUICapabilities {
  return useContext(TrackersUIContext)?.capabilities ?? BROWSER_TRACKER_UI_CAPABILITIES;
}

export function useTrackerDataSourceOrThrow(): TrackerDataSource {
  const dataSource = useContext(TrackersUIContext)?.dataSource;
  if (!dataSource) throw new Error('Tracker surfaces must be rendered inside TrackersUIProvider');
  return dataSource;
}

export function useTrackerDataStoreOrThrow(): TrackerDataStore {
  const dataStore = useContext(TrackersUIContext)?.dataStore;
  if (!dataStore) throw new Error('Tracker surfaces must be rendered inside TrackersUIProvider');
  return dataStore;
}
