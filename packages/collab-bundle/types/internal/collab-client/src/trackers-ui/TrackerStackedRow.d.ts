import React from 'react';
import type { TrackerRecord } from '../../../runtime/src/core/TrackerRecord';
export declare function TrackerStackedRow({ item, selected, showType, onOpen }: {
    item: TrackerRecord;
    selected: boolean;
    showType: boolean;
    onOpen: () => void;
}): React.JSX.Element;
