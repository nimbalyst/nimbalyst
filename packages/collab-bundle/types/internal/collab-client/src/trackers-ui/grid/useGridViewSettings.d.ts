import { type RefObject } from 'react';
import type { SortingConfig } from '@revolist/revogrid';
export interface GridViewSettings {
    sortBy?: string;
    sortDirection?: 'asc' | 'desc';
    sortColumns?: Array<{
        field: string;
        direction: 'asc' | 'desc';
    }>;
    onSortChange?: (field: string, direction: 'asc' | 'desc') => void;
    onWidthsChange?: (widths: Record<string, number>) => void;
}
/** Native grid gestures use the same persistence callback as view settings. */
export declare function useGridViewSettings(root: RefObject<HTMLDivElement | null>, settings: GridViewSettings, visible: readonly {
    id: string;
}[]): SortingConfig | undefined;
