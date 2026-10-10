/**
 * Authoring a label registry: validation, merge-by-id patches, the sync
 * lane's three-way merge, and change classification. The model and the read
 * path are in `labelRegistry.ts`; read that header first.
 *
 * Validation differs from the predicate registry on purpose. Structural
 * defects (duplicate ids, a broader cycle, a missing broader target) are
 * errors, because a registry with them has no well-defined closure. Unknown
 * keys are warnings, so a newer release can add keys without older clients
 * dropping the whole vocabulary. References into the predicate registry are
 * only checked when the caller passes `predicateIds`: the two registries arrive
 * on separate rows in whatever order, and a sync decode that rejected labels
 * for naming a predicate that had not arrived yet would lose them.
 *
 * The package root re-exports `validateLabelRegistry` (the schema lane decodes
 * with it); everything else is imported from
 * `@nimbalyst/tracker-schema/labelRegistryAuthoring`.
 */

import {
  classifyLabelPropertyQualifierChanges,
  validateLabelPropertyQualifierDeclaration,
  type LabelQualifierIssue,
} from './labelPropertyQualifiers.js';
import {
  emptyLabelRegistry,
  DEFAULT_LABEL_BASE_FIELD_NAMES,
  FIELD_PROPERTY_TYPES,
  LABEL_ROLES,
  labelPropertyOptionValues,
  type ClaimPropertyExtension,
  type FieldPropertyDefinition,
  type FieldPropertyType,
  type LabelDefinition,
  type LabelIssue,
  type LabelRegistry,
  type LabelRole,
} from './labelRegistry.js';

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface LabelRegistryValidationContext {
  /** Predicate ids in force. Enables the cross-registry checks; see the header. */
  predicateIds?: Iterable<string>;
  /** Base field names of the item type. Defaults to {@link DEFAULT_LABEL_BASE_FIELD_NAMES}. */
  baseFieldNames?: readonly string[];
}

export type LabelRegistryValidation =
  | { valid: true; registry: LabelRegistry; issues: []; warnings: LabelIssue[] }
  | { valid: false; registry: null; issues: LabelIssue[]; warnings: LabelIssue[] };

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

const REGISTRY_KEYS = ['labels', 'properties', 'claimProperties'];
const LABEL_KEYS = [
  'id', 'label', 'pluralLabel', 'description', 'broader', 'icon', 'color', 'role',
  'properties', 'expects', 'factBox', 'template', 'actions',
];
const PROPERTY_KEYS = ['id', 'label', 'type', 'options', 'qualifiers', 'facet', 'description', 'range', 'multiValue'];
const CLAIM_PROPERTY_KEYS = ['range', 'options', 'facet', 'description'];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(entry => typeof entry === 'string' && entry.length > 0);
}

function labelIssue(code: LabelIssue['code'], path: string, message: string): LabelIssue {
  return { code, path, message };
}

class Collector {
  issues: LabelIssue[] = [];
  warnings: LabelIssue[] = [];

