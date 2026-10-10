/**
 * How pages actually link to each other, per predicate and per pair of labels:
 * every asserted entity-valued statement (a `claim` whose object is a page,
 * or a relationship field whose property declares a range) counted under the
 * subject's and object's own labels, then classified against the vocabulary.
 *
 * - `declared-used`: the subject's label (or a broader one) lists the property
 *   and the object sits in its range.
 * - `declared-unused`: a label lists a ranged property nobody has used yet.
 * - `off-label`: pages use the predicate but the subject's label does not list it.
 * - `range-violation`: the object carries none of the labels the range names.
 *
 * Pure: the type map's lines, pills and inspector all read this.
 */
import {
  isClaimAsserted,
  labelAncestors,
  readClaimRecord,
  type ClaimRecord,
  type LabelRegistry,
  type PredicateDefinition,
} from '@nimbalyst/tracker-schema';
import { propertyRange, type LabelIndex } from '../ontologyLabels';
import { isEmptyFieldValue, ontologyFieldValue, ontologyRecordTitle, refTargets, type OntologyRecordLike } from '../ontologyRecords';

export type RelationshipStatus = 'declared-used' | 'declared-unused' | 'off-label' | 'range-violation';

export interface TypeMapStatement {
  /** Null for a relationship field value. */
  claimId: string | null;
  subjectId: string;
  subjectTitle: string;
  objectId: string;
  objectTitle: string;
  /** Short text from the claim's own qualifiers, e.g. "high, AI app builder". */
  detail: string;
}

export interface TypeMapExpectation {
  min: number;
  /** Pages under the subject label with at least `min` statements. */
  met: number;
  total: number;
  missing: Array<{ id: string; title: string }>;
}

export interface TypeMapRelationship {
  /** `predicate|from|to`. */
  id: string;
  predicate: string;
  /** Short verb for pills and sentences: "in market", "made by". */
  verb: string;
  inverse: string | null;
  symmetric: boolean;
  from: string;
  to: string;
  status: RelationshipStatus;
  statements: number;
  subjects: number;
  objects: number;
  /** The range the vocabulary declares for the predicate; empty when none. */
  range: string[];
  topTargets: Array<{ id: string; title: string; count: number }>;
  expectation: TypeMapExpectation | null;
  /** Every statement, ordered by subject then object title. */
  list: TypeMapStatement[];
}

export interface RelationshipOptions {
  predicates?: readonly PredicateDefinition[];
  predicateLabel?: (id: string) => string;
  /** Labels left off the map (structure labels); statements touching only these are skipped. */
  skipLabels?: ReadonlySet<string>;
}

/** "is a component of" reads as "component of" on a line between two types. */
export function shortVerb(label: string): string {
  return label.replace(/^is\s+(an?\s+)?/i, '').trim() || label;
}

function qualifierText(value: unknown): string {
  if (isEmptyFieldValue(value)) return '';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (Array.isArray(value)) return value.map(qualifierText).filter(Boolean).join(', ');
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return typeof record.title === 'string' ? record.title : '';
  }
  return String(value);
}

/** The labels a statement is filed under: the ones that fit, else every own label. */
function pick(own: readonly string[], fits: (label: string) => boolean): string[] {
  const fitting = own.filter(fits);
  return fitting.length ? fitting : [...own];
}

interface Bucket {
  predicate: string;
  from: string;
  to: string;
  statements: TypeMapStatement[];
  declared: boolean;
  inRange: boolean;
}

