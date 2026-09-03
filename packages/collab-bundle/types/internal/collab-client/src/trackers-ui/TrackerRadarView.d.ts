/** Team activity as a ranked, since-you-left digest. */
import React from "react";
import type { TrackerIdentity } from "../../../runtime/src/core/DocumentService";
import type { TrackerRecord } from "../../../runtime/src/core/TrackerRecord";
import { type RadarLaneEnrichment, type RadarPresence } from "@nimbalyst/tracker-core";
export interface TrackerRadarViewProps {
    items: TrackerRecord[];
    currentIdentity?: TrackerIdentity | null;
    /** Own presence heartbeat; when present the initial range is since this instant. */
    lastSeenAt?: number;
    presenceByActorKey?: Readonly<Record<string, RadarPresence>>;
    enrichmentByActorKey?: Readonly<Record<string, RadarLaneEnrichment>>;
    selectedItemId?: string | null;
    onItemSelect?: (itemId: string) => void;
    onOpenDocument?: (itemId: string) => void;
}
export declare function TrackerRadarView({ items, currentIdentity, lastSeenAt, presenceByActorKey, enrichmentByActorKey, selectedItemId, onItemSelect, onOpenDocument, }: TrackerRadarViewProps): React.JSX.Element;
