/**
 * Label registry: the vocabulary half that `predicates.yaml` cannot carry.
 *
 * A label is a tag that carries fields. Put `feature` on a page and the page
 * has `feature`'s properties; a page may carry several labels, and a label may
 * sit under several broader labels. Labels are data in a registry rather than
 * tracker types (`extends`), because a tracker item has exactly one type and
 * relabeling must not mean moving it to another schema.
 *
 * The registry is `.nimbalyst/labels.yaml`, and like the predicate registry it
 * is a SCHEMA ARTIFACT the room owns and publishes on the schema lane under a
 * reserved type (`__labels__`, see `schemaSyncPayload.ts`). It has three
 * sections:
 *
 *  - `labels`          the labels themselves;
 *  - `properties`      FIELD-stored vocabulary entries, kept on the item as
 *                      `customFields[<id>]` (current value only);
 *  - `claimProperties` extensions to CLAIM-stored entries, keyed by predicate
 *                      id. The predicate itself stays in `predicates.yaml`; this
 *                      section carries the keys old clients would reject there
 *                      (`range`, `options`, `facet`).
 *
 * Field properties and predicates share ONE id namespace, so a label's
 * `properties` list names either without saying which.
 *
 * This module is the READ path every surface needs on first paint: the model,
 * resolution (labels, ancestors, effective properties, table columns), and the
 * warning-only checks on stored values. Validating, merging, patching and
 * classifying a registry is authoring, in `labelRegistryAuthoring.ts`; the
 * package root re-exports only its `validateLabelRegistry`, and the rest is
 * imported from `@nimbalyst/tracker-schema/labelRegistryAuthoring`, so a
 * browser bundle that re-exports the root does not carry the merge and the
 * classifier.
 *
 * Everything here is pure: plain objects in, plain objects out. Desktop, the
 * browser store, and the collab server all import it.
 */

import {
  validateLabelPropertyQualifiers,
  type LabelPropertyQualifierDefinition,
  type LabelQualifierErrorCode,
} from './labelPropertyQualifiers.js';

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/** `structure` pages (areas, home) and `market-node` pages render specially in the wiki. */
export type LabelRole = 'page' | 'structure' | 'market-node';

export const LABEL_ROLES: readonly LabelRole[] = ['page', 'structure', 'market-node'];

/** Soft constraint: reported by health checks, never blocks a write. */
export interface LabelExpectation {
  property: string;
  min?: number;
  max?: number;
}

export interface LabelDefinition {
  id: string;
  label: string;
  pluralLabel?: string;
  description?: string;
  /** Multiple parents allowed; the graph must stay acyclic. */
  broader?: string[];
  icon?: string;
  color?: string;
  role?: LabelRole;
  /** Field property ids, predicate ids, or base field names of the item type. */
  properties?: string[];
  expects?: LabelExpectation[];
  /** Property ids shown in the page's fact box, in order. */
  factBox?: string[];
  /** Body skeleton for new pages. */
  template?: string;
  /** Reserved for declarative actions (a later plan). Accepted and ignored. */
  actions?: unknown;
}

export type FieldPropertyType =
  | 'string'
  | 'text'
  | 'number'
  | 'date'
  | 'datetime'
  | 'select'
  | 'multiselect'
  | 'boolean'
  | 'url'
  | 'user'
  | 'relationship'
  | 'array';

export const FIELD_PROPERTY_TYPES: readonly FieldPropertyType[] = [
  'string',
  'text',
  'number',
  'date',
  'datetime',
  'select',
  'multiselect',
  'boolean',
  'url',
  'user',
  'relationship',
  'array',
];

export type LabelPropertyOption = string | { value: string; label?: string; icon?: string; color?: string };

export interface FieldPropertyDefinition {
  id: string;
  label: string;
  type: FieldPropertyType;
  /** For `select` / `multiselect`. */
  options?: LabelPropertyOption[];
  /**
   * See `./labelPropertyQualifiers.ts`. When present the value is stored as
   * `{ value, qualifiers }`; otherwise it is stored bare.
   */
  qualifiers?: Record<string, LabelPropertyQualifierDefinition>;
  /** Offered as a search facet. */
  facet?: boolean;
  description?: string;
  /** For `relationship`: label ids the target should carry. Absent means any. */
  range?: string[];
  /** For `relationship`: more than one target. */
  multiValue?: boolean;
}

