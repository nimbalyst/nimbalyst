// @vitest-environment node
import { expect, test } from 'vitest';
import type { LabelRegistry } from '@nimbalyst/tracker-schema';
import { buildLabelIndex, effectiveLabelRegistry, recordRole } from '../ontologyLabels';
import { buildTypeMap } from '../ontologyLabelMap';
import { buildTypePageModel } from '../ontologyTypePage';
import { buildPairs, layoutTypeMap, pairStrokeWidth, placeZone, zoneRows, type Rect } from '../typeMap/typeMapLayout';
import { claim, knowledgeFixture, NOW, rec, ref } from './ontologyFixture';

const REGISTRY: LabelRegistry = {
  labels: [
    { id: 'capability', label: 'Capability', properties: ['owner-team', 'depends-on'] },
    { id: 'user-facing', label: 'User-facing', properties: ['surface'] },
    { id: 'feature', label: 'Feature', broader: ['capability', 'user-facing'], properties: ['flag', 'annual-revenue'] },
    { id: 'invariant', label: 'Invariant', properties: ['severity'] },
    { id: 'subsystem', label: 'Subsystem' },
  ],
  properties: [
    { id: 'owner-team', label: 'Owner team', type: 'string' },
    { id: 'surface', label: 'Surface', type: 'select', options: ['desktop', 'web'] },
    { id: 'flag', label: 'Flag', type: 'string', qualifiers: { since: { valueShape: 'text' } } as never },
    { id: 'severity', label: 'Severity', type: 'string' },
  ],
  claimProperties: { 'depends-on': { range: ['subsystem'] } },
};

const RECORDS = [
  rec('Sync', 'entity', { labels: ['subsystem'] }),
  rec('Search', 'entity', { labels: ['feature'], 'owner-team': 'core', surface: 'web', flag: { value: 'search-v2', qualifiers: { since: '2026-01' } }, severity: 'never shown' }),
  rec('Undo', 'entity', { labels: ['capability', 'invariant'] }),
  rec('Offline', 'entity', { labels: ['invariant'] }),
  claim('old', 'Search', 'annual-revenue', undefined, { valueText: '$1M', qualifiers: { asOf: '2025-01-01' } }),
  claim('new', 'Search', 'annual-revenue', undefined, { valueText: '$2M', qualifiers: { asOf: '2026-01-01' } }),
  claim('retracted', 'Search', 'annual-revenue', undefined, { valueText: '$9M', qualifiers: { asOf: '2026-06-01' }, status: 'withdrawn' }),
  claim('dep', 'Search', 'depends-on', 'Sync'),
];

const options = { predicateIds: ['annual-revenue', 'depends-on'], now: new Date(NOW) };

test('rows include pages under narrower labels; columns are own then ancestors, never a row\'s other labels', () => {
  const capability = buildTypePageModel(REGISTRY, 'capability', RECORDS, options);
  // Search is a feature, which is under capability; Undo also carries invariant.
  expect(capability.rows.map((row) => row.record.id)).toEqual(['Search', 'Undo']);
  expect(capability.columns.map((column) => column.id)).toEqual(['owner-team', 'depends-on']);

  const feature = buildTypePageModel(REGISTRY, 'feature', RECORDS, options);
  expect(feature.columns.map((column) => [column.id, column.storage, column.viaLabel])).toEqual([
    ['flag', 'field', 'feature'],
    ['annual-revenue', 'claim', 'feature'],
    ['owner-team', 'field', 'capability'],
    ['depends-on', 'claim', 'capability'],
    ['surface', 'field', 'user-facing'],
  ]);
  expect(feature.properties.find((property) => property.id === 'surface')).toMatchObject({ inheritedFrom: 'user-facing', options: ['desktop', 'web'] });
  expect(feature.relationsOut).toEqual([{ property: 'depends-on', name: 'depends on', from: 'capability', to: ['subsystem'] }]);
  expect(buildTypePageModel(REGISTRY, 'subsystem', RECORDS, options).relationsIn.map((relation) => relation.from)).toEqual(['capability']);
});

