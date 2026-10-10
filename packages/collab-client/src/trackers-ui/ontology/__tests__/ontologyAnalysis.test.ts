// @vitest-environment node
import { expect, test } from 'vitest';
import type { FieldDefinition, PredicateDefinition, TrackerDataModel } from '@nimbalyst/tracker-schema';
import { analyzeOntology } from '../ontologyAnalysis';
import { factStaleAt, type MarketNode } from '../ontologyKnowledge';
import { computeContentHealth } from '../ontologyContentHealth';
import yaml from 'js-yaml';
import coreLabelsYaml from './fixtures/core-labels.yaml?raw';
import marketLabelsYaml from './fixtures/market-labels.yaml?raw';
import type { LabelDefinition, LabelRegistry } from '@nimbalyst/tracker-schema';
import { buildDomainModel } from '../ontologyDomain';
import { proposalRequestFor } from '../ontologyProposals';
import { domainFixture, knowledgeFixture, NOW, rec, claim } from './ontologyFixture';

function model(type: string, fields: Array<Partial<FieldDefinition> & { name: string }>, extra: Partial<TrackerDataModel> = {}): TrackerDataModel {
  return {
    type, displayName: type[0]!.toUpperCase() + type.slice(1), displayNamePlural: `${type}s`, icon: 'category', color: '#000',
    modes: { inline: true, fullDocument: true }, idPrefix: type.slice(0, 3), idFormat: 'ulid',
    fields: fields.map((field) => ({ type: 'string', ...field }) as FieldDefinition),
    roles: { title: 'title', workflowStatus: 'status' },
    ...extra,
  } as TrackerDataModel;
}

const TYPES: TrackerDataModel[] = [
  model('entity', [
    { name: 'title' }, { name: 'status', type: 'select' },
    { name: 'kind', type: 'select', options: ['product', 'market', 'organization', 'concept', 'area', 'topic'].map((value) => ({ value, label: value[0]!.toUpperCase() + value.slice(1) })) },
    { name: 'parent', type: 'relationship', targetTrackerTypes: ['entity'] },
    { name: 'aliases', type: 'array' }, { name: 'summary', type: 'text' }, { name: 'website' }, { name: 'threat', type: 'select' },
    { name: 'reviewState', type: 'select', default: 'unreviewed' }, { name: 'created', type: 'datetime', readOnly: true },
  ], { sharing: 'team' }),
  model('claim', [
    { name: 'title' }, { name: 'subject', type: 'relationship', targetTrackerTypes: ['entity'] },
    { name: 'object', type: 'relationship', targetTrackerTypes: ['entity'] }, { name: 'predicate', type: 'predicate-ref' as FieldDefinition['type'] },
    { name: 'citations', type: 'citation', multiValue: true },
  ], { sharing: 'team' }),
  model('competitor', [{ name: 'title' }, { name: 'category', type: 'select' }]),
  model('bug', [{ name: 'title' }, { name: 'severity', type: 'select' }, { name: 'blocks', type: 'relationship', targetTrackerTypes: ['bug'], multiValue: true }]),
];
const PREDICATES = ['in-market', 'made-by', 'competes-with', 'inspired-by', 'annual-revenue', 'headcount', 'pricing', 'lifecycle']
  .map((id) => ({ id, label: id.replace(/-/g, ' '), subjectKinds: ['entity'], valueShape: 'entity', direction: 'directed' }) as PredicateDefinition);

const records = () => [
  ...knowledgeFixture(),
  rec('B1', 'bug', { severity: 'high', blocks: [{ itemId: 'B2' }, { itemId: 'gone-bug' }] }),
  rec('B2', 'bug', {}),
  rec('B3', 'bug', {}),
];

