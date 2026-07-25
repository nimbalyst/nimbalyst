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

import yaml from 'js-yaml';
import type {
  TrackerDataModel,
  FieldDefinition,
  FieldOption,
  StatusBarLayoutRow,
  TrackerSyncPolicy,
  TrackerSchemaRole,
} from './TrackerDataModel';

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
 * the properties present are changed. Scalars are last-writer; `sync`/`roles` are
 * shallow-merged; `fields`/options merge by key.
 */
export interface TrackerSchemaPatch {
  /** The tracker type this patch targets. Must match the seed's `type`. */
  type: string;

  // Scalar / top-level shallow overrides (last-writer).
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

  /** Shallow-merged onto the seed's sync policy. */
  sync?: Partial<TrackerSyncPolicy>;
  /** Shallow-merged onto the seed's roles map. */
  roles?: Partial<Record<TrackerSchemaRole, string>>;

  /** Field-level operations, applied by `name`. */
  fields?: TrackerFieldPatch[];
}

/** True when the value is a non-null plain object (not an array). */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Type-guard for a parsed patch document. A patch is distinguished from a full
 * schema by NOT carrying the required full-schema fields (displayName + fields
 * array of full definitions is ambiguous), so callers should route explicitly;
 * this guard only checks the minimal shape needed to resolve.
 */
export function isTrackerSchemaPatch(value: unknown): value is TrackerSchemaPatch {
  return isPlainObject(value) && typeof value.type === 'string';
}

/**
 * Parse a patch YAML document (`.nimbalyst/trackers/<type>.patch.yaml`). Throws
 * on an empty document or a missing/invalid `type`. Structural validation of the
 * field/option ops is deferred to {@link resolveTrackerSchemaPatch}, which runs
 * against the live seed.
 */
export function parseTrackerSchemaPatchYAML(yamlString: string): TrackerSchemaPatch {
  const data = yaml.load(yamlString);
  if (!data) throw new Error('Empty patch document');
  if (!isTrackerSchemaPatch(data)) {
    throw new Error("Tracker schema patch is missing a string 'type'");
  }
  return data;
}

/** Serialize a patch to YAML for on-disk persistence. */
export function serializeTrackerSchemaPatchYAML(patch: TrackerSchemaPatch): string {
  return yaml.dump(patch, { indent: 2, lineWidth: 120, noRefs: true });
}

function mergeOptions(
  seedOptions: FieldOption[] | undefined,
  patch: TrackerFieldOptionPatch,
): FieldOption[] {
  // Preserve insertion order while merging by value.
  const byValue = new Map<string, FieldOption>();
  for (const opt of seedOptions ?? []) byValue.set(opt.value, opt);

  if (patch.set) {
    for (const opt of patch.set) {
      const existing = byValue.get(opt.value);
      // Shallow-merge so a partial update (e.g. just a new color) keeps the rest.
      byValue.set(opt.value, existing ? { ...existing, ...opt } : { ...opt });
    }
  }

  if (patch.remove) {
    for (const value of patch.remove) byValue.delete(value);
  }

  let ordered = Array.from(byValue.values());
  if (patch.order && patch.order.length > 0) {
    const rank = new Map(patch.order.map((v, i) => [v, i] as const));
    ordered = ordered
      .map((opt, idx) => ({ opt, idx }))
      .sort((a, b) => {
        const ra = rank.has(a.opt.value) ? rank.get(a.opt.value)! : Number.POSITIVE_INFINITY;
        const rb = rank.has(b.opt.value) ? rank.get(b.opt.value)! : Number.POSITIVE_INFINITY;
        // Listed values by rank; everything else keeps prior relative order.
        return ra - rb || a.idx - b.idx;
      })
      .map(({ opt }) => opt);
  }
  return ordered;
}

function applyFieldPatch(
  seedField: FieldDefinition | undefined,
  patch: TrackerFieldPatch,
): FieldDefinition | undefined {
  if (patch.remove) return undefined;

  let field: FieldDefinition;
  if (seedField) {
    field = { ...seedField, ...(patch.set ?? {}) };
  } else {
    // New field. `type` must be provided via `set`.
    const set = patch.set ?? {};
    if (!set.type) {
      throw new Error(
        `Schema patch adds field '${patch.name}' without a 'type'`
      );
    }
    field = { name: patch.name, type: set.type, ...set } as FieldDefinition;
  }
  field.name = patch.name;

  if (patch.options) {
    field.options = mergeOptions(field.options, patch.options);
  }
  return field;
}

/**
 * Resolve a patch against a seed model, returning a new fully-resolved model.
 * The seed is never mutated. Throws if the patch targets a different `type` or
 * adds a field without a `type`.
 */
