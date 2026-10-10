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
import { labelAncestors, type LabelDefinition, type LabelRegistry, type LabelRole } from '../../../../tracker-schema/src/browser';
import { type OntologyRecordLike } from './ontologyRecords';
/** The tracker type whose items carry labels. */
export declare const LABELED_TYPE = "entity";
export declare const ORGANIZATION_FACT_IDS: readonly ["annual-revenue", "funding-total", "headcount", "valuation", "last-round", "founded", "hq"];
export declare const PRODUCT_FACT_IDS: readonly ["lifecycle", "pricing", "license", "platforms", "launched", "users"];
export interface KindOption {
    value: string;
    label?: string;
}
/**
 * The registry the wiki reads: the room's, or while that is empty, the
 * built-in one plus a plain label for every other kind the schema offers or a
 * page uses.
 */
export declare function effectiveLabelRegistry(registry: LabelRegistry | null | undefined, fallback?: {
    kindOptions?: readonly KindOption[];
    observedKinds?: Iterable<string>;
}): LabelRegistry;
/** Whether `effectiveLabelRegistry` is standing in for a missing registry. */
export declare function isFallbackRegistry(registry: LabelRegistry | null | undefined): boolean;
export declare function labelById(registry: LabelRegistry): Map<string, LabelDefinition>;
/** "Products" for `product`; the id, humanized, for a label nobody declared. */
export declare function labelName(registry: LabelRegistry, id: string, plural?: boolean): string;
/** A labeled record's own labels (its `labels` and legacy `kind`); none for other types. */
export declare function recordOwnLabels(record: OntologyRecordLike): string[];
export declare function recordEffectiveLabels(registry: LabelRegistry, record: OntologyRecordLike): string[];
/**
 * The role a page plays: `structure` (areas, home) when any of its labels is
 * structure, else `market-node`, else `page`. Roles come from the page's own
 * labels first and are inherited from broader labels when unset.
 */
export declare function recordRole(registry: LabelRegistry, record: OntologyRecordLike): LabelRole | null;
export declare function hasRole(registry: LabelRegistry, record: OntologyRecordLike, role: LabelRole): boolean;
/** The wiki's home page carries the `home` label. */
export declare function isHomePage(record: OntologyRecordLike): boolean;
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
export declare function buildLabelIndex<T extends OntologyRecordLike>(registry: LabelRegistry, records: readonly T[]): LabelIndex<T>;
/** Label ids an entity-valued property's targets should carry; empty when it declares none. */
export declare function propertyRange(registry: LabelRegistry, propertyId: string): string[];
/** Labels directly under `labelId`. */
export declare function narrowerLabels(registry: LabelRegistry, labelId: string): string[];
export { labelAncestors };
