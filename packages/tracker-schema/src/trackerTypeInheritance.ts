/**
 * Type inheritance for tracker schemas (`extends`).
 *
 * A derived type declares only what it adds. Resolution folds the ancestry from
 * the root down, so a change to a base type reaches every derived type without
 * anyone editing the derived declaration — that propagation is the whole point,
 * and it is why the DECLARED form is what gets stored and synced while the
 * RESOLVED form is what validation, editors, and tables read.
 *
 * The narrowing rules come from the knowledge-scopes contract: a derived type
 * may add fields and narrow selects; it may not remove or retype a base field.
 * A violation resolves to no model at all rather than to a partially-correct
 * one, so a broken declaration cannot register and silently drop base fields.
 */

import type {
  FieldDefinition,
  FieldOption,
  TrackerDataModel,
  TrackerSchemaRole,
} from './TrackerDataModel.js';

/** Depth cap on an `extends` chain, counting the derived type itself. */
export const TRACKER_INHERITANCE_MAX_DEPTH = 8;

/**
 * A derived type as authored: `type` and `extends` plus only the parts it
 * overrides or adds. Every other property is inherited, so a declaration that
 * omits `displayName` is not a malformed model — it is one that accepts the
 * base's.
 */
export interface DerivedTrackerTypeDeclaration extends Partial<Omit<TrackerDataModel, 'type' | 'extends'>> {
  type: string;
  extends: string;
}

export type TrackerTypeDeclaration = TrackerDataModel | DerivedTrackerTypeDeclaration;

export type TrackerInheritanceErrorCode =
  | 'INHERITANCE_UNKNOWN_BASE'
  | 'INHERITANCE_CYCLE'
  | 'INHERITANCE_DEPTH_EXCEEDED'
  | 'INHERITANCE_FIELD_RETYPED'
  | 'INHERITANCE_OPTION_WIDENED'
  | 'INHERITANCE_ROOT_INCOMPLETE';

export interface TrackerInheritanceError {
  code: TrackerInheritanceErrorCode;
  /** Field name, or the type name when the problem is with the chain itself. */
  field: string;
  message: string;
}

export interface TrackerTypeInheritanceResult {
  /** Null when `errors` is non-empty: a partially-resolved type is never returned. */
  model: TrackerDataModel | null;
  errors: TrackerInheritanceError[];
}

/** True for a declaration that inherits from another type. */
export function isDerivedTrackerTypeDeclaration(
  candidate: TrackerTypeDeclaration | null | undefined,
): candidate is DerivedTrackerTypeDeclaration {
  return typeof (candidate as DerivedTrackerTypeDeclaration | undefined)?.extends === 'string'
    && (candidate as DerivedTrackerTypeDeclaration).extends.length > 0;
}

/** Look up a declaration by type name. Returns undefined for an unknown type. */
export type TrackerTypeLookup = (type: string) => TrackerTypeDeclaration | undefined;

/**
 * Resolve one derived declaration against its ancestry.
 *
 * A non-derived declaration resolves to itself, so callers can run everything
 * through this without branching.
 */
export function resolveTrackerTypeInheritance(
  declared: TrackerTypeDeclaration,
  lookup: TrackerTypeLookup,
): TrackerTypeInheritanceResult {
  if (!isDerivedTrackerTypeDeclaration(declared)) {
    return { model: declared, errors: [] };
  }

  const chain: TrackerTypeDeclaration[] = [declared];
  const seen = new Set<string>([declared.type]);
  let cursor: TrackerTypeDeclaration = declared;

  while (isDerivedTrackerTypeDeclaration(cursor)) {
    const baseName = cursor.extends;
    if (seen.has(baseName)) {
      return {
        model: null,
        errors: [{
          code: 'INHERITANCE_CYCLE',
          field: declared.type,
          message: `Type '${declared.type}' has a cyclic extends chain through '${baseName}'`,
        }],
      };
    }
    const base = lookup(baseName);
    if (!base) {
      return {
        model: null,
        errors: [{
          code: 'INHERITANCE_UNKNOWN_BASE',
          field: declared.type,
          message: `Type '${cursor.type}' extends unknown type '${baseName}'`,
        }],
      };
    }
    seen.add(baseName);
    chain.push(base);
    if (chain.length > TRACKER_INHERITANCE_MAX_DEPTH) {
      return {
        model: null,
        errors: [{
          code: 'INHERITANCE_DEPTH_EXCEEDED',
          field: declared.type,
          message: `Extends chain for '${declared.type}' exceeds ${TRACKER_INHERITANCE_MAX_DEPTH} levels`,
        }],
      };
    }
    cursor = base;
  }

  // `cursor` is the root: the first non-derived declaration in the chain.
  const root = cursor as TrackerDataModel;
  if (!Array.isArray(root.fields)) {
    return {
      model: null,
      errors: [{
        code: 'INHERITANCE_ROOT_INCOMPLETE',
        field: root.type,
        message: `Base type '${root.type}' has no fields to inherit`,
      }],
    };
  }

  const errors: TrackerInheritanceError[] = [];
  // Fold root -> ... -> declared, so a two-level chain narrows twice.
  let resolved: TrackerDataModel = root;
  for (let i = chain.length - 2; i >= 0; i -= 1) {
    resolved = mergeOnto(resolved, chain[i] as DerivedTrackerTypeDeclaration, errors);
  }

  if (errors.length > 0) return { model: null, errors };
  return { model: resolved, errors: [] };
}

