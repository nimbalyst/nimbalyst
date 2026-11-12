/**
 * Patch/delta overrides for tracker type schemas.
 *
 * A patch expresses only the DELTA from a live builtin (or custom) seed, so a
 * caller can change one thing — add a status option, rename a label, add a field
 * — without redeclaring the whole schema. Patches are resolved against the CURRENT
 * seed at load time and on every schema-change event, so improvements to the
 * shipped builtin (new fields, new roles, prMergedStatus, …) automatically flow
 * through to an overridden type. See configurable-builtin-tracker-types plan.
 *
 * The registry always ends up holding a fully-resolved {@link TrackerDataModel},
 * so kanban columns, role derivation, inline templates, and validation all read
 * the resolved model with no per-consumer changes.
 */
import type { TrackerDataModel, FieldDefinition, FieldOption, StatusBarLayoutRow, TrackerSharing, TrackerSchemaRole } from './TrackerDataModel.js';
/** Option-level operations for a select/multiselect field, merged by `value`. */
export interface TrackerFieldOptionPatch {
    /** Add new options or update existing ones (shallow-merged by `value`). */
    set?: FieldOption[];
    /** Remove options by `value`. */
    remove?: string[];
    /**
     * Explicit ordering by `value`. Listed values come first in this order; any
     * remaining options keep their prior relative order after them.
     */
    order?: string[];
}
/** A single field-level operation, keyed by field `name`. */
export interface TrackerFieldPatch {
    /** Field name to add or patch. */
    name: string;
    /** Remove the field entirely. Ignored if the field doesn't exist. */
    remove?: boolean;
    /**
     * Scalar field-property overrides (type, required, default, displayInline,
     * min/max, relationship props, …). For a NEW field this must include `type`.
     * `name` and `options` are managed separately (see {@link options}).
     */
    set?: Omit<Partial<FieldDefinition>, 'name' | 'options'>;
    /** Option-level operations for select/multiselect fields. */
    options?: TrackerFieldOptionPatch;
}
/**
 * A delta applied on top of a resolved seed model. Every field is optional; only
 * the properties present are changed. Scalars are last-writer; `roles` are
 * shallow-merged; `fields`/options merge by key.
 */
export interface TrackerSchemaPatch {
    /** The tracker type this patch targets. Must match the seed's `type`. */
    type: string;
    displayName?: string;
    displayNamePlural?: string;
    icon?: string;
    color?: string;
    inlineTemplate?: string;
    creatable?: boolean;
    primaryCapable?: boolean;
    supportsTags?: boolean;
    /** Replaces the whole layout when present (it's a positional array). */
    statusBarLayout?: StatusBarLayoutRow[];
    sharing?: TrackerSharing;
    draftByDefault?: boolean;
    /** Retire the tracker: items are kept and keyed, but become read-only. */
    archived?: boolean;
    /** `false` stops local numbers (`NIM.75`) for a builtin type; see `TrackerDataModel.localNumbers`. */
    localNumbers?: boolean;
    /** Structured schema history, using the same entry shape as tracker item activity. */
    activity?: unknown[];
    /** Shallow-merged onto the seed's roles map. */
    roles?: Partial<Record<TrackerSchemaRole, string>>;
    /** Field-level operations, applied by `name`. */
    fields?: TrackerFieldPatch[];
}
/**
 * Type-guard for a parsed patch document. A patch is distinguished from a full
 * schema by NOT carrying the required full-schema fields (displayName + fields
 * array of full definitions is ambiguous), so callers should route explicitly;
 * this guard only checks the minimal shape needed to resolve.
 */
export declare function isTrackerSchemaPatch(value: unknown): value is TrackerSchemaPatch;
/**
 * Parse a patch YAML document (`.nimbalyst/trackers/<type>.patch.yaml`). Throws
 * on an empty document or a missing/invalid `type`. Structural validation of the
 * field/option ops is deferred to {@link resolveTrackerSchemaPatch}, which runs
 * against the live seed.
 */
export declare function parseTrackerSchemaPatchYAML(yamlString: string): TrackerSchemaPatch;
/** Serialize a patch to YAML for on-disk persistence. */
export declare function serializeTrackerSchemaPatchYAML(patch: TrackerSchemaPatch): string;
/**
 * Resolve a patch against a seed model, returning a new fully-resolved model.
 * The seed is never mutated. Throws if the patch targets a different `type` or
 * adds a field without a `type`.
 */
export declare function resolveTrackerSchemaPatch(seed: TrackerDataModel, patch: TrackerSchemaPatch): TrackerDataModel;
/**
 * One `target` field paired with the same-named `seed` field, when there is one.
 * A missing `seed` means the field is new in `target`.
 */
export interface TrackerFieldDiffEntry {
    seed?: FieldDefinition;
    target: FieldDefinition;
}
export interface TrackerFieldDiff {
    /** One entry per `target` field, in `target` order (new and kept fields interleaved). */
    entries: TrackerFieldDiffEntry[];
    /** Seed fields with no same-named field in `target`, in `seed` order. */
    removed: FieldDefinition[];
}
/**
 * Partition two schemas' field lists by field `name` — the single definition of
 * what "the same field" means across a schema change. Shared by
 * {@link diffTrackerSchema}, which turns the partition into a patch, and by the
 * schema-change classifier, which turns it into additive/destructive verdicts.
 * Comparing the paired definitions is each caller's job; this only pairs them.
 */
export declare function diffTrackerFields(seed: TrackerDataModel, target: TrackerDataModel): TrackerFieldDiff;
/**
 * Compute a minimal patch that turns `seed` into `target`. Used when persisting
 * a customized builtin as a delta and when sending overrides to peers so each
 * resolves against its own seed. Only handles the common cases (scalars, roles,
 * sharing, fields by name, options by value); callers that need full fidelity can
 * fall back to persisting the whole model.
 */
export declare function diffTrackerSchema(seed: TrackerDataModel, target: TrackerDataModel): TrackerSchemaPatch;