  unknownKeys(value: Record<string, unknown>, allowed: readonly string[], base: string, what: string): void {
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) {
        this.warnings.push(labelIssue('LABEL_UNKNOWN_FIELD', join(base, key), `'${key}' is not part of ${what}`));
      }
    }
  }

  id(value: Record<string, unknown>, base: string): string | null {
    const id = value.id;
    if (typeof id !== 'string' || id.length === 0) {
      this.issues.push(labelIssue('LABEL_MISSING_FIELD', join(base, 'id'), `'id' is required`));
      return null;
    }
    if (!ID_PATTERN.test(id)) {
      this.issues.push(labelIssue('LABEL_INVALID_FIELD', join(base, 'id'), `'${id}' must be lowercase letters, digits, and hyphens`));
    }
    return id;
  }

  requiredString(value: Record<string, unknown>, key: string, base: string): void {
    const raw = value[key];
    if (raw === undefined || raw === null) {
      this.issues.push(labelIssue('LABEL_MISSING_FIELD', join(base, key), `'${key}' is required`));
    } else if (typeof raw !== 'string' || raw.trim().length === 0) {
      this.issues.push(labelIssue('LABEL_INVALID_FIELD', join(base, key), `'${key}' must be a non-empty string`));
    }
  }

  optionalString(value: Record<string, unknown>, key: string, base: string): void {
    if (value[key] !== undefined && typeof value[key] !== 'string') {
      this.issues.push(labelIssue('LABEL_INVALID_FIELD', join(base, key), `'${key}' must be a string when present`));
    }
  }

  optionalBoolean(value: Record<string, unknown>, key: string, base: string): void {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') {
      this.issues.push(labelIssue('LABEL_INVALID_FIELD', join(base, key), `'${key}' must be a boolean when present`));
    }
  }

  optionalStringList(value: Record<string, unknown>, key: string, base: string): void {
    if (value[key] !== undefined && !isStringList(value[key])) {
      this.issues.push(labelIssue('LABEL_INVALID_FIELD', join(base, key), `'${key}' must be an array of ids`));
    }
  }
}

function join(base: string, key: string): string {
  return base ? `${base}.${key}` : key;
}

/**
 * Validate a whole label registry. Missing sections read as empty, so a file
 * holding only `labels:` is valid.
 */
