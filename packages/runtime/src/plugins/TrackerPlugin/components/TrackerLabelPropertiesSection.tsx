/**
 * The label-driven part of an item's detail view that the chip row cannot
 * carry: properties a label lists whose storage the vocabulary cannot resolve,
 * flagged rather than dropped.
 *
 * Field-stored properties are edited in the chip row. Qualifiers stored beside
 * a value (`{ value, qualifiers }`) and claim-stored properties belong to the
 * earlier knowledge graph; they are kept on save but no longer shown here.
 */

import React from 'react';
import { MaterialSymbol } from '../../../ui/icons/MaterialSymbol';
import type { TrackerLabelFieldLayout } from './trackerLabelFields';

export interface TrackerLabelPropertiesSectionProps {
  layout: TrackerLabelFieldLayout;
}

export const TrackerLabelPropertiesSection: React.FC<TrackerLabelPropertiesSectionProps> = ({ layout }) => {
  if (layout.unknown.length === 0) return null;

  return (
    <div
      className="tracker-label-properties tracker-label-properties-unknown flex flex-wrap items-center gap-1.5 pt-1 border-t border-nim"
      data-testid="tracker-label-properties-unknown"
    >
      <MaterialSymbol icon="warning" size={14} className="text-[var(--nim-warning)]" />
      <span className="text-[11px] text-nim-muted">Undeclared properties:</span>
      {layout.unknown.map(property => (
        <span
          key={property.id}
          className="tracker-label-property-unknown text-[11px] font-mono text-nim-muted"
          title={`'${property.id}' is listed by the '${property.viaLabel}' label but is neither a field property nor a predicate`}
        >
          {property.id}
        </span>
      ))}
    </div>
  );
};
