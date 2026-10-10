// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  effectiveProperties,
  labelDescendants,
  resolveLabels,
  tableColumns,
  type LabelRegistry,
} from '../labelRegistry.js';
import {
  applyLabelRegistryPatch,
  canonicalLabelRegistryJson,
  classifyLabelRegistryChanges,
  mergeLabelRegistries,
  validateLabelRegistry,
} from '../labelRegistryAuthoring.js';
import { TrackerDataModelRegistry, type TrackerDataModel } from '../TrackerDataModel.js';

/**
 * `feature` sits under two parents, and both `capability` and `feature` list
 * `owner`: the shared-property case the union has to collapse to one entry.
 */
function specRegistry(): LabelRegistry {
  return {
    labels: [
      { id: 'capability', label: 'Capability', properties: ['owner', 'maturity'] },
      { id: 'user-facing', label: 'User-facing', properties: ['surface'] },
      {
        id: 'feature',
        label: 'Feature',
        broader: ['capability', 'user-facing'],
        properties: ['flag', 'owner', 'implemented-in'],
        expects: [{ property: 'implemented-in', min: 1 }],
      },
      { id: 'requirement', label: 'Requirement', properties: ['priority-level'] },
    ],
    properties: [
      { id: 'owner', label: 'Owner', type: 'string' },
      { id: 'maturity', label: 'Maturity', type: 'select', options: ['alpha', 'stable'] },
      { id: 'surface', label: 'Surface', type: 'select', options: ['desktop', 'web'], facet: true },
      { id: 'flag', label: 'Feature flag', type: 'string', qualifiers: { since: { type: 'string' } } },
      { id: 'priority-level', label: 'Priority', type: 'number' },
    ],
    claimProperties: { 'implemented-in': { range: ['feature'] } },
  };
}

const PREDICATE_IDS = ['implemented-in'];
const ids = (list: ReadonlyArray<{ id: string }>) => list.map(entry => entry.id);

describe('label registry validation', () => {
  it('accepts a multi-parent DAG and keeps unknown keys as warnings', () => {
    const raw = { ...specRegistry(), futureKey: true };
    const result = validateLabelRegistry(raw, { predicateIds: PREDICATE_IDS });
    expect(result.valid).toBe(true);
    expect(result.warnings.map(w => w.code)).toEqual(['LABEL_UNKNOWN_FIELD']);
  });

  it('rejects a broader cycle, a missing broader target, and a shared id across files', () => {
    const registry = specRegistry();
    registry.labels[0] = { ...registry.labels[0], broader: ['feature'] };
    registry.labels.push({ id: 'orphan', label: 'Orphan', broader: ['nowhere'] });
    registry.properties.push({ id: 'implemented-in', label: 'Clash', type: 'string' });
    const result = validateLabelRegistry(registry, { predicateIds: PREDICATE_IDS });
    expect(result.valid).toBe(false);
    expect(result.issues.map(i => i.code).sort()).toEqual([
      'LABEL_BROADER_UNKNOWN',
      'LABEL_CYCLE',
      'LABEL_PROPERTY_ID_CONFLICT',
    ]);
  });

  it('rejects a property named after a base field and an expectation on nothing', () => {
    const registry = specRegistry();
    registry.properties.push({ id: 'status', label: 'Status', type: 'string' });
    registry.labels[3] = { ...registry.labels[3], expects: [{ property: 'missing' }] };
    const result = validateLabelRegistry(registry, { predicateIds: PREDICATE_IDS });
    expect(result.issues.map(i => i.code).sort()).toEqual([
      'LABEL_EXPECTS_UNKNOWN_PROPERTY',
      'LABEL_PROPERTY_BASE_FIELD',
    ]);
  });
});