test('a claim cell is the latest asserted asOf and flags a stale fact; entity-valued cells name their targets', () => {
  const [search] = buildTypePageModel(REGISTRY, 'feature', RECORDS, options).rows;
  // The withdrawn claim is newer but not asserted.
  expect(search!.cells['annual-revenue']).toMatchObject({ storage: 'claim', claimId: 'new', text: '$2M', asOf: '2026-01-01', stale: true });
  expect(search!.cells['depends-on']).toMatchObject({ storage: 'claim', claimId: 'dep', text: '', targetIds: ['Sync'] });
  // A qualified field keeps its value and qualifiers apart.
  expect(search!.cells.flag).toMatchObject({ value: 'search-v2', text: 'search-v2', qualifiers: { since: '2026-01' } });
  const fresh = buildTypePageModel(REGISTRY, 'feature', [...RECORDS, claim('newest', 'Search', 'annual-revenue', undefined, { valueText: '$3M', qualifiers: { asOf: '2026-09-01' } })], options);
  expect(fresh.rows[0]!.cells['annual-revenue']).toMatchObject({ claimId: 'newest', stale: false });
});

test('with no registry the kinds stand in as labels, with their roles, and the map counts pages', () => {
  const records = knowledgeFixture();
  const registry = effectiveLabelRegistry(null, { observedKinds: ['concept'] });
  const byId = new Map(records.map((record) => [record.id, record]));
  expect(recordRole(registry, byId.get('Markets')!)).toBe('structure');
  expect(recordRole(registry, byId.get('AI IDE')!)).toBe('market-node');
  expect(recordRole(registry, byId.get('Cursor')!)).toBe('page');

  const map = buildTypeMap(buildLabelIndex(registry, records), records);
  expect(map.types.map((type) => [type.id, type.count])).toEqual([
    ['market', 3], ['product', 4], ['organization', 1], ['concept', 2],
  ]);
  expect(map.structure.map((entry) => entry.id)).toEqual(['home', 'area']);
  expect(map.relationships.filter((relationship) => relationship.status === 'declared-used').map((relationship) => [relationship.id, relationship.statements])).toEqual([
    ['in-market|product|market', 2], ['competes-with|product|product', 1], ['made-by|product|organization', 1],
  ]);
  // A registry with entries replaces the stand-in entirely.
  expect(effectiveLabelRegistry(REGISTRY)).toBe(REGISTRY);
  expect(buildLabelIndex(REGISTRY, [rec('x', 'entity', { labels: ['mystery'] }), rec('y', 'entity', {})]).undeclared).toEqual(['mystery']);
  expect(buildLabelIndex(REGISTRY, [rec('y', 'entity', { parent: ref('x') })]).unlabeled.map((record) => record.id)).toEqual(['y']);
});

// ---------------------------------------------------------------------------
// Type map: relationship statistics, zones, and the layout input
// ---------------------------------------------------------------------------

const MAP_REGISTRY: LabelRegistry = {
  labels: [
    { id: 'area', label: 'Area', role: 'structure' },
    { id: 'product', label: 'Product', properties: ['in-market', 'made-by', 'competes-with', 'website'], expects: [{ property: 'in-market', min: 1 }] },
    { id: 'market', label: 'Market' },
    { id: 'organization', label: 'Organization', properties: ['website'] },
    { id: 'capability', label: 'Capability', pluralLabel: 'Capabilities' },
    { id: 'technology', label: 'Technology', pluralLabel: 'Technologies' },
    { id: 'subsystem', label: 'Subsystem', properties: ['part-of'] },
    { id: 'feature', label: 'Feature', broader: ['capability'], properties: ['part-of'] },
    { id: 'requirement', label: 'Requirement', properties: ['part-of'] },
    { id: 'topic', label: 'Topic' },
  ],
  properties: [],
  claimProperties: {
    'in-market': { range: ['market'] },
    'made-by': { range: ['organization'] },
    'competes-with': { range: ['product', 'capability'] },
    'part-of': { range: ['subsystem'] },
  },
};

const MAP_PREDICATES = [
  { id: 'in-market', label: 'is in market', inverseLabel: 'includes', subjectKinds: ['entity'], valueShape: 'entity', direction: 'directed' },
  { id: 'competes-with', label: 'competes with', inverseLabel: 'competes with', subjectKinds: ['entity'], valueShape: 'entity', direction: 'symmetric' },
  { id: 'requires', label: 'requires', subjectKinds: ['entity'], valueShape: 'entity', direction: 'directed' },
] as never;