export function validateLabelRegistry(
  value: unknown,
  context: LabelRegistryValidationContext = {},
): LabelRegistryValidation {
  if (!isPlainObject(value)) {
    return {
      valid: false,
      registry: null,
      issues: [labelIssue('LABEL_REGISTRY_NOT_AN_OBJECT', '', 'A label registry must be an object with labels, properties, and claimProperties')],
      warnings: [],
    };
  }

  const c = new Collector();
  c.unknownKeys(value, REGISTRY_KEYS, '', 'a label registry');

  const labels = sectionArray(value, 'labels', c);
  const properties = sectionArray(value, 'properties', c);
  let claimProperties: Record<string, unknown> = {};
  if (value.claimProperties !== undefined) {
    if (isPlainObject(value.claimProperties)) claimProperties = value.claimProperties;
    else c.issues.push(labelIssue('LABEL_INVALID_FIELD', 'claimProperties', `'claimProperties' must be an object keyed by predicate id`));
  }

  const baseFields = context.baseFieldNames ?? DEFAULT_LABEL_BASE_FIELD_NAMES;
  const predicateIds = context.predicateIds ? new Set(context.predicateIds) : null;

  const propertyIds = new Set<string>();
  properties.forEach((entry, index) => {
    const id = validatePropertyEntry(entry, `properties[${index}]`, c);
    if (!id) return;
    if (propertyIds.has(id)) {
      c.issues.push(labelIssue('LABEL_DUPLICATE_ID', `properties[${index}].id`, `Property '${id}' is declared more than once`));
    }
    if (baseFields.includes(id)) {
      c.issues.push(labelIssue('LABEL_PROPERTY_BASE_FIELD', `properties[${index}].id`, `Property '${id}' has the name of a base field`));
    }
    if (predicateIds?.has(id)) {
      c.issues.push(labelIssue('LABEL_PROPERTY_ID_CONFLICT', `properties[${index}].id`, `'${id}' is already a predicate; properties and predicates share one id namespace`));
    }
    propertyIds.add(id);
  });

  const labelIds = new Set<string>();
  const broaderById = new Map<string, { index: number; broader: string[] }>();
  labels.forEach((entry, index) => {
    const id = validateLabelEntry(entry, `labels[${index}]`, c);
    if (!id) return;
    if (labelIds.has(id)) {
      c.issues.push(labelIssue('LABEL_DUPLICATE_ID', `labels[${index}].id`, `Label '${id}' is declared more than once`));
      return;
    }
    labelIds.add(id);
    const broader = (entry as Record<string, unknown>).broader;
    broaderById.set(id, { index, broader: isStringList(broader) ? broader : [] });
  });

  const isKnownProperty = (id: string) =>
    propertyIds.has(id) || baseFields.includes(id) || (predicateIds?.has(id) ?? false);

  labels.forEach((entry, index) => {
    if (!isPlainObject(entry)) return;
    const base = `labels[${index}]`;
    const broader = entry.broader;
    if (isStringList(broader)) {
      broader.forEach((target, i) => {
        if (!labelIds.has(target)) {
          c.issues.push(labelIssue('LABEL_BROADER_UNKNOWN', `${base}.broader[${i}]`, `Broader label '${target}' is not declared`));
        }
      });
    }
    // Only with the predicate registry in hand can an unknown reference be told
    // from a predicate that has simply not arrived yet.
    if (!predicateIds) return;
    if (isStringList(entry.properties)) {
      entry.properties.forEach((property, i) => {
        if (!isKnownProperty(property)) {
          c.issues.push(labelIssue('LABEL_UNKNOWN_PROPERTY', `${base}.properties[${i}]`, `'${property}' is neither a property nor a predicate`));
        }
      });
    }
    if (Array.isArray(entry.expects)) {
      entry.expects.forEach((expectation, i) => {
        const property = isPlainObject(expectation) ? expectation.property : undefined;
        if (typeof property === 'string' && !isKnownProperty(property)) {
          c.issues.push(labelIssue('LABEL_EXPECTS_UNKNOWN_PROPERTY', `${base}.expects[${i}].property`, `'${property}' is neither a property nor a predicate`));
        }
      });
    }
  });

  checkCycles(broaderById, c);

  for (const [predicateId, extension] of Object.entries(claimProperties)) {
    const base = `claimProperties.${predicateId}`;
    if (!isPlainObject(extension)) {
      c.issues.push(labelIssue('LABEL_INVALID_FIELD', base, `Claim property '${predicateId}' must be an object`));
      continue;
    }
    c.unknownKeys(extension, CLAIM_PROPERTY_KEYS, base, 'a claim property');
    c.optionalStringList(extension, 'range', base);
    c.optionalStringList(extension, 'options', base);
    c.optionalBoolean(extension, 'facet', base);
    c.optionalString(extension, 'description', base);
    checkRange(extension.range, labelIds, base, c);
    // A property that also names a predicate is already reported on the property.
    if (propertyIds.has(predicateId) && !predicateIds?.has(predicateId)) {
      c.issues.push(labelIssue('LABEL_PROPERTY_ID_CONFLICT', base, `'${predicateId}' is a field property, not a predicate`));
    } else if (predicateIds && !predicateIds.has(predicateId)) {
      c.issues.push(labelIssue('LABEL_CLAIM_PROPERTY_UNKNOWN_PREDICATE', base, `No predicate '${predicateId}' is declared`));
    }
  }
  properties.forEach((entry, index) => {
    if (isPlainObject(entry)) checkRange(entry.range, labelIds, `properties[${index}]`, c);
  });

  if (c.issues.length > 0) return { valid: false, registry: null, issues: c.issues, warnings: c.warnings };
  return {
    valid: true,
    registry: {
      labels: labels as LabelDefinition[],
      properties: properties as FieldPropertyDefinition[],
      claimProperties: claimProperties as Record<string, ClaimPropertyExtension>,
    },
    issues: [],
    warnings: c.warnings,
  };
}

function sectionArray(value: Record<string, unknown>, key: string, c: Collector): unknown[] {
  const section = value[key];
  if (section === undefined || section === null) return [];
  if (!Array.isArray(section)) {
    c.issues.push(labelIssue('LABEL_INVALID_FIELD', key, `'${key}' must be an array`));
    return [];
  }
  return section;
}

/** An unknown range target is a warning: the label may still be a pending proposal. */
function checkRange(range: unknown, labelIds: ReadonlySet<string>, base: string, c: Collector): void {
  if (!isStringList(range)) return;
  range.forEach((target, i) => {
    if (!labelIds.has(target)) {
      c.warnings.push(labelIssue('LABEL_RANGE_UNKNOWN', `${base}.range[${i}]`, `Range label '${target}' is not declared`));
    }
  });
}