test('every tracker type gets counts, fill rates and relationship edges; kinds split the type that has them', () => {
  const view = analyzeOntology({ types: TYPES, predicates: PREDICATES, records: records(), now: NOW });
  expect(view.types.map((type) => [type.type, type.count, type.archived])).toEqual([
    ['claim', 11, 0], ['entity', 11, 1], ['bug', 3, 0], ['competitor', 1, 1],
  ]);
  const bug = view.types.find((type) => type.type === 'bug')!;
  expect(bug.fields.map((field) => [field.name, field.filled])).toEqual([['blocks', 1], ['severity', 1]]);
  expect(bug.kinds).toBeNull();

  const entity = view.types.find((type) => type.type === 'entity')!;
  expect(entity.kinds!.map((kind) => [kind.kind, kind.count])).toEqual([
    ['product', 4], ['market', 3], ['concept', 2], ['area', 1], ['organization', 1], ['topic', 0],
  ]);
  expect(entity.kinds!.find((kind) => kind.kind === 'product')!.fields.map((field) => [field.name, field.filled, field.deprecated])).toEqual([
    ['summary', 4, false], ['aliases', 1, false], ['threat', 1, true], ['website', 1, false],
  ]);

  // Links to an archived competitor land on its type; an id nobody has is `missing`.
  const edges = new Map(view.relationships.edges.map((edge) => [edge.id, edge]));
  expect(edges.get('claim.object')!.observedTargets).toEqual([{ type: 'entity', count: 4 }, { type: 'competitor', count: 1 }]);
  expect(edges.get('bug.blocks')).toMatchObject({ links: 2, itemsWithLinks: 1, multi: true, observedTargets: [{ type: 'bug', count: 1 }, { type: 'missing', count: 1 }] });
  expect(view.relationships.nodes.map((node) => node.type)).toEqual(['bug', 'claim', 'competitor', 'entity']);

  expect(view.predicates!.used.find((predicate) => predicate.id === 'in-market')).toMatchObject({
    count: 2, declared: true, subjectKinds: [{ kind: 'product', count: 2 }], objectKinds: [{ kind: 'market', count: 2 }],
  });
  expect(view.predicates!.unused.map((predicate) => predicate.id)).toEqual(['inspired-by']);

  const shape = (nodes: readonly MarketNode[]): unknown[] => nodes.map((node) => ({ [`${node.record.id}:${node.direct.length}/${node.total}`]: shape(node.children) }));
  expect(shape(view.knowledge!.markets)).toEqual([{ 'AI software development:0/2': [{ 'AI IDE:2/2': [] }] }, { 'Team wiki:0/0': [] }]);
  expect(view.knowledge!.facts).toMatchObject({ total: 5, current: 2, stale: 2, undated: 1 });

  const health = new Map(view.health.map((item) => [item.id, item.items.map((entry) => entry.id)]));
  expect([...health.keys()]).toEqual([
    // Claims are the most common type, so their fields come first; few claims cite a source.
    'sparse-field:claim:citations',
    'catch-all-kind:concept',
    'deprecated-field:entity:product:threat',
    'sparse-field:entity:product:website',
    'broken-links',
    'undeclared-predicates',
    'stale-facts',
    // No label registry: the kind stand-in's product label expects a market and a maker.
    'unmet-expects:product:in-market',
    'unmet-expects:product:made-by',
    'duplicates',
  ]);
  expect(health.get('broken-links')).toEqual(['B1']);
  expect(health.get('undeclared-predicates')).toEqual(['c10']);
});

test('with no predicate registry (web: the room does not publish one) predicates are keyed off claim ids', () => {
  const view = analyzeOntology({ types: TYPES, predicates: null, records: records(), now: NOW });
  expect(view.predicates).toMatchObject({ registryAvailable: false, unused: [] });
  expect(view.predicates!.used.find((predicate) => predicate.id === 'mentioned-in')).toMatchObject({ label: 'mentioned-in', declared: null, count: 1 });
  // Nothing can be undeclared without a registry, so that check is skipped rather than flagging every claim.
  expect(view.health.map((item) => item.id)).not.toContain('undeclared-predicates');
});

test('without the knowledge types there is no knowledge section and no content health', () => {
  const view = analyzeOntology({ types: TYPES.filter((type) => type.type === 'bug'), predicates: [], records: records().filter((record) => record.primaryType === 'bug'), now: NOW });
  expect(view.knowledge).toBeNull();
  expect(view.predicates).toBeNull();
  expect(view.health.map((item) => item.id)).toEqual(['broken-links']);
});