/** Extra keys for a claim-stored entry, which `predicates.yaml` cannot carry yet. */
export interface ClaimPropertyExtension {
  /** Label ids an entity-valued claim's object should carry. Absent means any. */
  range?: string[];
  /** Allowed values for a `select` predicate. */
  options?: string[];
  facet?: boolean;
  description?: string;
}

export interface LabelRegistry {
  labels: LabelDefinition[];
  properties: FieldPropertyDefinition[];
  claimProperties: Record<string, ClaimPropertyExtension>;
}

export function emptyLabelRegistry(): LabelRegistry {
  return { labels: [], properties: [], claimProperties: {} };
}

export function isLabelRegistryEmpty(registry: LabelRegistry): boolean {
  return registry.labels.length === 0
    && registry.properties.length === 0
    && Object.keys(registry.claimProperties).length === 0;
}

/**
 * Field names of the reference `entity` type. A field property may not reuse
 * one (its value would live in two places), but a label may LIST one in
 * `properties` -- `website` is a base field a label can still ask for.
 */
export const DEFAULT_LABEL_BASE_FIELD_NAMES: readonly string[] = [
  'title',
  'kind',
  'labels',
  'status',
  'parent',
  'aliases',
  'scopeId',
  'reviewState',
  'summary',
  'website',
  'tags',
  'created',
  'updated',
];

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

export type LabelErrorCode =
  | 'LABEL_REGISTRY_NOT_AN_OBJECT'
  | 'LABEL_NOT_AN_OBJECT'
  | 'LABEL_MISSING_FIELD'
  | 'LABEL_INVALID_FIELD'
  | 'LABEL_UNKNOWN_FIELD'
  | 'LABEL_DUPLICATE_ID'
  | 'LABEL_BROADER_UNKNOWN'
  | 'LABEL_CYCLE'
  | 'LABEL_PROPERTY_ID_CONFLICT'
  | 'LABEL_PROPERTY_BASE_FIELD'
  | 'LABEL_UNKNOWN_PROPERTY'
  | 'LABEL_EXPECTS_UNKNOWN_PROPERTY'
  | 'LABEL_RANGE_UNKNOWN'
  | 'LABEL_CLAIM_PROPERTY_UNKNOWN_PREDICATE'
  // Item values
  | 'LABEL_REF_INVALID'
  | 'LABEL_UNKNOWN'
  | 'LABEL_PROPERTY_INVALID_VALUE'
  | 'LABEL_PROPERTY_UNKNOWN_OPTION'
  | 'LABEL_PROPERTY_EXPECTS_QUALIFIED_VALUE';

