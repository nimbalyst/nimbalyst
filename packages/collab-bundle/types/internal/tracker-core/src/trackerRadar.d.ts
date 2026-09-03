/**
 * Pure, host-neutral layout model for the Team Work Radar tracker view.
 *
 * Radar consumes only tracker records that already sync. Browser and desktop
 * hosts may add presence or local enrichment, but every field beyond the
 * tracker event spine is optional by design.
 */
import type { TrackerActivity, TrackerIdentity } from "./types.js";
import type { TrackerRecord } from "./trackerRecord.js";
export type RadarActivityAction = TrackerActivity["action"];
export type RadarEventSource = "activity" | "comment" | "fallback";
export interface RadarEvent {
    id: string;
    itemId: string;
    actor: TrackerIdentity;
    actorKey: string;
    action: RadarActivityAction;
    timestamp: number;
    source: RadarEventSource;
    field?: string;
    oldValue?: string;
    newValue?: string;
    note?: string;
    body?: string;
}
export interface RadarSegment {
    state: string;
    startAt: number;
    endAt: number;
}
export interface RadarPresence {
    status: "online" | "away" | "offline";
    lastHeartbeatAt?: number;
}
export interface RadarLaneEnrichment {
    liveSessions?: number;
    unpushedCommits?: number;
    divergence?: string;
}
export interface RadarMark {
    id: string;
    kind: "thread" | "run";
    actorKey: string;
    itemIds: string[];
    items: TrackerRecord[];
    primaryType: string;
    label: string;
    state: string;
    startAt: number;
    endAt: number;
    lastActivityAt: number;
    row: number;
    events: RadarEvent[];
    segments: RadarSegment[];
    agentDriven: boolean;
    hasCommit: boolean;
    truncatedStart: boolean;
}
export interface RadarStalledItem {
    itemId: string;
    issueKey?: string;
    title: string;
    state: string;
    lastActivityAt: number;
}
export interface RadarLane {
    actor: TrackerIdentity;
    actorKey: string;
    isCurrentUser: boolean;
    isAutomation: boolean;
    summary: string;
    lastActivityAt: number;
    marks: RadarMark[];
    subRowCount: number;
    stalled: RadarStalledItem[];
    presence?: RadarPresence;
    enrichment?: RadarLaneEnrichment;
}
export type RadarTieType = "overlap" | "hand-off" | "review";
export interface RadarTie {
    itemId: string;
    issueKey?: string;
    title: string;
    type: RadarTieType;
    fromActorKey: string;
    toActorKey: string;
    fromAt: number;
    toAt: number;
}
export interface RadarActionItem {
    itemId: string;
    issueKey?: string;
    title: string;
    actor: TrackerIdentity;
    at: number;
    reason: "commented" | "reviewed" | "handed-off" | "updated";
}
export interface TrackerRadarModel {
    windowStart: number;
    windowEnd: number;
    windowHours: number;
    windowSource: "preset" | "since-left" | "default";
    lanes: RadarLane[];
    ties: RadarTie[];
    waitingOnYou: RadarActionItem[];
    youHandedOff: RadarActionItem[];
}
export interface RadarWindowOptions {
    nowMs?: number;
    windowHours?: number;
    lastSeenAt?: number;
}
export interface ResolvedRadarWindow {
    startAt: number;
    endAt: number;
    windowHours: number;
    source: "preset" | "since-left" | "default";
}
export interface BuildTrackerRadarOptions extends RadarWindowOptions {
    currentIdentity?: TrackerIdentity | null;
    presenceByActorKey?: Readonly<Record<string, RadarPresence>>;
    enrichmentByActorKey?: Readonly<Record<string, RadarLaneEnrichment>>;
    runGapMs?: number;
    runMinItems?: number;
    overlapMs?: number;
    stalledAfterMs?: number;
    getTitle?: (record: TrackerRecord) => string;
    getStatus?: (record: TrackerRecord) => string;
}
export interface RecentTeammateActivity {
    actor: TrackerIdentity;
    action: RadarActivityAction;
    at: number;
    relativeLabel: string;
    summary: string;
}
export declare function resolveRadarWindow(options?: RadarWindowOptions): ResolvedRadarWindow;
export declare function trackerRadarActorKey(identity: TrackerIdentity | null | undefined): string;
/** Normalize the historical malformed writer shapes before any layout logic. */
export declare function normalizeTrackerRadarEvents(record: TrackerRecord): RadarEvent[];
export declare function buildTrackerRadar(records: readonly TrackerRecord[], options?: BuildTrackerRadarOptions): TrackerRadarModel;
export declare function formatRadarRelativeTime(at: number, nowMs: number): string;
export declare function getRecentTeammateActivity(record: TrackerRecord, currentIdentity: TrackerIdentity | null | undefined, nowMs?: number, windowHours?: number): RecentTeammateActivity | null;