function validateLabelEntry(entry: unknown, base: string, c: Collector): string | null {
  if (!isPlainObject(entry)) {
    c.issues.push(labelIssue('LABEL_NOT_AN_OBJECT', base, 'A label declaration must be an object'));
    return null;
  }
  c.unknownKeys(entry, LABEL_KEYS, base, 'a label declaration');
  const id = c.id(entry, base);
  c.requiredString(entry, 'label', base);
  for (const key of ['pluralLabel', 'description', 'icon', 'color', 'template']) c.optionalString(entry, key, base);
  for (const key of ['broader', 'properties', 'factBox']) c.optionalStringList(entry, key, base);
  if (entry.role !== undefined && !LABEL_ROLES.includes(entry.role as LabelRole)) {
    c.issues.push(labelIssue('LABEL_INVALID_FIELD', `${base}.role`, `'role' must be one of ${LABEL_ROLES.join(', ')}`));
  }
  if (entry.expects !== undefined) {
    if (!Array.isArray(entry.expects)) {
      c.issues.push(labelIssue('LABEL_INVALID_FIELD', `${base}.expects`, `'expects' must be an array`));
    } else {
      entry.expects.forEach((expectation, i) => {
        const path = `${base}.expects[${i}]`;
        if (!isPlainObject(expectation) || typeof expectation.property !== 'string' || expectation.property.length === 0) {
          c.issues.push(labelIssue('LABEL_INVALID_FIELD', path, `An expectation needs a 'property'`));
          return;
        }
        for (const bound of ['min', 'max'] as const) {
          const n = expectation[bound];
          if (n !== undefined && (typeof n !== 'number' || !Number.isInteger(n) || n < 0)) {
            c.issues.push(labelIssue('LABEL_INVALID_FIELD', `${path}.${bound}`, `'${bound}' must be a non-negative integer`));
          }
        }
        c.unknownKeys(expectation, ['property', 'min', 'max'], path, 'an expectation');
      });
    }
  }
  return id;
}

function validatePropertyEntry(entry: unknown, base: string, c: Collector): string | null {
  if (!isPlainObject(entry)) {
    c.issues.push(labelIssue('LABEL_NOT_AN_OBJECT', base, 'A property declaration must be an object'));
    return null;
  }
  c.unknownKeys(entry, PROPERTY_KEYS, base, 'a property declaration');
  const id = c.id(entry, base);
  c.requiredString(entry, 'label', base);
  c.optionalString(entry, 'description', base);
  c.optionalBoolean(entry, 'facet', base);
  c.optionalBoolean(entry, 'multiValue', base);
  c.optionalStringList(entry, 'range', base);

  const type = entry.type;
  if (type === undefined) {
    c.issues.push(labelIssue('LABEL_MISSING_FIELD', `${base}.type`, `'type' is required`));
  } else if (!FIELD_PROPERTY_TYPES.includes(type as FieldPropertyType)) {
    c.issues.push(labelIssue('LABEL_INVALID_FIELD', `${base}.type`, `'type' must be one of ${FIELD_PROPERTY_TYPES.join(', ')}`));
  }

  const hasOptions = type === 'select' || type === 'multiselect';
  if (entry.options !== undefined) {
    const wellFormed = Array.isArray(entry.options) && entry.options.length > 0 && entry.options.every(option =>
      (typeof option === 'string' && option.length > 0)
      || (isPlainObject(option) && typeof option.value === 'string' && option.value.length > 0));
    if (!wellFormed) {
      c.issues.push(labelIssue('LABEL_INVALID_FIELD', `${base}.options`, `'options' must be a non-empty array of values or { value, label }`));
    } else if (!hasOptions) {
      c.issues.push(labelIssue('LABEL_INVALID_FIELD', `${base}.options`, `'options' only applies to select and multiselect`));
    }
  } else if (hasOptions) {
    c.issues.push(labelIssue('LABEL_MISSING_FIELD', `${base}.options`, `A '${String(type)}' property must declare 'options'`));
  }
  if (entry.range !== undefined && type !== 'relationship') {
    c.issues.push(labelIssue('LABEL_INVALID_FIELD', `${base}.range`, `'range' only applies to a relationship property`));
  }

  if (entry.qualifiers !== undefined) {
    if (!isPlainObject(entry.qualifiers)) {
      c.issues.push(labelIssue('LABEL_INVALID_FIELD', `${base}.qualifiers`, `'qualifiers' must be an object keyed by qualifier name`));
    } else {
      const issues: LabelQualifierIssue[] = [];
      const warnings: LabelQualifierIssue[] = [];
      for (const [name, declaration] of Object.entries(entry.qualifiers)) {
        validateLabelPropertyQualifierDeclaration(name, declaration, issues, warnings);
      }
      for (const found of issues) c.issues.push({ ...found, path: `${base}.${found.path}` });
      for (const found of warnings) c.warnings.push({ ...found, path: `${base}.${found.path}` });
    }
  }
  return id;
}