describe('field property qualifiers', () => {
  const withFlagQualifiers = (qualifiers: Record<string, unknown>): LabelRegistry => {
    const registry = specRegistry();
    registry.properties = registry.properties.map(p => (p.id === 'flag' ? { ...p, qualifiers } as typeof p : p));
    return registry;
  };

  it('validates qualifier declarations with label codes and paths', () => {
    const result = validateLabelRegistry(
      withFlagQualifiers({ mode: { type: 'select' }, since: { type: 'string', itemType: 'string', hint: 'x' } }),
      { predicateIds: PREDICATE_IDS },
    );
    expect(result.valid).toBe(false);
    expect(result.issues.map(i => `${i.code} ${i.path}`)).toEqual([
      'LABEL_MISSING_FIELD properties[3].qualifiers.mode.options',
      'LABEL_INVALID_FIELD properties[3].qualifiers.since.itemType',
    ]);
    expect(result.warnings.map(w => w.path)).toEqual(['properties[3].qualifiers.since.hint']);
  });

  it('checks a stored qualifier bag: required, unknown, and wrong type', () => {
    const registry = new TrackerDataModelRegistry();
    registry.register({
      type: 'entity',
      displayName: 'Entity',
      displayNamePlural: 'Entities',
      fields: [{ name: 'title', type: 'string', required: true }, { name: 'labels', type: 'label-ref', multiValue: true }],
    } as TrackerDataModel);
    registry.setLabels(withFlagQualifiers({
      since: { type: 'string', required: true },
      stage: { type: 'select', options: ['beta', 'ga'] },
    }));
    const result = registry.validate('entity', {
      title: 'Sync lane',
      customFields: { flag: { value: 'labels-v1', qualifiers: { stage: 'rc', sinse: '0.9' } } },
    });
    expect(result.warnings?.map(w => `${w.code} ${w.field}`)).toEqual([
      'LABEL_QUALIFIER_REQUIRED flag.qualifiers.since',
      'LABEL_QUALIFIER_INVALID_OPTION flag.qualifiers.stage',
      'LABEL_QUALIFIER_UNKNOWN flag.qualifiers.sinse',
    ]);
  });

  it('classifies an optional qualifier as additive and a newly required one as destructive', () => {
    const before = specRegistry();
    const added = classifyLabelRegistryChanges(before, withFlagQualifiers({
      since: { type: 'string' },
      notes: { type: 'string' },
    }));
    expect(added.classification).toBe('additive');
    expect(added.changes).toEqual([
      expect.objectContaining({ kind: 'property-qualifier-changed', id: 'flag', detail: 'qualifier-added:notes' }),
    ]);

    const required = classifyLabelRegistryChanges(before, withFlagQualifiers({ since: { type: 'string', required: true } }));
    expect(required.classification).toBe('destructive');
    expect(required.changes[0]).toMatchObject({ detail: 'qualifier-made-required:since', destructive: true });
  });
});

describe('label resolution', () => {
  it('closes item labels and the legacy kind under every broader parent', () => {
    const registry = specRegistry();
    expect(resolveLabels(registry, { labels: ['feature'], kind: 'requirement' })).toEqual([
      'feature', 'requirement', 'capability', 'user-facing',
    ]);
    expect(labelDescendants(registry, 'capability')).toEqual(['feature']);
  });

  it('unions properties across labels, collapsing the one they share, own labels first', () => {
    const props = effectiveProperties(specRegistry(), { labels: ['feature'] }, {
      isPredicate: id => PREDICATE_IDS.includes(id),
    });
    expect(ids(props)).toEqual(['flag', 'owner', 'implemented-in', 'maturity', 'surface']);
    expect(props.find(p => p.id === 'implemented-in')?.storage).toBe('claim');
    expect(props.find(p => p.id === 'owner')?.viaLabel).toBe('feature');
  });

  it('builds table columns from a label and its ancestors, never from other labels', () => {
    expect(ids(tableColumns(specRegistry(), 'feature'))).toEqual([
      'flag', 'owner', 'implemented-in', 'maturity', 'surface',
    ]);
    expect(ids(tableColumns(specRegistry(), 'capability'))).toEqual(['owner', 'maturity']);
  });
});

