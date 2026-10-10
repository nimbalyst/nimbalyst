/**
 * Reading a stored `label-ref` value. Split from `LabelRefPicker.tsx` so the
 * chip row can show label names without loading the picker, which mounts
 * lazily when a label field is edited.
 */
import { type LabelRegistry } from '../../../../../tracker-schema/src/browser';
/** Normalize a stored `label-ref` value to label ids. */
export declare function labelRefIds(value: unknown): string[];
/** Display names for a stored value; unknown labels keep their id. */
export declare function labelRefDisplayNames(value: unknown, registry?: LabelRegistry): string[];
