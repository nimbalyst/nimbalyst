import React from 'react';
import type { TrackerIdentity } from '../../../runtime/src/core/DocumentService';
import type { TrackerRecord } from '../../../runtime/src/core/TrackerRecord';
export interface TrackerRecentActivityChipProps {
    item: TrackerRecord;
    identity?: TrackerIdentity | null;
    windowHours?: number;
    className?: string;
}
/** Quiet coordination hint; absent when no teammate touched the item recently. */
export declare function TrackerRecentActivityChip({ item, identity, windowHours, className, }: TrackerRecentActivityChipProps): React.JSX.Element | null;
