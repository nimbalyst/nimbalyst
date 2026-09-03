/**
 * The tracker table's Type indicator, in both the shapes the table needs: the
 * grid's Type cell and the row list's leading gutter.
 *
 * Lifted out of TrackerTable so the resolution rules live in one small place: a
 * type's glyph, color and name all come from the type's own schema, with a
 * visible fallback for a type that declares none. The column used to read a
 * hardcoded map of the seven built-in types, so a workspace running custom types
 * got a blank indicator on most of its rows (nimbalyst#1422).
 */

import React from 'react';
import { getTypeColor, getTypeIcon, getTypeLabel, type TypeColumnDisplay } from './trackerColumns';

interface TrackerTypeCellProps {
  type: string;
  /** Glyph (the default) or the type's name. */
  display?: TypeColumnDisplay;
  /**
   * `cell` is the grid column. `row` is the list row's leading gutter, which
   * draws a slightly larger, dimmer glyph to sit under the title.
   */
  variant?: 'cell' | 'row';
}

export const TrackerTypeCell: React.FC<TrackerTypeCellProps> = ({ type, display, variant = 'cell' }) => {
  const color = getTypeColor(type);
  const label = getTypeLabel(type);
  const isRow = variant === 'row';

  if (display === 'label') {
    return (
      <span
        className={`tracker-type-indicator type-label truncate text-[12px] font-medium ${isRow ? 'shrink-0 max-w-[120px]' : ''}`}
        style={{ color, opacity: isRow ? 0.85 : undefined }}
        title={label}
      >
        {label}
      </span>
    );
  }

  return (
    <span
      className={isRow
        ? 'tracker-type-indicator type-icon shrink-0 w-5 flex items-center justify-center'
        : 'tracker-type-indicator type-icon flex items-center justify-center w-5 h-5 rounded'}
      style={{ color, opacity: isRow ? 0.7 : undefined }}
      title={label}
    >
      <span
        className="material-symbols-outlined text-sm"
        style={isRow ? { fontSize: '16px', fontVariationSettings: "'wght' 300" } : undefined}
      >
        {getTypeIcon(type)}
      </span>
    </span>
  );
};