/** Report each distinct broader cycle once, on the label whose edge closes it. */
function checkCycles(
  broaderById: ReadonlyMap<string, { index: number; broader: string[] }>,
  c: Collector,
): void {
  const state = new Map<string, 'visiting' | 'done'>();
  const reported = new Set<string>();
  const stack: string[] = [];

  const visit = (id: string): void => {
    state.set(id, 'visiting');
    stack.push(id);
    for (const parent of broaderById.get(id)?.broader ?? []) {
      if (!broaderById.has(parent)) continue;
      const seen = state.get(parent);
      if (seen === 'visiting') {
        const cycle = stack.slice(stack.indexOf(parent));
        const key = [...cycle].sort().join('|');
        if (!reported.has(key)) {
          reported.add(key);
          c.issues.push(labelIssue(
            'LABEL_CYCLE',
            `labels[${broaderById.get(id)!.index}].broader`,
            `Broader labels form a cycle: ${[...cycle, parent].join(' -> ')}`,
          ));
        }
      } else if (!seen) {
        visit(parent);
      }
    }
    stack.pop();
    state.set(id, 'done');
  };

  for (const id of broaderById.keys()) {
    if (!state.has(id)) visit(id);
  }
}

// ---------------------------------------------------------------------------
// Merge by id
// ---------------------------------------------------------------------------

export type LabelRegistrySection = 'labels' | 'properties' | 'claimProperties';

export interface LabelRegistryRemovals {
  labels?: string[];
  properties?: string[];
  claimProperties?: string[];
}

export interface LabelRegistryPatch {
  labels?: LabelDefinition[];
  properties?: FieldPropertyDefinition[];
  claimProperties?: Record<string, ClaimPropertyExtension>;
}

/**
 * Apply an authored patch: each entry replaces the stored entry with its id
 * (in place) or is appended; `removals` deletes by id. Entry-level replacement
 * is what makes two agents adding DIFFERENT entries commute. Whether the
 * result is safe is the classifier's question, not this function's.
 */
export function applyLabelRegistryPatch(
  current: LabelRegistry,
  patch: LabelRegistryPatch,
  removals: LabelRegistryRemovals = {},
): LabelRegistry {
  const upsert = <T extends { id: string }>(list: readonly T[], additions: readonly T[] = [], removed: readonly string[] = []) => {
    const out = list.filter(entry => !removed.includes(entry.id));
    for (const entry of additions) {
      const at = out.findIndex(existing => existing.id === entry.id);
      if (at >= 0) out[at] = entry;
      else out.push(entry);
    }
    return out;
  };
  const claimProperties = { ...current.claimProperties };
  for (const id of removals.claimProperties ?? []) delete claimProperties[id];
  Object.assign(claimProperties, patch.claimProperties ?? {});
  return {
    labels: upsert(current.labels, patch.labels, removals.labels),
    properties: upsert(current.properties, patch.properties, removals.properties),
    claimProperties,
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry !== undefined) out[key] = canonicalize(entry);
    }
    return out;
  }
  return value;
}

