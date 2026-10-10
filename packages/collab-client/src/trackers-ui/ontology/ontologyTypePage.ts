/**
 * A label's type page as data: where the label sits (broader and narrower),
 * the properties it carries and where each comes from, the relationships in
 * and out, and its instance table.
 *
 * Rows are every live page whose effective labels include the label, so a
 * page labeled with a narrower label is a row of the broader table. Columns
 * are the label's own properties, then its ancestors' (`tableColumns`); a
 * row's other labels never widen the table. A claim-stored cell holds the
 * current value (`currentClaimValue`: the latest `asOf` among asserted
 * claims), or for an entity-valued predicate every page the asserted claims
 * name. Pure, so desktop and the web console build the same table.
 */
import {
  currentClaimValue,
  isQualifiedFieldProperty,
  labelDescendants,
  labelPropertyOptionValues,
  readClaimRecord,
  tableColumns,
  type ClaimRecord,
  type EffectiveProperty,
  type EffectivePropertyStorage,
  type LabelDefinition,
  type LabelRegistry,
} from '@nimbalyst/tracker-schema';
import { buildLabelIndex, labelAncestors, labelName, narrowerLabels, propertyRange, type LabelIndex } from './ontologyLabels';
import { isEmptyFieldValue, ontologyFieldValue, refTargets, type OntologyRecordLike } from './ontologyRecords';

export interface TypeProperty {
  id: string;
  name: string;
  storage: EffectivePropertyStorage;
  /** `select`, `relationship`, `entity`, `text`...: what a value looks like. */
  shape: string;
  /** The ancestor label that contributes it; null for the label's own. */
  inheritedFrom: string | null;
  range: string[];
  facet: boolean;
  qualifiers: string[];
  options: string[];
}

export interface TypeRelationship {
  property: string;
  name: string;
  /** The label listing the property. */
  from: string;
  to: string[];
}

export type TypeCell =
  | {
    storage: 'field' | 'base-field' | 'unknown';
    value: unknown;
    /** Display text; for a relationship, the ids it names are in `targetIds`. */
    text: string;
    targetIds: string[];
    qualifiers: Record<string, unknown> | null;
  }
  | {
    storage: 'claim';
    claimId: string;
    text: string;
    /** Entity-valued: every page the asserted claims name, current first. */
    targetIds: string[];
    asOf: string | null;
    stale: boolean;
  };

export interface TypeRow<T extends OntologyRecordLike = OntologyRecordLike> {
  record: T;
  ownLabels: string[];
  cells: Record<string, TypeCell | null>;
}

export interface TypePageModel<T extends OntologyRecordLike = OntologyRecordLike> {
  id: string;
  label: LabelDefinition | null;
  name: string;
  plural: string;
  broader: string[];
  narrower: string[];
  ancestors: string[];
  descendants: string[];
  properties: TypeProperty[];
  relationsOut: TypeRelationship[];
  relationsIn: TypeRelationship[];
  columns: EffectiveProperty[];
  rows: Array<TypeRow<T>>;
}

export interface TypePageOptions {
  /** Predicate ids in force: the registry's plus any a claim uses. */
  predicateIds: Iterable<string>;
  predicateLabel?: (id: string) => string;
  /** Value shape of a predicate (`entity`, `text`, `quantity`...). */
  predicateShape?: (id: string) => string | undefined;
  now?: Date;
  /** Reuse an index built for the same registry and records. */
  index?: LabelIndex;
}

function text(value: unknown): string {
  if (isEmptyFieldValue(value)) return '';
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join(', ');
  if (typeof value === 'object' && value) {
    const record = value as Record<string, unknown>;
    if (typeof record.url === 'string') return typeof record.label === 'string' ? record.label : record.url;
    if (typeof record.title === 'string') return record.title;
    return '';
  }
  return String(value);
}

export function claimRecordsOf(records: readonly OntologyRecordLike[]): ClaimRecord[] {
  const out: ClaimRecord[] = [];
  for (const record of records) {
    if (record.primaryType !== 'claim') continue;
    const claim = readClaimRecord(record as Parameters<typeof readClaimRecord>[0]);
    if (claim) out.push(claim);
  }
  return out;
}

function claimsBySubject(claims: readonly ClaimRecord[]): Map<string, ClaimRecord[]> {
  const out = new Map<string, ClaimRecord[]>();
  for (const claim of claims) {
    if (!claim.subjectId) continue;
    const list = out.get(claim.subjectId);
    if (list) list.push(claim);
    else out.set(claim.subjectId, [claim]);
  }
  return out;
}