test('a month or year fact goes stale 90 days after the end of its period; content health names the pages', () => {
  // Mar 2025 at month precision: Mar 31 + 90 days.
  expect(new Date(factStaleAt('2025-03-01', 'month')!).toISOString().slice(0, 10)).toBe('2025-06-29');
  expect(new Date(factStaleAt('2025-01-01', 'year')!).toISOString().slice(0, 10)).toBe('2026-03-31');
  expect(new Date(factStaleAt('2025-03-01', 'day')!).toISOString().slice(0, 10)).toBe('2025-05-30');

  const health = computeContentHealth(knowledgeFixture(), { now: NOW });
  // Each bucket carries its item ids, which is what the wiki search filters on.
  expect(health.map((item) => [item.id, item.count, item.itemIds])).toEqual([
    // Anysphere revenue (day, Mar 2026) is stale; its headcount (month, Jun 2026) is not; Zed's pricing is undated.
    ['stale-facts', 3, ['Anysphere', 'Cursor', 'Zed']],
    ['unmet-expects:product:in-market', 2, ['Nimbalyst', 'Notion']],
    ['unmet-expects:product:made-by', 3, ['Nimbalyst', 'Notion', 'Zed']],
    // The live competitor item repeats Notion; the archived one does not count.
    ['duplicates', 1, ['Notion', 'NIM-1374']],
  ]);
  expect(health.find((item) => item.id === 'duplicates')!.groupIds).toEqual([['Notion', 'NIM-1374']]);
  // Once a newer, current value is asserted it replaces the stale one.
  const refreshed = computeContentHealth([...knowledgeFixture(), claim('c11', 'Anysphere', 'annual-revenue', undefined, { valueText: '$1B', qualifiers: { asOf: '2026-09-01' } })], { now: NOW });
  expect(refreshed[0]!.items.map((entry) => entry.id)).toEqual(['Cursor', 'Zed']);
});

const statusField = { name: 'status', type: 'select' as const, options: [{ value: 'to-do', label: 'To do', category: 'unstarted' as const }, { value: 'done', label: 'Done', category: 'done' as const }] };
const DOMAIN_TYPES: TrackerDataModel[] = [
  ...TYPES.filter((type) => type.type !== 'bug'),
  model('feature-module', [{ name: 'title' }, { name: 'bugs', type: 'relationship', targetTrackerTypes: ['bug'], multiValue: true, relationshipTypeKey: 'parent-of', inverseFieldId: 'area' }], { displayNamePlural: 'Feature Modules' }),
  model('bug', [{ name: 'title' }, statusField, { name: 'area', type: 'relationship', targetTrackerTypes: ['feature-module'], multiValue: true, relationshipTypeKey: 'child-of', inverseFieldId: 'bugs' }]),
  model('decision', [{ name: 'title' }, { name: 'area', type: 'relationship', targetTrackerTypes: ['feature-module'], multiValue: true, relationshipTypeKey: 'child-of' }]),
  model('customer', [{ name: 'title' }, { name: 'users', type: 'relationship', targetTrackerTypes: ['user'], multiValue: true, relationshipTypeKey: 'parent-of', inverseFieldId: 'company' }]),
  model('user', [{ name: 'title' }, { name: 'company', type: 'relationship', targetTrackerTypes: ['customer'], relationshipTypeKey: 'child-of', inverseFieldId: 'users' }]),
  model('task', [{ name: 'title' }]),
];

