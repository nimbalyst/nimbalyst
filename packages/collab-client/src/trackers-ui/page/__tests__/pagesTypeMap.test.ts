// @vitest-environment node
/**
 * The Types map's model: relations come from relationship fields between the
 * section's types (counted from their values) and from page-link predicates
 * that name both kinds; related types share a zone.
 */
import { describe, expect, it } from 'vitest';
import type { PredicateDefinition, TrackerDataModel } from '@nimbalyst/tracker-schema';
import { buildPagesTypeMap, buildPagesTypeTable } from '../pagesTypeMap';

function model(type: string, fields: TrackerDataModel['fields'] = [], extra: Partial<TrackerDataModel> = {}): TrackerDataModel {
  return {
    type, displayName: type, displayNamePlural: `${type}s`, icon: 'article', color: '#888',
    modes: { inline: false, fullDocument: true }, idPrefix: type, idFormat: 'ulid', fields, ...extra,
  } as TrackerDataModel;
}

const types = [
  model('module', [
    { name: 'title', type: 'string' },
    { name: 'dependsOn', type: 'relationship', multiValue: true, targetTrackerTypes: ['module', 'library'] },
    { name: 'owner', type: 'relationship', targetTrackerTypes: ['person', 'elsewhere'] },
  ]),
  model('library'),
  model('person'),
  model('vendorLibrary', [], { extends: 'library' }),
  model('note'),
];
const items = [
  { id: 'm1', primaryType: 'module', fields: { title: 'Sync', dependsOn: [{ itemId: 'm2' }, { itemId: 'l1' }, { itemId: 'gone' }] } },
  { id: 'm2', primaryType: 'module', fields: { title: 'Store', dependsOn: [{ itemId: 'l1' }] } },
  { id: 'l1', primaryType: 'library', fields: { title: 'SQLite' } },
  { id: 'm3', primaryType: 'module', archived: true, fields: { title: 'Old', dependsOn: [{ itemId: 'l1' }] } },
];
const predicates: PredicateDefinition[] = [
  { id: 'competes-with', label: 'competes with', subjectKinds: ['library'], objectKinds: ['library'], valueShape: 'entity', direction: 'symmetric' },
  { id: 'mentions', label: 'mentions', subjectKinds: ['*'], valueShape: 'entity', direction: 'directed' },
];

describe('pages type map', () => {
  const map = buildPagesTypeMap({ types, items, predicates, itemTitle: (item) => String(item.fields.title) });
  const relation = (id: string) => map.relationships.find((entry) => entry.id === id);

  it('draws a line per relationship field target in the section, counted from live values', () => {
    expect(relation('dependsOn|module|library')).toMatchObject({ statements: 2, subjects: 2, objects: 1, status: 'declared-used', topTargets: [{ id: 'l1', title: 'SQLite', count: 2 }] });
    expect(relation('dependsOn|module|module')).toMatchObject({ statements: 1, list: [{ subjectTitle: 'Sync', objectTitle: 'Store' }] });
    expect(relation('owner|module|person')).toMatchObject({ statements: 0, status: 'declared-unused' });
    expect(map.relationships.some((entry) => entry.to === 'elsewhere')).toBe(false);
    expect(map.types.find((type) => type.id === 'module')).toMatchObject({ count: 2, properties: [{ id: 'dependsOn', filled: 2 }, { id: 'owner', filled: 0 }] });
  });

  it('adds page-link predicates that name both kinds, through extends, and skips any-kind ones', () => {
    expect(relation('competes-with|vendorLibrary|library')).toMatchObject({ symmetric: true, statements: 0 });
    expect(map.relationships.some((entry) => entry.predicate === 'mentions')).toBe(false);
  });

  it('groups related types into a zone and pools the rest', () => {
    const zoneOf = new Map(map.types.map((type) => [type.id, type.zone]));
    // The hub is the type with the most relations: library (module, and vendorLibrary both ways).
    expect(['module', 'library', 'person', 'vendorLibrary'].map((id) => zoneOf.get(id))).toEqual(['library', 'library', 'library', 'library']);
    expect(map.zones[0]).toMatchObject({ id: 'library', name: 'librarys and related types' });
    expect(zoneOf.get('note')).toBe('~other');
  });
});

describe('pages types table', () => {
  it('lists every type with what it extends, its live pages, field and relation counts, and whether it is placed', () => {
    const rows = buildPagesTypeTable({ types, items, placedTypeIds: new Set(['module', 'gone']) });
    expect(rows.map((row) => row.id)).toEqual(['library', 'module', 'note', 'person', 'vendorLibrary']);
    expect(rows.find((row) => row.id === 'module')).toEqual({
      id: 'module', name: 'module', extendsName: null, pages: 2, fields: 0, relations: 2, placed: true,
    });
    expect(rows.find((row) => row.id === 'vendorLibrary')).toMatchObject({ extendsName: 'library', pages: 0, placed: false });
  });
});