function mergeOnto(
  base: TrackerDataModel,
  derived: DerivedTrackerTypeDeclaration,
  errors: TrackerInheritanceError[],
): TrackerDataModel {
  const fields = mergeFields(base.fields, derived.fields ?? [], derived.type, errors);

  const roles: Partial<Record<TrackerSchemaRole, string>> | undefined =
    base.roles || derived.roles
      ? { ...(base.roles ?? {}), ...(derived.roles ?? {}) }
      : undefined;

  const merged: TrackerDataModel = {
    ...base,
    ...stripUndefined(derived),
    type: derived.type,
    extends: derived.extends,
    fields,
  };
  if (roles) merged.roles = roles;
  return merged;
}

/** Drop keys the derived declaration left undefined so they do not blank the base's. */
function stripUndefined(declaration: DerivedTrackerTypeDeclaration): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(declaration)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function mergeFields(
  baseFields: FieldDefinition[],
  derivedFields: FieldDefinition[],
  derivedType: string,
  errors: TrackerInheritanceError[],
): FieldDefinition[] {
  const byName = new Map<string, FieldDefinition>();
  for (const field of derivedFields) byName.set(field.name, field);

  // Base order is preserved: a derived override refines a base field in place
  // rather than moving it to the end of the form.
  const result: FieldDefinition[] = baseFields.map(baseField => {
    const override = byName.get(baseField.name);
    if (!override) return baseField;
    byName.delete(baseField.name);
    return narrowField(baseField, override, derivedType, errors);
  });

  for (const field of derivedFields) {
    if (byName.has(field.name)) result.push(field);
  }
  return result;
}

function narrowField(
  baseField: FieldDefinition,
  override: FieldDefinition,
  derivedType: string,
  errors: TrackerInheritanceError[],
): FieldDefinition {
  if (override.type !== undefined && override.type !== baseField.type) {
    errors.push({
      code: 'INHERITANCE_FIELD_RETYPED',
      field: baseField.name,
      message: `Type '${derivedType}' cannot retype inherited field '${baseField.name}' from '${baseField.type}' to '${override.type}'`,
    });
    return baseField;
  }

  if (baseField.options && override.options) {
    const allowed = new Set(baseField.options.map(opt => opt.value));
    const widened = override.options.filter(opt => !allowed.has(opt.value));
    if (widened.length > 0) {
      errors.push({
        code: 'INHERITANCE_OPTION_WIDENED',
        field: baseField.name,
        message: `Type '${derivedType}' adds options to inherited select '${baseField.name}': ${widened.map(o => o.value).join(', ')}. A derived type may only narrow a base select.`,
      });
      return baseField;
    }
  }

  const merged: FieldDefinition = { ...baseField, ...stripUndefinedField(override), type: baseField.type };
  if (baseField.options && override.options) {
    // Keep the base's option metadata (label, color, category) for the values
    // the derived type kept, so narrowing does not also mean re-authoring them.
    const baseByValue = new Map(baseField.options.map(opt => [opt.value, opt]));
    merged.options = override.options.map<FieldOption>(opt => ({ ...(baseByValue.get(opt.value) ?? {}), ...opt }));
  }
  return merged;
}

function stripUndefinedField(field: FieldDefinition): Partial<FieldDefinition> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(field)) {
    if (value !== undefined) out[key] = value;
  }
  return out as Partial<FieldDefinition>;
}

/** Keys a declaration never carries as an override of its base. */
const NON_DECLARED_KEYS = new Set(['type', 'extends', 'fields', 'roles', 'activity', 'declaredForm']);

/**
 * Recover the declaration a resolved derived model came from: `type`,
 * `extends`, and only what differs from `base` (the base's resolved model).
 *
 * For a copy that lost its declaration -- a mirror row or payload written
 * before declarations travelled with it. Registering such a copy as if it were
 * the declaration turns every inherited field into an explicit override, so a
 * later base change stops reaching it, and narrowing a base select drops the
 * type outright (the copy now "widens" it).
 */
export function deriveTrackerTypeDeclaration(
  resolved: TrackerDataModel,
  base: TrackerDataModel,
): DerivedTrackerTypeDeclaration {
  const declared: DerivedTrackerTypeDeclaration = { type: resolved.type, extends: resolved.extends ?? base.type };
  const record = declared as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(resolved)) {
    if (NON_DECLARED_KEYS.has(key) || value === undefined) continue;
    if (stableJson(value) !== stableJson((base as unknown as Record<string, unknown>)[key])) record[key] = value;
  }

  const baseFields = new Map(base.fields.map(field => [field.name, field]));
  const fields = resolved.fields.filter(field => {
    const inherited = baseFields.get(field.name);
    return !inherited || stableJson(fieldUnderDefaults(field)) !== stableJson(fieldUnderDefaults(inherited));
  });
  if (fields.length > 0) declared.fields = fields;

  const roles: Partial<Record<TrackerSchemaRole, string>> = {};
  for (const [role, fieldName] of Object.entries(resolved.roles ?? {})) {
    if (base.roles?.[role as TrackerSchemaRole] !== fieldName) roles[role as TrackerSchemaRole] = fieldName;
  }
  if (Object.keys(roles).length > 0) declared.roles = roles;
  return declared;
}

/** A field with the parser's defaults spelled out, so a YAML round trip is not a difference. */
function fieldUnderDefaults(field: FieldDefinition): Record<string, unknown> {
  return { ...field, required: field.required === true, displayInline: field.displayInline !== false };
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner) =>
    inner && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(Object.keys(inner).sort().filter(k => inner[k] !== undefined).map(k => [k, inner[k]]))
      : inner);
}
