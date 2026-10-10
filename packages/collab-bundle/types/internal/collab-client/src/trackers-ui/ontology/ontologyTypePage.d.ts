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
import { type ClaimRecord, type EffectiveProperty, type EffectivePropertyStorage, type LabelDefinition, type LabelRegistry } from '../../../../tracker-schema/src/browser';
import { type LabelIndex } from './ontologyLabels';
import { type OntologyRecordLike } from './ontologyRecords';
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
export type TypeCell = {
    storage: 'field' | 'base-field' | 'unknown';
    value: unknown;
    /** Display text; for a relationship, the ids it names are in `targetIds`. */
    text: string;
    targetIds: string[];
    qualifiers: Record<string, unknown> | null;
} | {
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
export declare function claimRecordsOf(records: readonly OntologyRecordLike[]): ClaimRecord[];
/** One cell of the instance table. Null when the page has no value. */
export declare function typeCell(record: OntologyRecordLike, column: EffectiveProperty, subjectClaims: readonly ClaimRecord[], now: Date): TypeCell | null;
export declare function buildTypePageModel<T extends OntologyRecordLike>(registry: LabelRegistry, labelId: string, records: readonly T[], options: TypePageOptions): TypePageModel<T>;
