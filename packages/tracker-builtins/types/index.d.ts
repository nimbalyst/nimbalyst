/**
 * Public types for `@nimbalyst/tracker-builtins`. Hand-written and loose on
 * purpose: the collab worker handles schemas as decrypted JSON records, not as
 * the runtime's `TrackerDataModel`. `src/index.ts` asserts the implementation
 * matches these signatures.
 */

/** One field of a tracker type, as it travels on the schema lane. */
export type TrackerField = Record<string, unknown> & { name: string; type: string };

/** A fully resolved tracker type model (`TrackerDataModel` JSON). */
export type TrackerModel = Record<string, unknown> & { type: string; fields: TrackerField[] };

/** A delta against a builtin (`TrackerSchemaPatch` JSON). */
export type TrackerSchemaPatch = Record<string, unknown> & { type: string };

/** Discriminator of a builtin-override payload on the schema lane. */
export declare const TRACKER_SCHEMA_PATCH_PAYLOAD: 'trackerSchemaPatch';

/** Every builtin type this build ships, in load order. Each call returns fresh copies. */
export declare function builtinTrackerModels(): TrackerModel[];

/** A fresh copy of one builtin model, or null when this build ships no such builtin. */
export declare function builtinTrackerModel(type: string): TrackerModel | null;

export declare function isBuiltinTrackerType(type: string): boolean;

/** Apply a delta to a seed. Throws when the patch targets another type or adds a field without a `type`. */
export declare function resolveTrackerSchemaPatch(seed: TrackerModel, patch: TrackerSchemaPatch): TrackerModel;

/** The minimal delta that turns `seed` into `target`: the diff desktops push for a builtin override. */
export declare function diffTrackerSchema(seed: TrackerModel, target: TrackerModel): TrackerSchemaPatch;

export type DecodedTrackerSchemaPayload =
  | { kind: 'patch'; patch: TrackerSchemaPatch }
  | { kind: 'model'; model: TrackerModel; declared?: Record<string, unknown> }
  | { kind: 'predicates'; predicates: Array<Record<string, unknown>> }
  | { kind: 'labels'; registry: Record<string, unknown> };

/** Classify a schema-lane payload as desktops do; null when it is unparseable or matches no shape. */
export declare function decodeTrackerSchemaPayload(type: string, json: string): DecodedTrackerSchemaPayload | null;

/** Serialize a builtin override as `{ payloadKind: 'trackerSchemaPatch', version: 1, patch }`. */
export declare function encodeTrackerSchemaPatchPayload(patch: TrackerSchemaPatch): string;

/** A relationship value as stored in an item's `fields`. */
export type TrackerRelationshipValue = Record<string, unknown> & {
  itemId: string;
  issueKey?: string;
  title?: string;
  trackerType?: string;
  direction?: 'out';
  relationshipTypeKey?: string;
};

/** The source item, stamped onto a target's inverse field. */
export interface InverseSourceRef {
  itemId: string;
  issueKey?: string;
  title?: string;
  trackerType?: string;
}

/** One inverse-field mutation to apply to a target item. */
export interface InverseFieldDelta {
  targetItemId: string;
  inverseFieldId: string;
  op: 'add' | 'remove';
  value: TrackerRelationshipValue;
}

export declare function isRelationshipField(def: { type: string }): boolean;

/** The inverse writes one relationship field's change from `prev` to `next` implies; [] without `inverseFieldId`. */
export declare function computeInverseFieldDeltas(
  def: TrackerField,
  source: InverseSourceRef,
  prev: unknown,
  next: unknown,
): InverseFieldDelta[];

export declare function normalizeRelationshipValue(raw: unknown): TrackerRelationshipValue[];

export declare function addRelationshipValue(
  def: TrackerField,
  current: unknown,
  target: TrackerRelationshipValue,
): TrackerRelationshipValue[];

export declare function removeRelationshipValue(current: unknown, itemId: string): TrackerRelationshipValue[];

export declare function serializeRelationshipValue(
  def: TrackerField,
  values: TrackerRelationshipValue[],
): TrackerRelationshipValue | TrackerRelationshipValue[] | null;