test('the domain model reads categories and roles, not types: a competitor is whatever competes with us', () => {
  const view = buildDomainModel({ types: DOMAIN_TYPES, predicates: null, records: domainFixture(), now: NOW });
  expect(view.us?.id).toBe('Nimbalyst');
  expect(view.summary.map((part) => part.text).join('')).toBe(
    'Your team tracks 2 competitors across 3 markets and the 1 company behind them; what Nimbalyst can do, as 1 capability on 2 technologies and 2 product areas; who uses it, as 3 customers and 2 people; and the work: 3 open bugs, 4 decisions.',
  );
  expect(view.groups.map((group) => [group.id, group.categoryIds])).toEqual([
    ['market', ['competitors', 'markets', 'organizations']],
    ['product', ['us', 'capabilities', 'technologies', 'areas']],
    ['customers', ['customers', 'people', 'personas']],
    ['work', ['bugs', 'decisions']],
  ]);
  // Notion has pages but competes with nobody, so it is not a competitor; tasks have no card.
  expect(view.also.map((chip) => `${chip.name} ${chip.count}`)).toEqual(['Competitor tracker items 1', 'Other products 1', 'tasks 1']);

  const lines = new Map(view.categories.flatMap((category) => category.lines).map((line) => [line.id, [line.have, line.total, line.state]]));
  expect(lines.get('competitors:in-market')).toEqual([2, 2, 'full']);
  // Zed's only made-by statement is withdrawn.
  expect(lines.get('competitors:made-by')).toEqual([1, 2, 'low']);
  expect(lines.get('competitors:capabilities')).toEqual([0, 2, 'untracked']);
  // A parent market holds its products through its submarket; Team wiki holds none.
  expect(lines.get('markets:include')).toEqual([2, 3, 'partial']);
  // An inverse pair counts a link written from either end: B1 is only on A1.bugs.
  expect(lines.get('bugs:area')).toEqual([2, 4, 'low']);
  expect(lines.get('areas:bugs')).toEqual([2, 2, 'full']);
  expect(lines.get('people:company')).toEqual([2, 2, 'full']);

  const bugs = view.categories.find((category) => category.id === 'bugs')!;
  expect([bugs.count, bugs.countLabel, bugs.total, bugs.role, bugs.example]).toEqual([3, 'open', 4, '4 in all, 3 open', '3 to do']);
  const competitors = view.categories.find((category) => category.id === 'competitors')!;
  expect(competitors.table.rows.map((row) => row.cells.map((cell) => cell.tone ? `${cell.text}!` : cell.text))).toEqual([
    ['Cursor', 'AI IDE', 'high', 'Anysphere'],
    ['Zed', 'AI IDE', 'not rated!', 'unknown!'],
  ]);
  expect(view.categories.find((category) => category.id === 'personas')).toMatchObject({ ghost: true, count: 0 });
});

test('gaps are phrased in the domain, sit with their category, and each can become a proposal request', () => {
  const view = buildDomainModel({ types: DOMAIN_TYPES, predicates: null, records: domainFixture(), now: NOW });
  expect(view.gaps.map((gap) => [gap.id, gap.tone, gap.title])).toEqual([
    ['stale-facts', 'gap', '2 facts are more than 90 days old'],
    ['line:competitors:made-by', 'gap', '1 competitor has no known maker'],
    ['line:competitors:threat', 'gap', '1 competitor has no threat level'],
    ['line:competitors:lifecycle', 'gap', '1 competitor has no recorded status'],
    ['duplicates', 'gap', '1 thing is recorded twice'],
    ['competitor-capabilities', 'opportunity', 'No record of which competitors have which capabilities'],
    ['link-capabilities-areas', 'opportunity', "Capabilities and product areas aren't linked"],
    ['track-personas', 'opportunity', "You don't track personas yet"],
    // 1 of 4 is under a third; bugs at 2 of 4 are not a gap.
    ['line:decisions:area', 'gap', 'Few decisions say which product areas they are about'],
    ['catch-all-kind:concept', 'gap', '2 knowledge pages have no real category'],
  ]);
  const maker = view.gaps.find((gap) => gap.id === 'line:competitors:made-by')!;
  expect([maker.detail, maker.itemIds]).toEqual(['Zed.', ['Zed']]);
  expect(view.categories.find((category) => category.id === 'competitors')!.lines.find((line) => line.id === 'competitors:made-by')!.gapId).toBe(maker.id);
  expect(proposalRequestFor(maker)).toMatchObject({ title: 'Improve: 1 competitor has no known maker', healthCheck: 'line:competitors:made-by' });

  // One edge per link: the inverse end and the object end of a claim draw nothing.
  expect(view.edges.map((edge) => `${edge.from}>${edge.to}:${edge.state}`)).toEqual([
    'us>competitors:recorded', 'competitors>markets:recorded', 'competitors>organizations:recorded', 'competitors>capabilities:missing',
    'capabilities>us:recorded', 'capabilities>technologies:recorded', 'capabilities>areas:missing',
    'customers>personas:missing', 'people>customers:recorded', 'people>personas:missing',
    'bugs>areas:recorded', 'decisions>areas:weak',
  ]);
});