/** Entry-order- and key-order-insensitive identity for a registry. */
export function canonicalLabelRegistryJson(registry: LabelRegistry): string {
  const byId = <T extends { id: string }>(list: readonly T[]) => [...list].sort((a, b) => a.id.localeCompare(b.id));
  return JSON.stringify(canonicalize({
    labels: byId(registry.labels),
    properties: byId(registry.properties),
    claimProperties: registry.claimProperties,
  }));
}

/** `labels/<id>`, `properties/<id>`, `claimProperties/<id>`: one key space for the merge. */
function flatten(registry: LabelRegistry | null): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (!registry) return out;
  for (const label of registry.labels) out.set(`labels/${label.id}`, label);
  for (const property of registry.properties) out.set(`properties/${property.id}`, property);
  for (const [id, extension] of Object.entries(registry.claimProperties)) out.set(`claimProperties/${id}`, extension);
  return out;
}

function unflatten(entries: ReadonlyMap<string, unknown>): LabelRegistry {
  const registry = emptyLabelRegistry();
  for (const [key, entry] of entries) {
    const slash = key.indexOf('/');
    const section = key.slice(0, slash) as LabelRegistrySection;
    if (section === 'labels') registry.labels.push(entry as LabelDefinition);
    else if (section === 'properties') registry.properties.push(entry as FieldPropertyDefinition);
    else registry.claimProperties[key.slice(slash + 1)] = entry as ClaimPropertyExtension;
  }
  return registry;
}

function sameEntry(a: unknown, b: unknown): boolean {
  if (a === undefined || b === undefined) return a === b;
  return JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b));
}

export interface LabelRegistryMergeResult {
  merged: LabelRegistry;
  /** `<section>/<id>` keys kept from the local copy over (or absent from) the room's. */
  keptLocal: string[];
  /** `<section>/<id>` keys whose local change the room's newer version replaced. */
  overriddenLocal: string[];
  /**
   * `<section>/<id>` keys whose local change was valid on its own but broke the
   * merged registry (a cycle, a dangling broader, a clash); the room's version
   * was taken instead.
   */
  conflicts: string[];
}

/**
 * Three-way merge of a local copy with the room's registry, per entry, against
 * the room registry this peer last applied. Same rules as the predicate
 * registry merge: untouched locally takes the room's version (including its
 * deletions); changed only locally keeps the local one; changed on both sides
 * lets the room win, and so does the room deleting an entry this peer edited;
 * no baseline makes a first sync the union.
 *
 * Entries merge independently, but validity is a property of the whole
 * registry: `a.broader = [b]` here and `b.broader = [a]` in the room are each
 * valid and together a cycle. So the local decisions are replayed onto the
 * room's registry one at a time, and one that would leave it invalid is
 * dropped in favour of the room's version (reported in `conflicts`). Replay
 * runs to a fixpoint, so local entries that depend on each other survive in
 * any order. The result is valid whenever the room's registry is.
 */