function fieldCell(storage: 'field' | 'base-field' | 'unknown', raw: unknown, qualified: boolean): TypeCell | null {
  let value = raw;
  let qualifiers: Record<string, unknown> | null = null;
  if (qualified && raw && typeof raw === 'object' && !Array.isArray(raw) && 'value' in raw) {
    value = (raw as { value: unknown }).value;
    const q = (raw as { qualifiers?: unknown }).qualifiers;
    qualifiers = q && typeof q === 'object' && !Array.isArray(q) ? q as Record<string, unknown> : null;
  }
  if (isEmptyFieldValue(value)) return null;
  // Only `{ itemId }` values are references; a list of strings is a multiselect.
  const refs = (Array.isArray(value) ? value : [value]).filter((entry) => entry && typeof entry === 'object' && 'itemId' in entry);
  const targetIds = refTargets(refs);
  return { storage, value, text: targetIds.length ? '' : text(value), targetIds, qualifiers };
}

/** One cell of the instance table. Null when the page has no value. */
export function typeCell(
  record: OntologyRecordLike,
  column: EffectiveProperty,
  subjectClaims: readonly ClaimRecord[],
  now: Date,
): TypeCell | null {
  if (column.storage === 'claim') {
    const current = currentClaimValue(subjectClaims, [record.id, ...(record.issueKey ? [record.issueKey] : [])], column.id, { now });
    if (!current) return null;
    const targetIds = [...new Set(current.history.map((claim) => claim.objectId).filter((id): id is string => Boolean(id)))];
    return {
      storage: 'claim',
      claimId: current.claimId,
      text: current.value ?? '',
      targetIds: current.value ? [] : targetIds,
      asOf: current.asOf,
      stale: current.stale,
    };
  }
  const qualified = column.definition ? isQualifiedFieldProperty(column.definition) : false;
  return fieldCell(column.storage, ontologyFieldValue(record, column.id), qualified);
}

export function buildTypePageModel<T extends OntologyRecordLike>(
  registry: LabelRegistry,
  labelId: string,
  records: readonly T[],
  options: TypePageOptions,
): TypePageModel<T> {
  const predicates = new Set(options.predicateIds);
  const isPredicate = (id: string) => predicates.has(id);
  const index = (options.index as LabelIndex<T> | undefined) ?? buildLabelIndex(registry, records);
  const label = registry.labels.find((entry) => entry.id === labelId) ?? null;
  const now = options.now ?? new Date();
  const predicateLabel = options.predicateLabel ?? ((id: string) => id.replace(/-/g, ' '));
  const columns = tableColumns(registry, labelId, { isPredicate });
  const fields = new Map(registry.properties.map((property) => [property.id, property]));

  const properties: TypeProperty[] = columns.map((column) => {
    const field = fields.get(column.id);
    const claim = registry.claimProperties[column.id];
    const shape = field?.type ?? (column.storage === 'claim' ? options.predicateShape?.(column.id) ?? (claim?.range ? 'entity' : 'value') : column.storage === 'base-field' ? 'field' : 'unknown');
    return {
      id: column.id,
      name: field?.label ?? predicateLabel(column.id),
      storage: column.storage,
      shape,
      inheritedFrom: column.viaLabel === labelId ? null : column.viaLabel,
      range: propertyRange(registry, column.id),
      facet: Boolean(field?.facet ?? claim?.facet),
      qualifiers: Object.keys(field?.qualifiers ?? {}),
      options: field ? labelPropertyOptionValues(field) : claim?.options ?? [],
    };
  });

  const ancestors = labelAncestors(registry, labelId);
  const relationsOut = properties
    .filter((property) => property.range.length > 0)
    .map((property) => ({ property: property.id, name: property.name, from: property.inheritedFrom ?? labelId, to: property.range }));
  const self = new Set([labelId, ...ancestors]);
  const relationsIn: TypeRelationship[] = [];
  for (const other of registry.labels) {
    for (const property of other.properties ?? []) {
      const range = propertyRange(registry, property);
      if (range.some((target) => self.has(target))) {
        relationsIn.push({ property, name: fields.get(property)?.label ?? predicateLabel(property), from: other.id, to: range });
      }
    }
  }

  const bySubject = claimsBySubject(claimRecordsOf(records));
  const rows = (index.members.get(labelId) ?? []).map((record) => {
    const subjectClaims = [...(bySubject.get(record.id) ?? []), ...(record.issueKey ? bySubject.get(record.issueKey) ?? [] : [])];
    const cells: Record<string, TypeCell | null> = {};
    for (const column of columns) cells[column.id] = typeCell(record, column, subjectClaims, now);
    return { record, ownLabels: index.own.get(record.id) ?? [], cells };
  });

  return {
    id: labelId,
    label,
    name: labelName(registry, labelId),
    plural: labelName(registry, labelId, true),
    broader: label?.broader ?? [],
    narrower: narrowerLabels(registry, labelId),
    ancestors,
    descendants: labelDescendants(registry, labelId),
    properties,
    relationsOut,
    relationsIn,
    columns,
    rows,
  };
}