const MAP_RECORDS = [
  rec('Markets', 'entity', { kind: 'area' }),
  rec('M', 'entity', { labels: ['market'] }),
  rec('A', 'entity', { labels: ['product'], website: 'a.dev' }),
  rec('B', 'entity', { labels: ['product'] }),
  rec('C', 'entity', { labels: ['product'] }),
  // Two labels: its competes-with statements file under product, which declares it.
  rec('D', 'entity', { labels: ['product', 'topic'] }),
  rec('O', 'entity', { labels: ['organization'] }),
  rec('O2', 'entity', { labels: ['organization'] }),
  rec('Cap', 'entity', { labels: ['capability'] }),
  rec('T', 'entity', { labels: ['technology'] }),
  claim('m1', 'A', 'in-market', 'M', { qualifiers: { primary: true } }),
  claim('m2', 'B', 'in-market', 'M', { qualifiers: '{"primary":false}' }),
  claim('m3', 'D', 'in-market', 'M'),
  claim('k1', 'A', 'competes-with', 'B', { qualifiers: { threat: 'high' } }),
  claim('k2', 'D', 'competes-with', 'C'),
  claim('k3', 'A', 'competes-with', 'O'),
  claim('x1', 'O', 'in-market', 'M'),
  claim('x2', 'O', 'made-by', 'O2'),
  claim('old', 'A', 'made-by', 'O', { status: 'superseded' }),
  claim('r1', 'Cap', 'requires', 'T'),
  claim('r2', 'A', 'requires', 'T'),
  claim('v1', 'A', 'lifecycle', undefined, { valueText: 'active' }),
];

function mapModel() {
  return buildTypeMap(buildLabelIndex(MAP_REGISTRY, MAP_RECORDS), MAP_RECORDS, { predicates: MAP_PREDICATES });
}

test('the type map counts asserted statements per predicate and label pair and classifies them against the vocabulary', () => {
  const model = mapModel();
  const byId = new Map(model.relationships.map((relationship) => [relationship.id, relationship]));
  expect(model.relationships.map((relationship) => [relationship.id, relationship.status, relationship.statements])).toEqual([
    ['in-market|product|market', 'declared-used', 3],
    ['competes-with|product|product', 'declared-used', 2],
    ['requires|capability|technology', 'off-label', 1],
    ['in-market|organization|market', 'off-label', 1],
    ['made-by|organization|organization', 'off-label', 1],
    ['competes-with|product|organization', 'range-violation', 1],
    ['requires|product|technology', 'off-label', 1],
    // Declared and unused; the superseded made-by statement does not count.
    ['part-of|feature|subsystem', 'declared-unused', 0],
    ['competes-with|product|capability', 'declared-unused', 0],
    ['made-by|product|organization', 'declared-unused', 0],
    ['part-of|requirement|subsystem', 'declared-unused', 0],
    ['part-of|subsystem|subsystem', 'declared-unused', 0],
  ]);
  const inMarket = byId.get('in-market|product|market')!;
  expect(inMarket).toMatchObject({ verb: 'in market', inverse: 'includes', subjects: 3, objects: 1, topTargets: [{ id: 'M', count: 3 }] });
  expect(inMarket.expectation).toMatchObject({ min: 1, met: 3, total: 4, missing: [{ id: 'C', title: 'C' }] });
  const competes = byId.get('competes-with|product|product')!;
  expect(competes).toMatchObject({ symmetric: true, subjects: 2, objects: 2 });
  expect(competes.list.map((statement) => [statement.subjectTitle, statement.objectTitle, statement.detail])).toEqual([['A', 'B', 'high'], ['D', 'C', '']]);
  expect(byId.get('competes-with|product|organization')!.range).toEqual(['product', 'capability']);
  // Structure labels stay off the map; property coverage counts fields and value claims alike.
  expect(model.types.some((type) => type.id === 'area')).toBe(false);
  expect(model.types.find((type) => type.id === 'product')!.properties).toEqual([
    { id: 'in-market', name: 'in market', filled: 3 },
    { id: 'made-by', name: 'made by', filled: 0 },
    { id: 'competes-with', name: 'competes with', filled: 2 },
    { id: 'website', name: 'website', filled: 1 },
  ]);
  expect(model.types.find((type) => type.id === 'feature')).toMatchObject({ broader: ['Capability'], count: 0 });
});