export function mergeLabelRegistries(input: {
  baseline: LabelRegistry | null;
  local: LabelRegistry;
  remote: LabelRegistry;
}): LabelRegistryMergeResult {
  const baseline = flatten(input.baseline);
  const local = flatten(input.local);
  const remote = flatten(input.remote);
  const keptLocal: string[] = [];
  const overriddenLocal: string[] = [];
  /** Local decisions to replay onto the room's registry: a value, or `undefined` for a deletion. */
  const decisions = new Map<string, unknown>();

  for (const [key, mine] of local) {
    const base = baseline.get(key);
    if (sameEntry(mine, base)) continue;
    const theirs = remote.get(key);
    if (sameEntry(mine, theirs)) continue;
    // Absent in the room: a local addition only when the baseline never had it.
    // With a baseline entry, absence is the room's deletion, and it wins.
    const roomUnchanged = theirs === undefined ? base === undefined : sameEntry(theirs, base);
    if (roomUnchanged) decisions.set(key, mine);
    else overriddenLocal.push(key);
  }

  for (const [key, base] of baseline) {
    if (local.has(key)) continue;
    if (sameEntry(remote.get(key), base)) decisions.set(key, undefined);
  }

  const merged = new Map(remote);
  const conflicts: string[] = [];
  if (!validateLabelRegistry(unflatten(merged)).valid) {
    // The room's own registry is invalid: nothing to measure local changes against.
    for (const [key, value] of decisions) setOrDelete(merged, key, value);
    return { merged: unflatten(merged), keptLocal: keptKeys(decisions), overriddenLocal, conflicts };
  }

  let pending = [...decisions.keys()];
  let progressed = true;
  while (pending.length > 0 && progressed) {
    progressed = false;
    const blocked: string[] = [];
    for (const key of pending) {
      const trial = new Map(merged);
      setOrDelete(trial, key, decisions.get(key));
      if (validateLabelRegistry(unflatten(trial)).valid) {
        setOrDelete(merged, key, decisions.get(key));
        progressed = true;
      } else {
        blocked.push(key);
      }
    }
    pending = blocked;
  }
  conflicts.push(...pending);
  for (const key of decisions.keys()) {
    if (!pending.includes(key) && decisions.get(key) !== undefined) keptLocal.push(key);
  }

  return { merged: unflatten(merged), keptLocal, overriddenLocal, conflicts };
}

function setOrDelete(entries: Map<string, unknown>, key: string, value: unknown): void {
  if (value === undefined) entries.delete(key);
  else entries.set(key, value);
}

function keptKeys(decisions: ReadonlyMap<string, unknown>): string[] {
  return [...decisions].filter(([, value]) => value !== undefined).map(([key]) => key);
}

// ---------------------------------------------------------------------------
// Change classification
// ---------------------------------------------------------------------------

/**
 * Keyed table rather than a list so a new kind has to state its verdict. As in
 * the predicate classifier, anything that is not a proven widening is
 * destructive. Presentation (label, pluralLabel, description, icon, color,
 * role, template, factBox, facet) is never a change.
 */
const LABEL_CHANGE_DESTRUCTIVE = {
  'label-added': false,
  'label-removed': true,
  'label-property-added': false,
  'label-property-removed': true,
  'label-broader-added': false,
  'label-broader-removed': true,
  'label-expects-changed': false,
  'property-added': false,
  'property-removed': true,
  'property-type-changed': true,
  'property-option-added': false,
  'property-option-removed': true,
  'property-range-widened': false,
  'property-range-narrowed': true,
  'property-multi-value-changed': true,
  'property-qualifier-changed': true,
  'claim-property-added': false,
  'claim-property-removed': true,
  'claim-property-range-widened': false,
  'claim-property-range-narrowed': true,
  'claim-property-option-added': false,
  'claim-property-option-removed': true,
} as const;

export type LabelRegistryChangeKind = keyof typeof LABEL_CHANGE_DESTRUCTIVE;

export interface LabelRegistryChange {
  kind: LabelRegistryChangeKind;
  section: LabelRegistrySection;
  /** The label, property, or predicate id. */
  id: string;
  /** The property, broader label, option, or qualifier the change is about. */
  detail?: string;
  destructive: boolean;
}

export interface LabelRegistryChangeClassification {
  classification: 'none' | 'additive' | 'destructive';
  changes: LabelRegistryChange[];
}

function labelMap(registry: LabelRegistry): Map<string, LabelDefinition> {
  return new Map(registry.labels.map(label => [label.id, label]));
}

/** Absent range accepts anything; a widening keeps every target the old one accepted. */
function isRangeWidening(previous: readonly string[] | undefined, next: readonly string[] | undefined): boolean {
  if (!next) return true;
  if (!previous) return false;
  return previous.every(id => next.includes(id));
}

