import React from "react";
import type { TrackerRecord } from "../../../runtime/src/core/TrackerRecord";
import { type RadarActionItem, type RadarEvent, type RadarLane, type RadarMark, type RadarStalledItem, type TrackerRadarModel } from "@nimbalyst/tracker-core";
export interface DigestMove {
    event: RadarEvent;
    lane: RadarLane;
    item: TrackerRecord;
}
export interface DigestSweep {
    lane: RadarLane;
    mark: RadarMark;
}
export interface DigestStalled {
    lane: RadarLane;
    item: RadarStalledItem;
}
interface TrackerRadarDigestProps {
    radar: TrackerRadarModel;
    needsYou: RadarActionItem[];
    moved: DigestMove[];
    sweeps: DigestSweep[];
    stalled: DigestStalled[];
    eventByAction: ReadonlyMap<string, RadarEvent>;
    laneByActorKey: ReadonlyMap<string, RadarLane>;
    filterLabel?: string;
    selectedItemId?: string | null;
    onClearFilter: () => void;
    onItemSelect?: (itemId: string) => void;
    onOpenDocument?: (itemId: string) => void;
}
export declare function TrackerRadarDigest({ radar, needsYou, moved, sweeps, stalled, eventByAction, laneByActorKey, filterLabel, selectedItemId, onClearFilter, onItemSelect, onOpenDocument, }: TrackerRadarDigestProps): React.JSX.Element;
export {};