test('zones follow declared relationships, pull loose labels in by broader and by usage, and pool small groups', () => {
  const model = mapModel();
  // Technology declares nothing but is used from capability and product; topic is linked to nothing.
  expect(model.zones.map((zone) => [zone.id, zone.name, zone.typeIds])).toEqual([
    ['product', 'Products and related types', ['product', 'market', 'organization', 'capability', 'technology']],
    ['subsystem', 'Subsystems and related types', ['subsystem', 'feature', 'requirement']],
    ['~other', 'Other types', ['topic']],
  ]);
  expect(model.types.find((type) => type.id === 'feature')!.zone).toBe('subsystem');
});

test('the layout draws one line per pair, puts each zone\'s hub in the middle, packs zones to the canvas, and keeps pills clear', () => {
  const model = mapModel();
  const pairs = buildPairs(model.relationships);
  const byId = new Map(pairs.map((pair) => [pair.id, pair]));
  // Both directions between two types share one line, drawn in the busier direction.
  expect(byId.get('capability~technology')).toMatchObject({ from: 'capability', to: 'technology', style: 'off-label', both: false });
  expect(byId.get('organization~product')).toMatchObject({ style: 'violation', statements: 1 });
  expect(byId.get('product~self')).toMatchObject({ from: 'product', to: 'product', statements: 2, style: 'used' });
  expect(buildPairs([...model.relationships, { ...model.relationships[2]!, id: 'x|technology|capability', from: 'technology', to: 'capability', statements: 0 }]).find((pair) => pair.id === 'capability~technology')!.both).toBe(true);
  // Only declared-and-used lines and violations grow with their statements.
  expect(pairStrokeWidth({ style: 'off-label', statements: 40 })).toBeLessThan(pairStrokeWidth({ style: 'used', statements: 2 }));

  // A star: the hub takes the middle cell and every spoke sits next to it.
  const star = ['hub', 'a', 'b', 'c', 'd', 'e', 'f'];
  const spokes = buildPairs(star.slice(1).map((id) => ({ ...model.relationships[0]!, id: `p|${id}|hub`, from: id, to: 'hub' })));
  const cells = placeZone(star, spokes, new Map());
  expect(cells.get('hub')).toEqual([0, 0]);
  for (const id of star.slice(1)) expect(Math.max(...cells.get(id)!.map(Math.abs))).toBe(1);

  // Zones pack for the canvas's shape: side by side on a wide canvas, stacked on a tall one.
  const sizes = [{ id: 'a', w: 900, h: 400 }, { id: 'b', w: 800, h: 380 }, { id: 'c', w: 400, h: 300 }];
  expect(zoneRows(sizes, 5)).toEqual([['a', 'b', 'c']]);
  expect(zoneRows(sizes, 1.5)).toEqual([['a'], ['b', 'c']]);
  expect(zoneRows(sizes, 0.6)).toEqual([['a'], ['b'], ['c']]);

  // No pill sits on a type box, on the space a box grows into when zoomed in, or on another pill.
  const layout = layoutTypeMap({ types: model.types, zones: model.zones, pairs, aspect: 1.5 });
  const overlap = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  const reserved = [...layout.reserved.values()];
  expect(layout.pills).toHaveLength(model.relationships.length);
  for (const [i, pill] of layout.pills.entries()) {
    expect(reserved.filter((box) => overlap(pill, box)), pill.relationshipId).toEqual([]);
    expect(layout.pills.slice(i + 1).filter((other) => overlap(pill, other)).map((other) => other.relationshipId), pill.relationshipId).toEqual([]);
  }
  const boxes = [...layout.reserved.entries()];
  for (const [i, [id, box]] of boxes.entries()) {
    expect(boxes.slice(i + 1).filter(([, other]) => overlap(box, other)).map(([other]) => other), id).toEqual([]);
  }
});
