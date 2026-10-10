/**
 * Reading a stored `label-ref` value. Split from `LabelRefPicker.tsx` so the
 * chip row can show label names without loading the picker, which mounts
 * lazily when a label field is edited.
 */

import { globalRegistry, type LabelRegistry } from '@nimbalyst/tracker-schema';

/** Normalize a stored `label-ref` value to label ids. */
export function labelRefIds(value: unknown): string[] {
  const entries = Array.isArray(value) ? value : value === undefined || value === null || value === '' ? [] : [value];
  const out: string[] = [];
  for (const entry of entries) {
    if (typeof entry === 'string' && entry && !out.includes(entry)) out.push(entry);
  }
  return out;
}

/** Display names for a stored value; unknown labels keep their id. */
export function labelRefDisplayNames(value: unknown, registry: LabelRegistry = globalRegistry.getLabelRegistry()): string[] {
  const byId = new Map(registry.labels.map(label => [label.id, label.label]));
  return labelRefIds(value).map(id => byId.get(id) ?? id);
}