export function buildRelationships<T extends OntologyRecordLike>(
  index: LabelIndex<T>,
  records: readonly T[],
  options: RelationshipOptions = {},
): TypeMapRelationship[] {
  const { registry } = index;
  const skip = options.skipLabels ?? new Set<string>();
  const predicates = new Map((options.predicates ?? []).map((predicate) => [predicate.id, predicate]));
  const fieldLabels = new Map(registry.properties.map((property) => [property.id, property.label]));
  const verbOf = (id: string) => shortVerb(predicates.get(id)?.label ?? fieldLabels.get(id) ?? options.predicateLabel?.(id) ?? id.replace(/-/g, ' '));

  const byKey = new Map<string, T>();
  for (const record of records) {
    if (record.archived) continue;
    byKey.set(record.id, record);
    if (record.issueKey) byKey.set(record.issueKey, record);
  }
  const labelsOf = (id: string) => (index.own.get(id) ?? []).filter((label) => !skip.has(label));
  const declaredOn = memo((label: string) => declaredProperties(registry, label));
  const buckets = new Map<string, Bucket>();

  const add = (predicate: string, subject: T, object: T, claimId: string | null, qualifiers: Record<string, unknown>) => {
    const subjectLabels = labelsOf(subject.id);
    const objectLabels = labelsOf(object.id);
    if (!subjectLabels.length || !objectLabels.length) return;
    const range = propertyRange(registry, predicate);
    const objectEffective = index.effective.get(object.id) ?? [];
    const inRange = !range.length || objectEffective.some((label) => range.includes(label));
    const statement: TypeMapStatement = {
      claimId,
      subjectId: subject.id,
      subjectTitle: ontologyRecordTitle(subject),
      objectId: object.id,
      objectTitle: ontologyRecordTitle(object),
      detail: Object.entries(qualifiers).filter(([key]) => key !== 'asOf').map(([, value]) => qualifierText(value)).filter(Boolean).slice(0, 2).join(', '),
    };
    for (const from of pick(subjectLabels, (label) => declaredOn(label).has(predicate))) {
      for (const to of pick(objectLabels, (label) => !range.length || [label, ...labelAncestors(registry, label)].some((id) => range.includes(id)))) {
        const key = `${predicate}|${from}|${to}`;
        let bucket = buckets.get(key);
        if (!bucket) {
          bucket = { predicate, from, to, statements: [], declared: declaredOn(from).has(predicate), inRange };
          buckets.set(key, bucket);
        }
        bucket.statements.push(statement);
      }
    }
  };

  const claims: ClaimRecord[] = [];
  for (const record of records) {
    if (record.primaryType !== 'claim') continue;
    const claim = readClaimRecord(record as Parameters<typeof readClaimRecord>[0]);
    if (!claim || !isClaimAsserted(claim) || !claim.predicate) continue;
    claims.push(claim);
    const subject = claim.subjectId ? byKey.get(claim.subjectId) : undefined;
    if (!subject) continue;
    for (const objectId of refTargets(ontologyFieldValue(record, 'object'))) {
      const object = byKey.get(objectId);
      if (object) add(claim.predicate, subject, object, claim.id, claim.qualifiers);
    }
  }
  // Relationship fields with a declared range are statements too.
  const rangedFields = registry.properties.filter((property) => property.type === 'relationship' && property.range?.length);
  for (const [id, own] of index.own) {
    const subject = byKey.get(id);
    if (!subject || !own.length) continue;
    for (const field of rangedFields) {
      for (const objectId of refTargets(ontologyFieldValue(subject, field.id))) {
        const object = byKey.get(objectId);
        if (object) add(field.id, subject, object, null, {});
      }
    }
  }

  const has = hasValue(claims);
  const out: TypeMapRelationship[] = [];
  for (const bucket of buckets.values()) {
    const status: RelationshipStatus = !bucket.inRange ? 'range-violation' : bucket.declared ? 'declared-used' : 'off-label';
    out.push(finish(bucket.predicate, bucket.from, bucket.to, status, bucket.statements));
  }
  // What the vocabulary declares and nobody uses yet.
  const present = new Set(index.registry.labels.map((label) => label.id).filter((id) => !skip.has(id)));
  for (const label of registry.labels) {
    if (skip.has(label.id)) continue;
    for (const property of label.properties ?? []) {
      for (const target of propertyRange(registry, property)) {
        if (!present.has(target) || buckets.has(`${property}|${label.id}|${target}`)) continue;
        out.push(finish(property, label.id, target, 'declared-unused', []));
      }
    }
  }
  return out.sort((a, b) => b.statements - a.statements || a.from.localeCompare(b.from) || a.predicate.localeCompare(b.predicate) || a.to.localeCompare(b.to));

  function finish(predicate: string, from: string, to: string, status: RelationshipStatus, list: TypeMapStatement[]): TypeMapRelationship {
    const definition = predicates.get(predicate);
    const targets = new Map<string, { id: string; title: string; count: number }>();
    for (const statement of list) {
      const entry = targets.get(statement.objectId) ?? { id: statement.objectId, title: statement.objectTitle, count: 0 };
      entry.count += 1;
      targets.set(statement.objectId, entry);
    }
    const expects = registry.labels.find((label) => label.id === from)?.expects?.find((entry) => entry.property === predicate);
    let expectation: TypeMapExpectation | null = null;
    if (expects && status !== 'off-label' && status !== 'range-violation') {
      const min = Math.max(1, expects.min ?? 1);
      const members = index.members.get(from) ?? [];
      const missing = members.filter((member) => has(member, predicate) < min);
      expectation = { min, met: members.length - missing.length, total: members.length, missing: missing.map((member) => ({ id: member.id, title: ontologyRecordTitle(member) })) };
    }
    return {
      id: `${predicate}|${from}|${to}`,
      predicate,
      verb: verbOf(predicate),
      inverse: definition?.inverseLabel ?? null,
      symmetric: definition?.direction === 'symmetric',
      from,
      to,
      status,
      statements: list.length,
      subjects: new Set(list.map((statement) => statement.subjectId)).size,
      objects: targets.size,
      range: propertyRange(registry, predicate),
      topTargets: [...targets.values()].sort((a, b) => b.count - a.count || a.title.localeCompare(b.title)).slice(0, 5),
      expectation,
      list: [...list].sort((a, b) => a.subjectTitle.localeCompare(b.subjectTitle) || a.objectTitle.localeCompare(b.objectTitle)),
    };
  }
}

/** Property ids a label carries: its own and every broader label's. */
export function declaredProperties(registry: LabelRegistry, labelId: string): Set<string> {
  const byId = new Map(registry.labels.map((label) => [label.id, label]));
  const out = new Set<string>();
  for (const id of [labelId, ...labelAncestors(registry, labelId)]) {
    for (const property of byId.get(id)?.properties ?? []) out.add(property);
  }
  return out;
}

/**
 * How many values a page has for a property: asserted statements with it as
 * the subject, or one for a non-empty field.
 */
export function hasValue(claims: readonly ClaimRecord[]): (record: OntologyRecordLike, property: string) => number {
  const counts = new Map<string, number>();
  for (const claim of claims) {
    if (!claim.subjectId || !claim.predicate || !isClaimAsserted(claim)) continue;
    const key = `${claim.subjectId}\u001f${claim.predicate}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return (record, property) => {
    const fromClaims = (counts.get(`${record.id}\u001f${property}`) ?? 0) + (record.issueKey ? counts.get(`${record.issueKey}\u001f${property}`) ?? 0 : 0);
    if (fromClaims) return fromClaims;
    return isEmptyFieldValue(ontologyFieldValue(record, property)) ? 0 : 1;
  };
}

function memo<V>(fn: (key: string) => V): (key: string) => V {
  const cache = new Map<string, V>();
  return (key) => {
    if (!cache.has(key)) cache.set(key, fn(key));
    return cache.get(key)!;
  };
}