describe('label registry merge', () => {
  it('commutes two concurrent additive changes, through the patch and the sync merge', () => {
    const base = specRegistry();
    const addTopic = { labels: [{ id: 'topic', label: 'Topic' }] };
    const addOwnerTeam = { properties: [{ id: 'owner-team', label: 'Owner team', type: 'string' as const }] };

    const ab = applyLabelRegistryPatch(applyLabelRegistryPatch(base, addTopic), addOwnerTeam);
    const ba = applyLabelRegistryPatch(applyLabelRegistryPatch(base, addOwnerTeam), addTopic);
    expect(canonicalLabelRegistryJson(ab)).toBe(canonicalLabelRegistryJson(ba));

    const mine = applyLabelRegistryPatch(base, addTopic);
    const theirs = applyLabelRegistryPatch(base, addOwnerTeam);
    const here = mergeLabelRegistries({ baseline: base, local: mine, remote: theirs }).merged;
    const there = mergeLabelRegistries({ baseline: base, local: theirs, remote: mine }).merged;
    expect(canonicalLabelRegistryJson(here)).toBe(canonicalLabelRegistryJson(there));
    expect(canonicalLabelRegistryJson(here)).toBe(canonicalLabelRegistryJson(ab));
  });

  it('takes the union on a first sync and lets the room win a conflicting edit', () => {
    const base = specRegistry();
    const local = applyLabelRegistryPatch(base, { labels: [{ id: 'topic', label: 'Local topic' }] });
    const remote = applyLabelRegistryPatch(base, { labels: [{ id: 'topic', label: 'Room topic' }] });
    const first = mergeLabelRegistries({ baseline: null, local, remote: { labels: [], properties: [], claimProperties: {} } });
    expect(ids(first.merged.labels)).toContain('topic');
    const conflict = mergeLabelRegistries({ baseline: base, local, remote });
    expect(conflict.merged.labels.find(l => l.id === 'topic')?.label).toBe('Room topic');
    expect(conflict.overriddenLocal).toEqual(['labels/topic']);
  });

  it('lets the room delete an entry this peer edited, in every section', () => {
    const base = specRegistry();
    const local = applyLabelRegistryPatch(base, {
      labels: [{ id: 'requirement', label: 'Local requirement', properties: ['priority-level'] }],
      properties: [{ id: 'owner', label: 'Local owner', type: 'string' }],
      claimProperties: { 'implemented-in': { range: ['feature'], description: 'local' } },
    });
    const remote = applyLabelRegistryPatch(base, {}, {
      labels: ['requirement'],
      properties: ['owner'],
      claimProperties: ['implemented-in'],
    });
    const result = mergeLabelRegistries({ baseline: base, local, remote });
    expect(canonicalLabelRegistryJson(result.merged)).toBe(canonicalLabelRegistryJson(remote));
    expect(result.keptLocal).toEqual([]);
    expect(result.overriddenLocal.sort()).toEqual(['claimProperties/implemented-in', 'labels/requirement', 'properties/owner']);
  });

  it('never returns an invalid registry from two individually valid edits; the room wins the conflict', () => {
    const base: LabelRegistry = {
      labels: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }],
      properties: [],
      claimProperties: {},
    };
    // Locally: a under b, plus an unrelated new label d under a. In the room: b under a.
    const local = applyLabelRegistryPatch(base, { labels: [{ id: 'd', label: 'D', broader: ['a'] }, { id: 'a', label: 'A', broader: ['b'] }] });
    const remote = applyLabelRegistryPatch(base, { labels: [{ id: 'b', label: 'B', broader: ['a'] }] });
    const result = mergeLabelRegistries({ baseline: base, local, remote });
    expect(validateLabelRegistry(result.merged).valid).toBe(true);
    expect(result.merged.labels.find(l => l.id === 'a')?.broader).toBeUndefined();
    expect(result.merged.labels.find(l => l.id === 'b')?.broader).toEqual(['a']);
    expect(result.keptLocal).toEqual(['labels/d']);
    expect(result.conflicts).toEqual(['labels/a']);

    // A local label under one the room deleted: the dangling entry takes the room's version.
    const orphaned = mergeLabelRegistries({
      baseline: base,
      local: applyLabelRegistryPatch(base, { labels: [{ id: 'e', label: 'E', broader: ['c'] }] }),
      remote: applyLabelRegistryPatch(base, {}, { labels: ['c'] }),
    });
    expect(validateLabelRegistry(orphaned.merged).valid).toBe(true);
    expect(ids(orphaned.merged.labels)).toEqual(['a', 'b']);
    expect(orphaned.conflicts).toEqual(['labels/e']);
  });

  it('classifies additions as additive and removals or retypes as destructive', () => {
    const base = specRegistry();
    const added = applyLabelRegistryPatch(base, {
      labels: [{ id: 'topic', label: 'Topic' }],
      properties: [{ id: 'maturity', label: 'Maturity', type: 'select', options: ['alpha', 'stable', 'beta'] }],
    });
    expect(classifyLabelRegistryChanges(base, added).classification).toBe('additive');

    const retyped = applyLabelRegistryPatch(base, { properties: [{ id: 'owner', label: 'Owner', type: 'number' }] });
    expect(classifyLabelRegistryChanges(base, retyped).classification).toBe('destructive');

    const shrunk = applyLabelRegistryPatch(base, { labels: [{ id: 'capability', label: 'Capability', properties: ['owner'] }] });
    expect(classifyLabelRegistryChanges(base, shrunk).changes.map(c => c.kind)).toEqual(['label-property-removed']);

    const removed = applyLabelRegistryPatch(base, {}, { labels: ['requirement'] });
    expect(classifyLabelRegistryChanges(base, removed).classification).toBe('destructive');
  });
});