export interface LabelIssue {
  code: LabelErrorCode | LabelQualifierErrorCode;
  path: string;
  message: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function labelIssue(code: LabelIssue['code'], path: string, message: string): LabelIssue {
  return { code, path, message };
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** The part of an item label resolution reads. `customFields` is checked too. */
export type LabeledItem = {
  labels?: unknown;
  kind?: unknown;
  customFields?: unknown;
};

function readItemField(item: LabeledItem, key: 'labels' | 'kind'): unknown {
  const direct = item[key];
  if (direct !== undefined && direct !== null) return direct;
  return isPlainObject(item.customFields) ? item.customFields[key] : undefined;
}

/** An item's own labels: its `labels` field, then its legacy `kind`, deduplicated. */
export function itemOwnLabels(item: LabeledItem): string[] {
  const out: string[] = [];
  const add = (value: unknown) => {
    if (typeof value === 'string' && value.length > 0 && !out.includes(value)) out.push(value);
  };
  const labels = readItemField(item, 'labels');
  if (Array.isArray(labels)) labels.forEach(add);
  else add(labels);
  add(readItemField(item, 'kind'));
  return out;
}

function labelMap(registry: LabelRegistry): Map<string, LabelDefinition> {
  return new Map(registry.labels.map(label => [label.id, label]));
}

/** Breadth-first closure under `broader`, starting labels first. Cycle-safe. */
function closeUnderBroader(start: readonly string[], byId: ReadonlyMap<string, LabelDefinition>): string[] {
  const out = [...start];
  const seen = new Set(out);
  for (let i = 0; i < out.length; i += 1) {
    for (const parent of byId.get(out[i])?.broader ?? []) {
      if (!seen.has(parent)) {
        seen.add(parent);
        out.push(parent);
      }
    }
  }
  return out;
}

/**
 * Effective labels of an item: its own labels plus its legacy `kind`, closed
 * under `broader`. Unknown labels are kept, never dropped -- a health check
 * reports them.
 */
export function resolveLabels(registry: LabelRegistry, item: LabeledItem): string[] {
  return closeUnderBroader(itemOwnLabels(item), labelMap(registry));
}

/** Every label above `labelId`, nearest first, excluding itself. */
export function labelAncestors(registry: LabelRegistry, labelId: string): string[] {
  return closeUnderBroader([labelId], labelMap(registry)).slice(1);
}

/** Every label below `labelId`, in registry order, excluding itself. */
export function labelDescendants(registry: LabelRegistry, labelId: string): string[] {
  const byId = labelMap(registry);
  return registry.labels
    .filter(label => label.id !== labelId && closeUnderBroader([label.id], byId).includes(labelId))
    .map(label => label.id);
}

export type EffectivePropertyStorage = 'field' | 'claim' | 'base-field' | 'unknown';

export interface EffectiveProperty {
  id: string;
  storage: EffectivePropertyStorage;
  /** The first label (in resolution order) that lists this property. */
  viaLabel: string;
  /** Present when `storage === 'field'`. */
  definition?: FieldPropertyDefinition;
  /** The `claimProperties` extension, when one is declared. */
  claim?: ClaimPropertyExtension;
}

export interface EffectivePropertyOptions {
  /** Whether an id is a predicate. Without it, only `claimProperties` marks a claim. */
  isPredicate?: (id: string) => boolean;
  baseFieldNames?: readonly string[];
}

function propertiesOfLabels(
  registry: LabelRegistry,
  labelIds: readonly string[],
  options: EffectivePropertyOptions,
): EffectiveProperty[] {
  const byId = labelMap(registry);
  const fieldProperties = new Map(registry.properties.map(property => [property.id, property]));
  const baseFields = options.baseFieldNames ?? DEFAULT_LABEL_BASE_FIELD_NAMES;
  const seen = new Set<string>();
  const out: EffectiveProperty[] = [];
  for (const labelId of labelIds) {
    for (const id of byId.get(labelId)?.properties ?? []) {
      if (seen.has(id)) continue;
      seen.add(id);
      const definition = fieldProperties.get(id);
      const claim = registry.claimProperties[id];
      const storage: EffectivePropertyStorage = definition
        ? 'field'
        : claim || options.isPredicate?.(id)
          ? 'claim'
          : baseFields.includes(id) ? 'base-field' : 'unknown';
      out.push({
        id,
        storage,
        viaLabel: labelId,
        ...(definition ? { definition } : {}),
        ...(claim ? { claim } : {}),
      });
    }
  }
  return out;
}

/**
 * Union of `properties` over an item's effective labels: own labels first,
 * then ancestors, each property once. Properties are global ids, so two labels
 * asking for `owner` share the one `owner`.
 */
export function effectiveProperties(
  registry: LabelRegistry,
  item: LabeledItem,
  options: EffectivePropertyOptions = {},
): EffectiveProperty[] {
  return propertiesOfLabels(registry, resolveLabels(registry, item), options);
}

/**
 * Columns of a label's instance table: its own properties, then its
 * ancestors'. An item's OTHER labels never widen the table, so the columns
 * stay stable as items are relabeled.
 */
export function tableColumns(
  registry: LabelRegistry,
  labelId: string,
  options: EffectivePropertyOptions = {},
): EffectiveProperty[] {
  return propertiesOfLabels(registry, closeUnderBroader([labelId], labelMap(registry)), options);
}

// ---------------------------------------------------------------------------
// Item values (warnings only)
// ---------------------------------------------------------------------------

export function labelPropertyOptionValues(property: FieldPropertyDefinition): string[] {
  return (property.options ?? []).map(option => (typeof option === 'string' ? option : option.value));
}

/** Whether a property's value is stored as `{ value, qualifiers }`. */
export function isQualifiedFieldProperty(property: FieldPropertyDefinition): boolean {
  return !!property.qualifiers && Object.keys(property.qualifiers).length > 0;
}

/**
 * Check a stored field-property value against its declaration. Every issue is
 * a WARNING: the vocabulary may have moved under a value written earlier, and
 * a write path must never destroy it for that.
 */
export function validateFieldPropertyValue(property: FieldPropertyDefinition, stored: unknown): LabelIssue[] {
  const issues: LabelIssue[] = [];
  let value = stored;
  if (isQualifiedFieldProperty(property)) {
    if (isPlainObject(stored) && 'value' in stored) {
      value = stored.value;
      for (const found of validateLabelPropertyQualifiers(property.id, property.qualifiers, stored.qualifiers)) {
        issues.push({ ...found, path: `qualifiers${found.path ? `.${found.path}` : ''}` });
      }
    } else {
      issues.push(labelIssue(
        'LABEL_PROPERTY_EXPECTS_QUALIFIED_VALUE',
        '',
        `Property '${property.id}' declares qualifiers, so its value is stored as { value, qualifiers }`,
      ));
    }
  }
  if (value === undefined || value === null) return issues;

  const wrong = (expected: string) =>
    issues.push(labelIssue('LABEL_PROPERTY_INVALID_VALUE', '', `Property '${property.id}' must be ${expected}`));
  const options = labelPropertyOptionValues(property);
  const checkOption = (option: unknown): void => {
    if (typeof option !== 'string') {
      wrong('a string option');
    } else if (options.length > 0 && !options.includes(option)) {
      issues.push(labelIssue('LABEL_PROPERTY_UNKNOWN_OPTION', '', `Property '${property.id}' has an unrecognized option: ${option}`));
    }
  };

  switch (property.type) {
    case 'string':
    case 'text':
    case 'user':
      if (typeof value !== 'string') wrong('a string');
      break;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) wrong('a finite number');
      break;
    case 'boolean':
      if (typeof value !== 'boolean') wrong('a boolean');
      break;
    case 'date':
    case 'datetime':
      if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) wrong('an ISO date string');
      break;
    case 'select':
      checkOption(value);
      break;
    case 'multiselect':
      if (!Array.isArray(value)) wrong('an array of options');
      else value.forEach(checkOption);
      break;
    case 'url': {
      const url = typeof value === 'string' ? value : isPlainObject(value) ? value.url : undefined;
      if (typeof url !== 'string' || url.length === 0) wrong('a URL string or { url, label }');
      break;
    }
    case 'relationship': {
      const targets = Array.isArray(value) ? value : [value];
      if (!targets.every(target => isPlainObject(target) && typeof target.itemId === 'string' && target.itemId.length > 0)) {
        wrong('a relationship reference with an itemId');
      }
      break;
    }
    case 'array':
      if (!Array.isArray(value)) wrong('an array');
      break;
  }
  return issues;
}

/** Check a `label-ref` value. Unknown labels are warnings; a malformed value is an error. */
export function validateLabelRefValue(
  registry: LabelRegistry,
  value: unknown,
): { errors: LabelIssue[]; warnings: LabelIssue[] } {
  const entries = Array.isArray(value) ? value : [value];
  if (!entries.every(entry => typeof entry === 'string' && entry.length > 0)) {
    return { errors: [labelIssue('LABEL_REF_INVALID', '', 'Labels must be label ids')], warnings: [] };
  }
  // An empty registry means the project has not adopted labels yet.
  if (registry.labels.length === 0) return { errors: [], warnings: [] };
  const known = labelMap(registry);
  const warnings = (entries as string[])
    .filter(entry => !known.has(entry))
    .map(entry => labelIssue('LABEL_UNKNOWN', '', `Unknown label '${entry}'`));
  return { errors: [], warnings };
}
