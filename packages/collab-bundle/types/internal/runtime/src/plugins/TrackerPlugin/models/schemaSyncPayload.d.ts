/**
 * Wire payload for team tracker-schema sync.
 *
 * A schema definition travels between teammates as a JSON string. There are two
 * shapes:
 *
 *  - a FULL model (a custom type the team owns outright), and
 *  - a PATCH against a builtin (an override of `bug`, `task`, ...).
 *
 * Overrides of builtins must travel as a delta. A full copy freezes the type at
 * the sender's app version for the whole team: every field shipped in a later
 * builtin (Collections, the review lane, tags) becomes invisible to everyone,
 * with no warning and no way back. Sending the delta lets each peer resolve it
 * against ITS OWN builtin, so upstream improvements keep flowing (#1178).
 *
 * Old-client tolerance is deliberate: a patch payload carries no top-level
 * `type` + `fields[]`, which is exactly what a pre-patch client validates a
 * model on, so it rejects the payload and stays on its builtin rather than
 * ingesting a half-understood schema.
 */
import type { DerivedTrackerTypeDeclaration, TrackerDataModel } from '../../../../../tracker-schema/src/browser';
import { type LabelRegistry, type PredicateDefinition, type TrackerSchemaPatch } from '../../../../../tracker-schema/src/browser';
/**
 * Sidecar key carrying the DECLARED form of a derived type (`extends`) next to
 * its resolved form.
 *
 * The payload stays a full model at the top level on purpose: a client that
 * knows nothing about inheritance reads the resolved fields and works, exactly
 * as it does today. A client that does know prefers the declaration and
 * resolves it against ITS OWN base, so a later base change reaches the derived
 * type instead of freezing it at the sender's app version — the same reasoning
 * as the builtin delta above (#1178).
 */
export declare const TRACKER_SCHEMA_DECLARED_FORM_KEY = "declaredForm";
/** Discriminator for a delta payload. */
export declare const TRACKER_SCHEMA_PATCH_PAYLOAD = "trackerSchemaPatch";
/**
 * Reserved `schemaType` carrying the project's PREDICATE REGISTRY (contract
 * 4.1) rather than a tracker type definition.
 *
 * The registry is a sibling schema artifact, not a separate lane. Decision 12
 * makes it server-owned and published to every client exactly like a type
 * definition, and `TrackerSchemaEnvelope` is already keyed by an opaque
 * `schemaType` string with its own syncId cursor, its own AAD, and a bootstrap
 * that replays from zero on every connect. Riding it means the registry gets
 * team encryption at rest, the destructive-change gate, tombstones, and the
 * offline queue with no new message type, no new cursor, and nothing new for
 * the room to authorize.
 *
 * The leading double underscore is what keeps it out of the tracker type
 * namespace: a type id comes from a YAML filename or `tracker_define_type`, and
 * neither can produce this.
 *
 * Old-client tolerance falls out of the existing rules rather than being added:
 * this payload carries no top-level `type` + `fields[]`, which is exactly what
 * a client predating it validates a model on, so it decodes as null and the
 * envelope is dropped. A client that has never heard of predicates does not
 * acquire a broken tracker type called `__predicates__`.
 */
export declare const TRACKER_PREDICATE_REGISTRY_SCHEMA_TYPE = "__predicates__";
/** Discriminator for a predicate-registry payload. */
export declare const TRACKER_PREDICATE_REGISTRY_PAYLOAD = "trackerPredicateRegistry";
export interface TrackerPredicateRegistryPayload {
    payloadKind: typeof TRACKER_PREDICATE_REGISTRY_PAYLOAD;
    /** Bumped only if the registry grammar itself changes. */
    version: 1;
    predicates: PredicateDefinition[];
}
/**
 * Reserved `schemaType` carrying the project's LABEL REGISTRY
 * (`.nimbalyst/labels.yaml`: labels, field-stored properties, and claim
 * property extensions). Same reasoning as `__predicates__` above, and the same
 * old-client tolerance: no top-level `type` + `fields[]`, so a client that
 * predates labels drops the envelope.
 */
export declare const TRACKER_LABEL_REGISTRY_SCHEMA_TYPE = "__labels__";
/** Discriminator for a label-registry payload. */
export declare const TRACKER_LABEL_REGISTRY_PAYLOAD = "trackerLabelRegistry";
export interface TrackerLabelRegistryPayload {
    payloadKind: typeof TRACKER_LABEL_REGISTRY_PAYLOAD;
    /** Bumped only if the registry grammar itself changes. */
    version: 1;
    registry: LabelRegistry;
}
export interface TrackerSchemaPatchPayload {
    payloadKind: typeof TRACKER_SCHEMA_PATCH_PAYLOAD;
    /** Bumped only if the delta grammar itself changes. */
    version: 1;
    patch: TrackerSchemaPatch;
}
export type DecodedTrackerSchemaPayload = {
    kind: 'patch';
    patch: TrackerSchemaPatch;
} | {
    kind: 'model';
    model: TrackerDataModel;
    declared?: DerivedTrackerTypeDeclaration;
} | {
    kind: 'predicates';
    predicates: PredicateDefinition[];
} | {
    kind: 'labels';
    registry: LabelRegistry;
};
/**
 * Serialize a full model, optionally with the declared form of a derived type
 * alongside it. Without a declaration this is the plain model JSON the wire has
 * always carried, byte for byte.
 */
export declare function encodeTrackerSchemaModelPayload(model: TrackerDataModel, declared?: DerivedTrackerTypeDeclaration | null): string;
/** Serialize the project's predicate registry for the reserved schema type. */
export declare function encodeTrackerPredicateRegistryPayload(predicates: readonly PredicateDefinition[]): string;
/** Serialize the project's label registry for the reserved schema type. */
export declare function encodeTrackerLabelRegistryPayload(registry: LabelRegistry): string;
/** Serialize a builtin override as a delta payload. */
export declare function encodeTrackerSchemaPatchPayload(patch: TrackerSchemaPatch): string;
/**
 * Classify an inbound payload. Returns null when the JSON is unparseable or
 * matches neither shape — the caller drops it rather than guessing, so a
 * malformed delta can never register a broken model.
 */
export declare function decodeTrackerSchemaPayload(type: string, json: string): DecodedTrackerSchemaPayload | null;