export function classifyLabelRegistryChanges(
  previous: LabelRegistry,
  next: LabelRegistry,
): LabelRegistryChangeClassification {
  const changes: LabelRegistryChange[] = [];
  const push = (kind: LabelRegistryChangeKind, section: LabelRegistrySection, id: string, detail?: string) =>
    changes.push({ kind, section, id, ...(detail !== undefined ? { detail } : {}), destructive: LABEL_CHANGE_DESTRUCTIVE[kind] });
  const listDiff = (
    before: readonly string[] | undefined,
    after: readonly string[] | undefined,
    added: LabelRegistryChangeKind,
    removed: LabelRegistryChangeKind,
    section: LabelRegistrySection,
    id: string,
  ) => {
    for (const entry of before ?? []) if (!(after ?? []).includes(entry)) push(removed, section, id, entry);
    for (const entry of after ?? []) if (!(before ?? []).includes(entry)) push(added, section, id, entry);
  };

  const prevLabels = labelMap(previous);
  const nextLabels = labelMap(next);
  for (const id of prevLabels.keys()) if (!nextLabels.has(id)) push('label-removed', 'labels', id);
  for (const [id, label] of nextLabels) {
    const before = prevLabels.get(id);
    if (!before) {
      push('label-added', 'labels', id);
      continue;
    }
    listDiff(before.properties, label.properties, 'label-property-added', 'label-property-removed', 'labels', id);
    listDiff(before.broader, label.broader, 'label-broader-added', 'label-broader-removed', 'labels', id);
    if (!sameEntry(before.expects ?? [], label.expects ?? [])) push('label-expects-changed', 'labels', id);
  }

  const prevProps = new Map(previous.properties.map(p => [p.id, p]));
  const nextProps = new Map(next.properties.map(p => [p.id, p]));
  for (const id of prevProps.keys()) if (!nextProps.has(id)) push('property-removed', 'properties', id);
  for (const [id, property] of nextProps) {
    const before = prevProps.get(id);
    if (!before) {
      push('property-added', 'properties', id);
      continue;
    }
    if (before.type !== property.type) push('property-type-changed', 'properties', id, `${before.type} -> ${property.type}`);
    listDiff(labelPropertyOptionValues(before), labelPropertyOptionValues(property), 'property-option-added', 'property-option-removed', 'properties', id);
    if (!sameEntry(before.range, property.range)) {
      push(isRangeWidening(before.range, property.range) ? 'property-range-widened' : 'property-range-narrowed', 'properties', id);
    }
    if ((before.multiValue === true) !== (property.multiValue === true)) push('property-multi-value-changed', 'properties', id);
    for (const change of classifyLabelPropertyQualifierChanges(before.qualifiers, property.qualifiers)) {
      changes.push({
        kind: 'property-qualifier-changed',
        section: 'properties',
        id,
        detail: `${change.kind}:${change.qualifierName}`,
        destructive: change.destructive,
      });
    }
  }

  for (const id of Object.keys(previous.claimProperties)) {
    if (!(id in next.claimProperties)) push('claim-property-removed', 'claimProperties', id);
  }
  for (const [id, extension] of Object.entries(next.claimProperties)) {
    const before = previous.claimProperties[id];
    if (!before) {
      push('claim-property-added', 'claimProperties', id);
      continue;
    }
    if (!sameEntry(before.range, extension.range)) {
      push(isRangeWidening(before.range, extension.range) ? 'claim-property-range-widened' : 'claim-property-range-narrowed', 'claimProperties', id);
    }
    listDiff(before.options, extension.options, 'claim-property-option-added', 'claim-property-option-removed', 'claimProperties', id);
  }

  const destructive = changes.some(change => change.destructive);
  return {
    classification: changes.length === 0 ? 'none' : destructive ? 'destructive' : 'additive',
    changes,
  };
}
