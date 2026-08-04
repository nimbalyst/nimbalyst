/**
 * Splits a tracker type's fields into the chip row and the leftovers.
 *
 * `getTrackerFieldLayout` decides which fields a compact surface shows and in
 * what order. A surface that replaces a full form with chips still has to
 * account for the rest of the schema: fields the layout drops (opaque objects,
 * multiselects, read-only values) and arrays of objects, which have no one-line
 * form at all. This puts that split in one place so every chip surface makes the
 * same call, and so a surface can exclude a field it renders itself (Tracker
 * Mode's detail pane keeps tags as an always-open row).
 */

import { useMemo } from 'react';
import { globalRegistry } from '../models';
import type { FieldDefinition } from '../models/TrackerDataModel';
import { getTrackerFieldLayout } from './trackerFieldLayout';

/** Structural fields the surrounding chrome renders; neither chip nor overflow. */
const CHROME_FIELDS = new Set(['title', 'description', 'created', 'updated']);

/**
 * True when one chip can carry this field's value. An array of objects (a
 * plan's `agentSessions`, say) has no readable one-line form -- it stringifies
 * to `[object Object]` -- so it never becomes a chip.
 */
export function isChipRenderableField(field: FieldDefinition): boolean {
  return !(field.type === 'array' && field.itemType === 'object');
}

/**
 * The type's tags field, whatever the schema calls it. Surfaces that keep tags
 * as an always-open row (they're edited far more often than they're read) pull
 * it out of the chip row with this.
 */
export function getTrackerTagsField(trackerType: string): FieldDefinition | null {
  const model = globalRegistry.get(trackerType);
  if (!model) return null;
  const name = model.roles?.tags ?? 'tags';
  return model.fields.find((field) => field.name === name) ?? null;
}

export interface TrackerChipFieldSections {
  /** Fields for the chip row, in shared layout order. */
  chipFields: FieldDefinition[];
  /** Fields no chip can present; the surface places or omits these itself. */
  overflowFields: FieldDefinition[];
}

/**
 * @param trackerType Registered tracker type name.
 * @param exclude Field names the surface renders on its own, in neither section.
 */
export function getTrackerChipFieldSections(
  trackerType: string,
  exclude: readonly string[] = [],
): TrackerChipFieldSections {
  const excluded = new Set(exclude);
  const chipFields = getTrackerFieldLayout(trackerType).filter(
    (field) => !excluded.has(field.name) && isChipRenderableField(field),
  );
  const chipNames = new Set(chipFields.map((field) => field.name));
  const overflowFields = (globalRegistry.get(trackerType)?.fields ?? []).filter(
    (field) => !CHROME_FIELDS.has(field.name)
      && !excluded.has(field.name)
      && !chipNames.has(field.name),
  );
  return { chipFields, overflowFields };
}

/** Memoized `getTrackerChipFieldSections` for component use. */
export function useTrackerChipFieldSections(
  trackerType: string,
  exclude: readonly string[] = [],
): TrackerChipFieldSections {
  const excludeKey = exclude.join('\u0000');
  return useMemo(
    () => getTrackerChipFieldSections(trackerType, excludeKey ? excludeKey.split('\u0000') : []),
    [trackerType, excludeKey],
  );
}
