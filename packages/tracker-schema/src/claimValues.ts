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

export const CLAIM_FACT_STALE_DAYS = 90;

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

function text(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function objectValue(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string' && value.trim().startsWith('{')) {
    try { return objectValue(JSON.parse(value)); } catch { return {}; }
  }
  return {};
}

/** First id a relationship value points at: a bare id, `{ itemId }`, or a list of either. */
export function claimRefTarget(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const target = claimRefTarget(entry);
      if (target) return target;
    }
    return null;
  }
  if (typeof value === 'string') return value || null;
  if (value && typeof value === 'object') {
    const itemId = (value as { itemId?: unknown }).itemId;
    return typeof itemId === 'string' && itemId ? itemId : null;
  }
  return null;
}

function millis(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof Date) return value.getTime();
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

/** The part of a tracker record a claim is read from. */
export interface ClaimSourceRecord {
  id: string;
  primaryType?: string;
  archived?: boolean;
  system?: { updatedAt?: unknown; lastModifiedAt?: unknown; createdAt?: unknown } | null;
  fields: Record<string, unknown>;
}

/** Normalize a `claim` tracker record; null for any other type. */
export function readClaimRecord(record: ClaimSourceRecord): ClaimRecord | null {
  if (record.primaryType !== undefined && record.primaryType !== 'claim') return null;
  const fields = record.fields ?? {};
  const system = record.system ?? {};
  return {
    id: record.id,
    subjectId: claimRefTarget(fields.subject),
    predicate: text(fields.predicate),
    objectId: claimRefTarget(fields.object),
    valueText: text(fields.valueText),
    qualifiers: objectValue(fields.qualifiers),
    status: text(fields.status),
    archived: record.archived === true,
    updatedAt: millis(system.updatedAt ?? system.lastModifiedAt ?? system.createdAt),
  };
}

/** A claim with no status predates the field and reads as asserted. */
export function isClaimAsserted(claim: ClaimRecord): boolean {
  return !claim.archived && (claim.status === null || claim.status === 'asserted');
}

export function claimAsOf(claim: ClaimRecord): string | null {
  const asOf = text(claim.qualifiers.asOf);
  return asOf && Number.isFinite(Date.parse(asOf)) ? asOf : null;
}

export function claimAsOfPrecision(claim: ClaimRecord): AsOfPrecision {
  const precision = claim.qualifiers.asOfPrecision;
  return precision === 'month' || precision === 'year' ? precision : 'day';
}

/** The displayable value: `valueText`, else `amount unit`. Entity-valued claims have none. */
export function claimDisplayValue(claim: ClaimRecord): string | null {
  if (claim.valueText) return claim.valueText;
  const amount = text(claim.qualifiers.amount);
  return amount ? [amount, text(claim.qualifiers.unit)].filter(Boolean).join(' ') : null;
}

/** Latest `asOf` first; undated claims after dated ones, most recently edited first. */
export function compareClaimCurrency(a: ClaimRecord, b: ClaimRecord): number {
  const aAsOf = claimAsOf(a);
  const bAsOf = claimAsOf(b);
  const at = aAsOf ? Date.parse(aAsOf) : Number.NEGATIVE_INFINITY;
  const bt = bAsOf ? Date.parse(bAsOf) : Number.NEGATIVE_INFINITY;
  if (at !== bt) return bt > at ? 1 : -1;
  return b.updatedAt - a.updatedAt;
}

/** Stale once the end of the period `asOf` names is more than 90 days old. */
export function isClaimFactStale(
  asOf: string | null,
  now: Date = new Date(),
  precision: AsOfPrecision = 'day',
): boolean {
  const match = asOf ? /^(\d{4})-(\d{2})-(\d{2})/.exec(asOf) : null;
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]) - 1, Number(match[3])];
  const end = precision === 'year'
    ? Date.UTC(year + 1, 0, 0)
    : precision === 'month'
      ? Date.UTC(year, month + 1, 0)
      : Date.UTC(year, month, day);
  return now.getTime() - end > CLAIM_FACT_STALE_DAYS * 86_400_000;
}

export interface CurrentClaimValueOptions {
  now?: Date;
}

/**
 * The current value of `predicateId` for a subject. `subjectId` may list every
 * id the subject answers to (its item id and issue key), since a claim's
 * subject ref may name either.
 */
export function currentClaimValue(
  claims: readonly ClaimRecord[],
  subjectId: string | readonly string[],
  predicateId: string,
  options: CurrentClaimValueOptions = {},
): CurrentClaimValue | null {
  const subjects = new Set(typeof subjectId === 'string' ? [subjectId] : subjectId);
  const history = claims
    .filter(claim => claim.predicate === predicateId
      && claim.subjectId !== null
      && subjects.has(claim.subjectId)
      && isClaimAsserted(claim)
      && (claimDisplayValue(claim) !== null || claim.objectId !== null))
    .sort(compareClaimCurrency);
  const current = history[0];
  if (!current) return null;
  const asOf = claimAsOf(current);
  const asOfPrecision = claimAsOfPrecision(current);
  return {
    claimId: current.id,
    predicate: predicateId,
    value: claimDisplayValue(current),
    objectId: current.objectId,
    asOf,
    asOfPrecision,
    stale: isClaimFactStale(asOf, options.now ?? new Date(), asOfPrecision),
    qualifiers: current.qualifiers,
    history,
  };
}
