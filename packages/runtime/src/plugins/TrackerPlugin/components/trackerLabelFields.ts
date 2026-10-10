/**
 * Fields that follow labels.
 *
 * An item's fields are its type's fields plus the properties its labels bring
 * (`effectiveProperties`, see `labelRegistry.ts`). This turns those properties
 * into what a field surface needs:
 *
 *  - FIELD-stored properties become synthetic `FieldDefinition`s, so the chip
 *    row, the detail pane and the status bar edit them with the editors every
 *    other field uses. They appear empty the moment a label is added.
 *  - Properties whose storage cannot be resolved are listed so a surface can
 *    flag them rather than drop them.
 *
 * Claim-stored properties from the earlier knowledge graph are not shown.
 * A field property that declares qualifiers stores `{ value, qualifiers }`;
 * {@link unwrapLabelFieldValue} and {@link wrapLabelFieldValue} let a chip edit
 * the bare value without dropping the qualifiers already stored beside it.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  globalRegistry,
  isQualifiedFieldProperty,
  itemOwnLabels,
  type EffectiveProperty,
  type FieldDefinition,
  type FieldPropertyDefinition,
  type FieldType,
  type LabeledItem,
  type TrackerDataModelRegistry,
} from '@nimbalyst/tracker-schema';

/** A field synthesized from a label's field-stored property. */
export interface LabelFieldDefinition extends FieldDefinition {
  /** The property declaration this field was built from. */
  labelProperty: FieldPropertyDefinition;
  /** The label that brought the property (first in resolution order). */
  viaLabel: string;
  /** Header text; property ids are kebab-case and read badly formatted. */
  displayLabel: string;
}

export interface TrackerLabelFieldLayout {
  /** Field-stored properties the type does not already declare, in resolution order. */
  fields: LabelFieldDefinition[];
  /** Properties that are neither a field property, a predicate, nor a type field. */
  unknown: EffectiveProperty[];
}

const EMPTY_LAYOUT: TrackerLabelFieldLayout = { fields: [], unknown: [] };

export function isLabelFieldDefinition(field: FieldDefinition): field is LabelFieldDefinition {
  return 'labelProperty' in field;
}

/** Map a property declaration onto the field model the editors already understand. */
export function labelPropertyToFieldDefinition(property: FieldPropertyDefinition, viaLabel: string): LabelFieldDefinition {
  const base = {
    name: property.id,
    labelProperty: property,
    viaLabel,
    displayLabel: property.label,
  };
  switch (property.type) {
    case 'select':
    case 'multiselect':
      return {
        ...base,
        type: property.type,
        options: (property.options ?? []).map(option => (typeof option === 'string'
          ? { value: option, label: option }
          : { value: option.value, label: option.label ?? option.value, icon: option.icon, color: option.color })),
      };
    case 'relationship':
      return { ...base, type: 'relationship', multiValue: property.multiValue === true, targetTrackerTypes: '*' };
    case 'array':
      return { ...base, type: 'array', itemType: 'string' };
    default:
      return { ...base, type: property.type as FieldType };
  }
}

/**
 * Resolve the label-driven part of an item's fields. `values` is the item's
 * field bag (`record.fields`, or a document's frontmatter), read for `labels`
 * and the legacy `kind`.
 */
export function resolveTrackerLabelFields(
  trackerType: string,
  values: LabeledItem | null | undefined,
  registry: TrackerDataModelRegistry = globalRegistry,
): TrackerLabelFieldLayout {
  // Only a type with a `label-ref` field carries labels; a bug's free-form tag
  // `feature` must not bring the feature label's properties.
  if (!values || !registry.acceptsLabels(trackerType) || itemOwnLabels(values).length === 0) return EMPTY_LAYOUT;
  const declared = new Set((registry.get(trackerType)?.fields ?? []).map(field => field.name));
  const layout: TrackerLabelFieldLayout = { fields: [], unknown: [] };
  for (const property of registry.effectiveProperties(values)) {
    // A type field wins: the value already has a home and an editor.
    if (declared.has(property.id) || property.storage === 'base-field') continue;
    if (property.storage === 'field' && property.definition) {
      layout.fields.push(labelPropertyToFieldDefinition(property.definition, property.viaLabel));
    } else if (property.storage !== 'claim') {
      layout.unknown.push(property);
    }
  }
  return layout;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The bare value a chip edits. A qualified property stores `{ value, qualifiers }`. */
export function unwrapLabelFieldValue(field: FieldDefinition, stored: unknown): unknown {
  if (!isLabelFieldDefinition(field) || !isQualifiedFieldProperty(field.labelProperty)) return stored;
  return isPlainObject(stored) && 'value' in stored ? stored.value : stored;
}

/** The qualifiers stored beside a qualified value; empty when there are none. */
function labelFieldQualifiers(stored: unknown): Record<string, unknown> {
  return isPlainObject(stored) && isPlainObject(stored.qualifiers) ? stored.qualifiers : {};
}

/**
 * The stored shape for a new bare value. Qualifiers already on the item are
 * kept: changing a value must not silently drop the conditions it was stated
 * under. Clearing the value clears the whole entry.
 */
export function wrapLabelFieldValue(field: FieldDefinition, next: unknown, stored: unknown): unknown {
  if (!isLabelFieldDefinition(field) || !isQualifiedFieldProperty(field.labelProperty)) return next;
  if (next === undefined || next === null || next === '') return null;
  return { value: next, qualifiers: labelFieldQualifiers(stored) };
}

/**
 * Chip values for label fields: qualified values unwrapped, everything else
 * passed through. Returns `values` itself when no field is qualified, so a
 * memoized consumer keeps its identity.
 */
export function unwrapLabelFieldValues(
  fields: readonly FieldDefinition[],
  values: Record<string, unknown>,
): Record<string, unknown> {
  const qualified = fields.filter(field => isLabelFieldDefinition(field) && isQualifiedFieldProperty(field.labelProperty));
  if (qualified.length === 0) return values;
  const out = { ...values };
  for (const field of qualified) out[field.name] = unwrapLabelFieldValue(field, values[field.name]);
  return out;
}

/**
 * A re-render signal for the tracker registry. The registry is mutable and has
 * no atom, so surfaces that read it subscribe and bump a counter.
 */
export function useTrackerRegistryVersion(registry: TrackerDataModelRegistry = globalRegistry): number {
  const [version, setVersion] = useState(0);
  useEffect(() => registry.onChange(() => setVersion(v => v + 1)), [registry]);
  return version;
}

/** Stable key for the inputs label resolution reads, so an unrelated field edit is free. */
export function labelResolutionKey(values: LabeledItem | null | undefined): string {
  return values ? itemOwnLabels(values).join('\u001f') : '';
}

/**
 * Memoized {@link resolveTrackerLabelFields}: recomputed only when the item's
 * labels or kind change, or the registry publishes a new vocabulary.
 */
export function useTrackerLabelFields(
  trackerType: string,
  values: LabeledItem | null | undefined,
): TrackerLabelFieldLayout {
  const version = useTrackerRegistryVersion();
  const key = labelResolutionKey(values);
  return useMemo(() => {
    // Rebuild the item from the key alone (own labels with `kind` folded in):
    // the memo must not close over `values`.
    return key ? resolveTrackerLabelFields(trackerType, { labels: key.split('\u001f') }) : EMPTY_LAYOUT;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `version` is the registry signal
  }, [trackerType, key, version]);
}
