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
import React from 'react';
import type { TeamMemberOption } from '../../../runtime/src/plugins/TrackerPlugin/components/TrackerFieldEditor';
import type { TrackerDataSource, TrackerIdentity, TrackerViewMode } from '../trackers/index';
import { type TrackerDataStore } from './trackerDataStore';
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
export declare const DESKTOP_TRACKER_UI_CAPABILITIES: TrackerUICapabilities;
/** The default, everywhere: no provider and no `capabilities` prop both land here. */
export declare const BROWSER_TRACKER_UI_CAPABILITIES: TrackerUICapabilities;
export interface TrackersUIContextValue {
    /** Absent when a host renders a leaf component outside a tracker surface. */
    dataSource: TrackerDataSource | null;
    /** One projection store shared by every consumer below this provider. */
    dataStore: TrackerDataStore | null;
    /** Who "me" is, for assignment-based queues. Comes from the team JWT in the browser. */
    identity: TrackerIdentity | null;
    capabilities: TrackerUICapabilities;
    /** Who a `user` field can name. Empty without a team, and people cells fall back to free text. */
    teamMembers: readonly TeamMemberOption[];
}
export interface TrackersUIProviderProps {
    /** Optional: a host may mount navigation or a card before a room is joined. */
    dataSource?: TrackerDataSource | null;
    identity: TrackerIdentity | null;
    capabilities?: TrackerUICapabilities;
    teamMembers?: readonly TeamMemberOption[];
    children: React.ReactNode;
}
export declare function TrackersUIProvider({ dataSource, identity, capabilities, teamMembers, children, }: TrackersUIProviderProps): React.JSX.Element;
export declare function useTrackersUI(): TrackersUIContextValue;
/**
 * Deliberately non-throwing, and deliberately closed: a leaf rendered with no
 * provider gets no personal capabilities. The permissive answer used to be the
 * default, which made every consumer's safety a property of who happened to
 * mount it rather than of this file.
 */
export declare function useTrackerUICapabilities(): TrackerUICapabilities;
export declare function useTrackersUITeamMembers(): readonly TeamMemberOption[];
export declare function useTrackerDataSourceOrThrow(): TrackerDataSource;
export declare function useTrackerDataStoreOrThrow(): TrackerDataStore;
