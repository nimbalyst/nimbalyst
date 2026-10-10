import { useEffect, useMemo, type RefObject } from 'react';
import type { SortingConfig } from '@revolist/revogrid';

export interface GridViewSettings {
  sortBy?: string;
  sortDirection?: 'asc' | 'desc';
  sortColumns?: Array<{ field: string; direction: 'asc' | 'desc' }>;
  onSortChange?: (field: string, direction: 'asc' | 'desc') => void;
  onWidthsChange?: (widths: Record<string, number>) => void;
}

/** Native grid gestures use the same persistence callback as view settings. */
export function useGridViewSettings(root: RefObject<HTMLDivElement | null>, settings: GridViewSettings, visible: readonly { id: string }[]) {
  const { sortBy, sortDirection = 'desc', sortColumns, onSortChange, onWidthsChange } = settings;
  useEffect(() => {
    if (!onSortChange && !onWidthsChange) return;
    const sort = (event: Event) => {
      if (!onSortChange) return;
      const detail = (event as CustomEvent<{ column?: { prop?: string } }>).detail;
      const field = detail?.column?.prop;
      if (!field || !visible.some(column => column.id === field)) return;
      event.preventDefault();
      onSortChange(field, sortBy === field && sortDirection === 'desc' ? 'asc' : 'desc');
    };
    const resize = (event: Event) => {
      const detail = (event as CustomEvent<Record<string, { prop?: string; size?: number }>>).detail;
      const widths: Record<string, number> = {};
      for (const column of Object.values(detail ?? {})) {
        if (column?.prop && visible.some(field => field.id === column.prop) && Number.isFinite(column.size)) widths[column.prop] = Math.max(40, Math.min(2000, column.size!));
      }
      if (Object.keys(widths).length) onWidthsChange?.(widths);
    };
    // Plugin sorting events do not bubble. Capture also survives grid remounts.
    const element = root.current;
    element?.addEventListener('beforesorting', sort, true);
    element?.addEventListener('aftercolumnresize', resize, true);
    return () => {
      element?.removeEventListener('beforesorting', sort, true);
      element?.removeEventListener('aftercolumnresize', resize, true);
    };
  }, [root, sortBy, sortDirection, onSortChange, onWidthsChange, visible]);
  return useMemo<SortingConfig | undefined>(() => {
    const columns = (sortColumns?.length ? sortColumns : sortBy ? [{ field: sortBy, direction: sortDirection }] : [])
      .filter(sort => visible.some(column => column.id === sort.field))
      .map(sort => ({ prop: sort.field, order: sort.direction }));
    return columns.length ? { columns } : undefined;
  }, [sortBy, sortDirection, sortColumns, visible]);
}
