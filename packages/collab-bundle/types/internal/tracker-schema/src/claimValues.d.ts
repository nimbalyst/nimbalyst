/**
 * The current value of a claim-stored property.
 *
 * A claim-stored vocabulary entry keeps its history as `claim` items; the
 * value a page shows is the ASSERTED claim with the latest `asOf`. Undated
 * claims rank after dated ones, most recently edited first. A fact goes stale
 * 90 days after the end of the period its `asOf` names, so "Mar 2025" counts
 * from Mar 31 and "2025" from Dec 31.
 *
 * Pure and shared: the desktop detail pane and the web wiki read facts through
 * the same rule, so a page cannot show one value on one surface and another on
 * the other.
 */
export type AsOfPrecision = 'day' | 'month' | 'year';
export declare const CLAIM_FACT_STALE_DAYS = 90;
/** One claim, normalized. {@link readClaimRecord} builds it from a tracker record. */
export interface ClaimRecord {
    id: string;
    subjectId: string | null;
    predicate: string | null;
    objectId: string | null;
    valueText: string | null;
    qualifiers: Record<string, unknown>;
    status: string | null;
    archived: boolean;
    /** Epoch millis of the last edit; the tiebreak between equally dated claims. */
    updatedAt: number;
}
export interface CurrentClaimValue {
    claimId: string;
    predicate: string;
    /** `valueText`, or `amount unit` from the qualifiers; null for an entity-valued claim. */
    value: string | null;
    objectId: string | null;
    asOf: string | null;
    asOfPrecision: AsOfPrecision;
    stale: boolean;
    qualifiers: Record<string, unknown>;
    /** Every asserted claim with a value for this subject and predicate, current first. */
    history: ClaimRecord[];
}
/** First id a relationship value points at: a bare id, `{ itemId }`, or a list of either. */
export declare function claimRefTarget(value: unknown): string | null;
/** The part of a tracker record a claim is read from. */
export interface ClaimSourceRecord {
    id: string;
    primaryType?: string;
    archived?: boolean;
    system?: {
        updatedAt?: unknown;
        lastModifiedAt?: unknown;
        createdAt?: unknown;
    } | null;
    fields: Record<string, unknown>;
}
/** Normalize a `claim` tracker record; null for any other type. */
export declare function readClaimRecord(record: ClaimSourceRecord): ClaimRecord | null;
/** A claim with no status predates the field and reads as asserted. */
export declare function isClaimAsserted(claim: ClaimRecord): boolean;
export declare function claimAsOf(claim: ClaimRecord): string | null;
export declare function claimAsOfPrecision(claim: ClaimRecord): AsOfPrecision;
/** The displayable value: `valueText`, else `amount unit`. Entity-valued claims have none. */
export declare function claimDisplayValue(claim: ClaimRecord): string | null;
/** Latest `asOf` first; undated claims after dated ones, most recently edited first. */
export declare function compareClaimCurrency(a: ClaimRecord, b: ClaimRecord): number;
/** Stale once the end of the period `asOf` names is more than 90 days old. */
export declare function isClaimFactStale(asOf: string | null, now?: Date, precision?: AsOfPrecision): boolean;
export interface CurrentClaimValueOptions {
    now?: Date;
}
/**
 * The current value of `predicateId` for a subject. `subjectId` may list every
 * id the subject answers to (its item id and issue key), since a claim's
 * subject ref may name either.
 */
export declare function currentClaimValue(claims: readonly ClaimRecord[], subjectId: string | readonly string[], predicateId: string, options?: CurrentClaimValueOptions): CurrentClaimValue | null;