test('label health: expectations come from label data, ranges and cycles are reported, nothing is hard-coded to products', () => {
  const labels = {
    labels: [
      { id: 'area', label: 'Area', role: 'structure' as const },
      { id: 'market', label: 'Market', role: 'market-node' as const },
      { id: 'organization', label: 'Organization' },
      // No expectations on product any more: the old missing-market report must not appear.
      { id: 'product', label: 'Product', properties: ['in-market', 'made-by'] },
      { id: 'feature', label: 'Feature', properties: ['owner'], expects: [{ property: 'part-of', min: 1 }, { property: 'owner', min: 1 }] },
      { id: 'loop-a', label: 'Loop A', broader: ['loop-b'] },
      { id: 'loop-b', label: 'Loop B', broader: ['loop-a'] },
    ],
    properties: [{ id: 'owner', label: 'Owner', type: 'string' as const }],
    claimProperties: { 'in-market': { range: ['market'] }, 'part-of': { range: ['feature'] } },
  };
  const records = [
    ...knowledgeFixture(),
    rec('Search', 'entity', { labels: ['feature'], owner: 'core' }),
    rec('Undo', 'entity', { labels: ['feature'] }),
    claim('p1', 'Search', 'part-of', 'Undo'),
    // A product placed in an organization, not a market.
    claim('bad', 'Zed', 'in-market', 'Anysphere'),
  ];
  const content = computeContentHealth(records, { now: NOW, labels });
  // No label puts a fact in a fact box, so no fact can be stale; `concept` is no longer declared.
  expect(content.map((item) => [item.id, item.itemIds])).toEqual([
    ['unmet-expects:feature:part-of', ['Undo']],
    ['unmet-expects:feature:owner', ['Undo']],
    ['range-violation:in-market', ['bad']],
    ['unknown-label:concept', ['Blog strategy', 'Pricing']],
    ['duplicates', ['Notion', 'NIM-1374']],
  ]);
  expect(content.find((item) => item.id === 'range-violation:in-market')!.labelIds).toEqual(['product', 'market']);

  const view = analyzeOntology({ types: TYPES, predicates: PREDICATES, labels, records, now: NOW });
  const ids = view.health.map((item) => item.id);
  expect(ids).toContain('label-cycle:loop-a+loop-b');
  expect(ids).toContain('off-label-claim:headcount');
  expect(ids).not.toContain('unmet-expects:product:in-market');
});

test('the core and market packs, as data, reproduce the kind stand-in\'s product reports and keep competes-with off', () => {
  const [core, market] = [coreLabelsYaml, marketLabelsYaml].map((text) => yaml.load(text) as Partial<LabelRegistry>);
  // wiki setup unions a re-declared label's properties, factBox and expects; the market pack's organization is a superset.
  const marketIds = new Set((market.labels ?? []).map((label: LabelDefinition) => label.id));
  const labels: LabelRegistry = {
    labels: [...(core.labels ?? []).filter((label) => !marketIds.has(label.id)), ...(market.labels ?? [])],
    properties: [...(core.properties ?? []), ...(market.properties ?? [])],
    claimProperties: { ...core.claimProperties, ...market.claimProperties },
  };
  const packed = computeContentHealth(knowledgeFixture(), { now: NOW, labels }).map((item) => [item.id, item.itemIds]);
  const standIn = computeContentHealth(knowledgeFixture(), { now: NOW }).map((item) => [item.id, item.itemIds]);
  expect(packed.filter(([id]) => String(id).startsWith('unmet-expects:'))).toEqual(standIn.filter(([id]) => String(id).startsWith('unmet-expects:')));
  expect(packed.map(([id]) => id)).not.toContain('unmet-expects:product:competes-with');
  expect(packed.find(([id]) => id === 'stale-facts')).toEqual(standIn.find(([id]) => id === 'stale-facts'));
});