describe('labels on the tracker registry', () => {
  const entity: TrackerDataModel = {
    type: 'entity',
    displayName: 'Entity',
    displayNamePlural: 'Entities',
    icon: 'category',
    color: '#000000',
    modes: { inline: true, fullDocument: true },
    idPrefix: 'ent',
    idFormat: 'ulid',
    fields: [
      { name: 'title', type: 'string', required: true },
      { name: 'kind', type: 'select', options: [{ value: 'requirement', label: 'Requirement' }] },
      { name: 'labels', type: 'label-ref', multiValue: true },
    ],
  };

  function registryWithLabels(): TrackerDataModelRegistry {
    const registry = new TrackerDataModelRegistry();
    registry.register(entity);
    registry.setLabels(specRegistry());
    return registry;
  }

  it('warns on an unknown label and a mistyped field property, and never blocks the write', () => {
    const result = registryWithLabels().validate('entity', {
      title: 'Sync lane',
      labels: ['feature', 'not-a-label'],
      customFields: { 'priority-level': 'high', flag: { value: 'labels-v1', qualifiers: { since: '0.9' } } },
    });
    expect(result.valid).toBe(true);
    expect(result.warnings?.map(w => w.code).sort()).toEqual(['LABEL_PROPERTY_INVALID_VALUE', 'LABEL_UNKNOWN']);
  });

  it('warns when a qualified property is stored as a bare value', () => {
    const result = registryWithLabels().validate('entity', {
      title: 'Sync lane',
      customFields: { flag: 'labels-v1' },
    });
    expect(result.warnings?.map(w => w.code)).toEqual(['LABEL_PROPERTY_EXPECTS_QUALIFIED_VALUE']);
  });

  it('checks label property values only on a type that carries labels', () => {
    const registry = registryWithLabels();
    registry.register({
      ...entity,
      type: 'bug',
      idPrefix: 'bug',
      fields: [{ name: 'title', type: 'string', required: true }, { name: 'labels', type: 'array', itemType: 'string' }],
    });
    const result = registry.validate('bug', {
      title: 'Crash on save',
      labels: ['feature'],
      customFields: { flag: 'not-qualified', 'priority-level': 'high' },
    });
    expect(result.warnings ?? []).toEqual([]);
    expect(registry.acceptsLabels('bug')).toBe(false);
    expect(registry.acceptsLabels('entity')).toBe(true);
  });

  it('resolves effective properties for an item through the registry', () => {
    expect(ids(registryWithLabels().effectiveProperties({ kind: 'requirement' }))).toEqual(['priority-level']);
  });
});
