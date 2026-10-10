/**
 * The knowledge graph read through its labels: which labels each page carries,
 * which pages each label holds (a label's members include every page under a
 * narrower label), and what role a page plays in the wiki. The type map is
 * `ontologyLabelMap.ts`.
 *
 * A project that has not seeded `labels.yaml` yet still has `entity.kind`, so
 * {@link effectiveLabelRegistry} stands in a built-in registry built from the
 * kind options: `area` and `home` are structure, `market` is a market node,
 * and `product` and `organization` carry the fact boxes and expectations the
 * wiki hard-coded before labels. Once the room publishes a registry, only the
 * registry is read.
 *
 * Pure: the wiki, the type pages and the health checks all read one index.
 */
import {
  isLabelRegistryEmpty,
  itemOwnLabels,
  labelAncestors,
  resolveLabels,
  type LabelDefinition,
  type LabelRegistry,
  type LabelRole,
} from '@nimbalyst/tracker-schema';
import { byTitle, type OntologyRecordLike } from './ontologyRecords';

/** The tracker type whose items carry labels. */
export const LABELED_TYPE = 'entity';

export const ORGANIZATION_FACT_IDS = ['annual-revenue', 'funding-total', 'headcount', 'valuation', 'last-round', 'founded', 'hq'] as const;
export const PRODUCT_FACT_IDS = ['lifecycle', 'pricing', 'license', 'platforms', 'launched', 'users'] as const;

/**
 * What the wiki did for each kind before labels, as label metadata. Used only
 * while the room has no registry; the market pack carries the same entries.
 */
const BUILT_IN_LABELS: readonly LabelDefinition[] = [
  { id: 'home', label: 'Home', pluralLabel: 'Home', icon: 'home', role: 'structure' },
  { id: 'area', label: 'Area', pluralLabel: 'Areas', icon: 'folder', role: 'structure' },
  { id: 'market', label: 'Market', pluralLabel: 'Markets', icon: 'storefront', role: 'market-node', factBox: [...ORGANIZATION_FACT_IDS, ...PRODUCT_FACT_IDS] },
  {
    id: 'product',
    label: 'Product',
    pluralLabel: 'Products',
    icon: 'inventory_2',
    role: 'page',
    properties: ['website', 'in-market', 'made-by', 'competes-with', ...PRODUCT_FACT_IDS],
    expects: [{ property: 'in-market', min: 1 }, { property: 'made-by', min: 1 }],
    factBox: [...PRODUCT_FACT_IDS],
  },
  {
    id: 'organization',
    label: 'Organization',
    pluralLabel: 'Organizations',
    icon: 'apartment',
    role: 'page',
    properties: ['website', ...ORGANIZATION_FACT_IDS],
    factBox: [...ORGANIZATION_FACT_IDS],
  },
];

const BUILT_IN_CLAIM_PROPERTIES: LabelRegistry['claimProperties'] = {
  'in-market': { range: ['market'], facet: true },
  'made-by': { range: ['organization', 'person'], facet: true },
  'competes-with': { range: ['product', 'capability'] },
  lifecycle: { options: ['active', 'declining', 'unmaintained', 'defunct'], facet: true },
};

export interface KindOption {
  value: string;
  label?: string;
}

/**
 * The registry the wiki reads: the room's, or while that is empty, the
 * built-in one plus a plain label for every other kind the schema offers or a
 * page uses.
 */
export function effectiveLabelRegistry(
  registry: LabelRegistry | null | undefined,
  fallback: { kindOptions?: readonly KindOption[]; observedKinds?: Iterable<string> } = {},
): LabelRegistry {
  if (registry && !isLabelRegistryEmpty(registry)) return registry;
  const labels = BUILT_IN_LABELS.map((label) => ({ ...label }));
  const known = new Set(labels.map((label) => label.id));
  const add = (value: string, label?: string) => {
    if (!value || known.has(value)) return;
    known.add(value);
    labels.push({ id: value, label: label || value.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase()), role: 'page' });
  };
  for (const option of fallback.kindOptions ?? []) add(option.value, option.label);
  for (const kind of fallback.observedKinds ?? []) add(kind);
  return { labels, properties: [], claimProperties: { ...BUILT_IN_CLAIM_PROPERTIES } };
}

/** Whether `effectiveLabelRegistry` is standing in for a missing registry. */
export function isFallbackRegistry(registry: LabelRegistry | null | undefined): boolean {
  return !registry || isLabelRegistryEmpty(registry);
}