export function resolveTrackerSchemaPatch(
  seed: TrackerDataModel,
  patch: TrackerSchemaPatch,
): TrackerDataModel {
  if (patch.type !== seed.type) {
    throw new Error(
      `Schema patch type '${patch.type}' does not match seed type '${seed.type}'`
    );
  }

  const resolved: TrackerDataModel = {
    ...seed,
    // Shallow-clone nested structures we may mutate below.
    fields: seed.fields.map((f) => ({ ...f })),
  };

  // Scalar last-writer overrides.
  if (patch.displayName !== undefined) resolved.displayName = patch.displayName;
  if (patch.displayNamePlural !== undefined) resolved.displayNamePlural = patch.displayNamePlural;
  if (patch.icon !== undefined) resolved.icon = patch.icon;
  if (patch.color !== undefined) resolved.color = patch.color;
  if (patch.inlineTemplate !== undefined) resolved.inlineTemplate = patch.inlineTemplate;
  if (patch.creatable !== undefined) resolved.creatable = patch.creatable;
  if (patch.primaryCapable !== undefined) resolved.primaryCapable = patch.primaryCapable;
  if (patch.supportsTags !== undefined) resolved.supportsTags = patch.supportsTags;
  if (patch.statusBarLayout !== undefined) resolved.statusBarLayout = patch.statusBarLayout;

  if (patch.sync) {
    resolved.sync = { ...(seed.sync ?? { mode: 'local', scope: 'project' }), ...patch.sync };
  }
  if (patch.roles) {
    resolved.roles = { ...(seed.roles ?? {}), ...patch.roles };
  }

  if (patch.fields && patch.fields.length > 0) {
    const indexByName = new Map(resolved.fields.map((f, i) => [f.name, i] as const));
    for (const fieldPatch of patch.fields) {
      const idx = indexByName.get(fieldPatch.name);
      const seedField = idx !== undefined ? resolved.fields[idx] : undefined;
      const next = applyFieldPatch(seedField, fieldPatch);
      if (idx !== undefined) {
        if (next === undefined) {
          resolved.fields.splice(idx, 1);
          // Reindex after a removal.
          indexByName.clear();
          resolved.fields.forEach((f, i) => indexByName.set(f.name, i));
        } else {
          resolved.fields[idx] = next;
        }
      } else if (next !== undefined) {
        resolved.fields.push(next);
        indexByName.set(next.name, resolved.fields.length - 1);
      }
    }
  }

  return resolved;
}

/**
 * Compute a minimal patch that turns `seed` into `target`. Used when persisting
 * a customized builtin as a delta and when sending overrides to peers so each
 * resolves against its own seed. Only handles the common cases (scalars, roles,
 * sync, fields by name, options by value); callers that need full fidelity can
 * fall back to persisting the whole model.
 */
export function diffTrackerSchema(
  seed: TrackerDataModel,
  target: TrackerDataModel,
): TrackerSchemaPatch {
  const patch: TrackerSchemaPatch = { type: target.type };

  const scalarKeys: Array<keyof TrackerDataModel> = [
    'displayName', 'displayNamePlural', 'icon', 'color', 'inlineTemplate',
    'creatable', 'primaryCapable', 'supportsTags',
  ];
  const patchRecord = patch as unknown as Record<string, unknown>;
  for (const key of scalarKeys) {
    if (seed[key] !== target[key]) {
      patchRecord[key] = target[key];
    }
  }

  if (JSON.stringify(seed.statusBarLayout) !== JSON.stringify(target.statusBarLayout)) {
    patch.statusBarLayout = target.statusBarLayout;
  }
  if (JSON.stringify(seed.sync) !== JSON.stringify(target.sync) && target.sync) {
    patch.sync = target.sync;
  }
  if (JSON.stringify(seed.roles) !== JSON.stringify(target.roles) && target.roles) {
    patch.roles = target.roles;
  }

  const fieldPatches: TrackerFieldPatch[] = [];
  const seedFields = new Map(seed.fields.map((f) => [f.name, f]));
  const targetNames = new Set(target.fields.map((f) => f.name));

  for (const tf of target.fields) {
    const sf = seedFields.get(tf.name);
    if (!sf) {
      // New field: carry its full definition.
      const { name, options, ...rest } = tf;
      const fp: TrackerFieldPatch = { name, set: rest as TrackerFieldPatch['set'] };
      if (options) fp.options = { set: options, order: options.map((o) => o.value) };
      fieldPatches.push(fp);
    } else if (JSON.stringify(sf) !== JSON.stringify(tf)) {
      const { name, options, ...rest } = tf;
      const fp: TrackerFieldPatch = { name, set: rest as TrackerFieldPatch['set'] };
      if (JSON.stringify(sf.options) !== JSON.stringify(options)) {
        fp.options = { set: options ?? [], order: (options ?? []).map((o) => o.value) };
      }
      fieldPatches.push(fp);
    }
  }
  for (const sf of seed.fields) {
    if (!targetNames.has(sf.name)) {
      fieldPatches.push({ name: sf.name, remove: true });
    }
  }
  if (fieldPatches.length > 0) patch.fields = fieldPatches;

  return patch;
}