export function labelById(registry: LabelRegistry): Map<string, LabelDefinition> {
  return new Map(registry.labels.map((label) => [label.id, label]));
}

/** "Products" for `product`; the id, humanized, for a label nobody declared. */
export function labelName(registry: LabelRegistry, id: string, plural = false): string {
  const label = registry.labels.find((entry) => entry.id === id);
  if (!label) return id.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());
  return plural ? label.pluralLabel ?? `${label.label}s` : label.label;
}

/** A labeled record's own labels (its `labels` and legacy `kind`); none for other types. */
export function recordOwnLabels(record: OntologyRecordLike): string[] {
  return record.primaryType === LABELED_TYPE ? itemOwnLabels(record.fields) : [];
}

export function recordEffectiveLabels(registry: LabelRegistry, record: OntologyRecordLike): string[] {
  return record.primaryType === LABELED_TYPE ? resolveLabels(registry, record.fields) : [];
}

/**
 * The role a page plays: `structure` (areas, home) when any of its labels is
 * structure, else `market-node`, else `page`. Roles come from the page's own
 * labels first and are inherited from broader labels when unset.
 */
export function recordRole(registry: LabelRegistry, record: OntologyRecordLike): LabelRole | null {
  if (record.primaryType !== LABELED_TYPE) return null;
  const byId = labelById(registry);
  const roles = recordEffectiveLabels(registry, record).map((id) => byId.get(id)?.role);
  if (roles.includes('structure')) return 'structure';
  if (roles.includes('market-node')) return 'market-node';
  return 'page';
}

export function hasRole(registry: LabelRegistry, record: OntologyRecordLike, role: LabelRole): boolean {
  return recordRole(registry, record) === role;
}

/** The wiki's home page carries the `home` label. */
export function isHomePage(record: OntologyRecordLike): boolean {
  return recordOwnLabels(record).includes('home');
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

export interface LabelIndex<T extends OntologyRecordLike = OntologyRecordLike> {
  registry: LabelRegistry;
  labels: ReadonlyMap<string, LabelDefinition>;
  /** Live labeled records' own labels, by record id. */
  own: ReadonlyMap<string, string[]>;
  /** Own labels closed under `broader`, by record id. */
  effective: ReadonlyMap<string, string[]>;
  /** Live records whose effective labels include the label: its own pages and every narrower label's. */
  members: ReadonlyMap<string, T[]>;
  /** Pages carrying the label itself (not only a narrower one). */
  direct: ReadonlyMap<string, T[]>;
  /** Live labeled records with no label at all. */
  unlabeled: T[];
  /** Labels pages carry that the registry does not declare. */
  undeclared: string[];
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

export function buildLabelIndex<T extends OntologyRecordLike>(registry: LabelRegistry, records: readonly T[]): LabelIndex<T> {
  const labels = labelById(registry);
  const own = new Map<string, string[]>();
  const effective = new Map<string, string[]>();
  const members = new Map<string, T[]>();
  const direct = new Map<string, T[]>();
  const unlabeled: T[] = [];
  const undeclared = new Set<string>();
  for (const record of records) {
    if (record.archived || record.primaryType !== LABELED_TYPE) continue;
    const mine = recordOwnLabels(record);
    const all = resolveLabels(registry, record.fields);
    own.set(record.id, mine);
    effective.set(record.id, all);
    if (mine.length === 0) unlabeled.push(record);
    for (const id of mine) {
      push(direct, id, record);
      if (!labels.has(id)) undeclared.add(id);
    }
    for (const id of all) push(members, id, record);
  }
  for (const list of members.values()) list.sort(byTitle);
  return { registry, labels, own, effective, members, direct, unlabeled: unlabeled.sort(byTitle), undeclared: [...undeclared].sort() };
}

/** Label ids an entity-valued property's targets should carry; empty when it declares none. */
export function propertyRange(registry: LabelRegistry, propertyId: string): string[] {
  const field = registry.properties.find((property) => property.id === propertyId);
  if (field) return field.type === 'relationship' ? field.range ?? [] : [];
  return registry.claimProperties[propertyId]?.range ?? [];
}

/** Labels directly under `labelId`. */
export function narrowerLabels(registry: LabelRegistry, labelId: string): string[] {
  return registry.labels.filter((label) => label.broader?.includes(labelId)).map((label) => label.id);
}

export { labelAncestors };
