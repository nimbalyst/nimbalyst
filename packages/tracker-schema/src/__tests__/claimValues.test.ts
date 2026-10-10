// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  currentClaimValue,
  isClaimFactStale,
  readClaimRecord,
  type ClaimRecord,
} from '../claimValues.js';

const NOW = new Date('2026-09-29T00:00:00Z');

function claim(overrides: Partial<ClaimRecord> & { id: string }): ClaimRecord {
  return {
    subjectId: 'acme',
    predicate: 'annual-revenue',
    objectId: null,
    valueText: null,
    qualifiers: {},
    status: 'asserted',
    archived: false,
    updatedAt: 0,
    ...overrides,
  };
}

describe('currentClaimValue', () => {
  it('picks the asserted claim with the latest asOf, ignoring other statuses', () => {
    const claims = [
      claim({ id: 'old', valueText: '$10M', qualifiers: { asOf: '2025-01-01' } }),
      claim({ id: 'new', valueText: '$20M', qualifiers: { asOf: '2026-08-01' } }),
      claim({ id: 'disputed', valueText: '$99M', status: 'disputed', qualifiers: { asOf: '2026-09-01' } }),
      claim({ id: 'archived', valueText: '$98M', archived: true, qualifiers: { asOf: '2026-09-02' } }),
      claim({ id: 'other-subject', subjectId: 'globex', valueText: '$1B', qualifiers: { asOf: '2026-09-03' } }),
      claim({ id: 'other-predicate', predicate: 'headcount', valueText: '40', qualifiers: { asOf: '2026-09-04' } }),
    ];
    const current = currentClaimValue(claims, 'acme', 'annual-revenue', { now: NOW });
    expect(current?.claimId).toBe('new');
    expect(current?.value).toBe('$20M');
    expect(current?.stale).toBe(false);
    expect(current?.history.map(c => c.id)).toEqual(['new', 'old']);
  });

  it('ranks dated claims over undated ones, and undated ones by last edit', () => {
    const claims = [
      claim({ id: 'undated-recent', valueText: 'b', updatedAt: 200 }),
      claim({ id: 'undated-old', valueText: 'a', updatedAt: 100 }),
    ];
    expect(currentClaimValue(claims, 'acme', 'annual-revenue', { now: NOW })?.claimId).toBe('undated-recent');
    const withDated = [...claims, claim({ id: 'dated', valueText: 'c', qualifiers: { asOf: '2020-01-01' } })];
    expect(currentClaimValue(withDated, 'acme', 'annual-revenue', { now: NOW })?.claimId).toBe('dated');
  });

  it('matches the subject by any of its ids, skips valueless claims, and reads amount + unit', () => {
    const claims = [
      claim({ id: 'empty', subjectId: 'NIM-7', qualifiers: { asOf: '2026-09-01' } }),
      claim({ id: 'amount', subjectId: 'NIM-7', qualifiers: { asOf: '2026-01-01', amount: 12, unit: 'USD' } }),
    ];
    const current = currentClaimValue(claims, ['acme', 'NIM-7'], 'annual-revenue', { now: NOW });
    expect(current?.claimId).toBe('amount');
    expect(current?.value).toBe('12 USD');
  });

  it('returns the object id for an entity-valued claim', () => {
    const current = currentClaimValue(
      [claim({ id: 'made', predicate: 'made-by', objectId: 'org-1' })],
      'acme',
      'made-by',
      { now: NOW },
    );
    expect(current?.objectId).toBe('org-1');
    expect(current?.value).toBeNull();
  });

  it('returns null when nothing is asserted', () => {
    expect(currentClaimValue([claim({ id: 'd', status: 'draft', valueText: 'x' })], 'acme', 'annual-revenue')).toBeNull();
  });
});

describe('isClaimFactStale', () => {
  it('counts 90 days from the end of the period asOf names', () => {
    expect(isClaimFactStale('2026-06-30', NOW)).toBe(true);
    expect(isClaimFactStale('2026-07-02', NOW)).toBe(false);
    // "Jun 2026" ends Jun 30; "2025" ends Dec 31 2025.
    expect(isClaimFactStale('2026-06-01', NOW, 'month')).toBe(true);
    expect(isClaimFactStale('2026-07-01', NOW, 'month')).toBe(false);
    expect(isClaimFactStale('2025-01-01', NOW, 'year')).toBe(true);
    expect(isClaimFactStale('2026-01-01', NOW, 'year')).toBe(false);
    expect(isClaimFactStale(null, NOW)).toBe(false);
  });
});

describe('readClaimRecord', () => {
  it('normalizes a tracker claim record, refs and JSON-string qualifiers included', () => {
    const record = readClaimRecord({
      id: 'clm-1',
      primaryType: 'claim',
      archived: false,
      system: { updatedAt: '2026-09-01T00:00:00Z' },
      fields: {
        subject: { itemId: 'ent-1' },
        predicate: 'founded',
        valueText: ' 2019 ',
        qualifiers: '{"asOf":"2026-02-01","asOfPrecision":"month"}',
        status: 'asserted',
      },
    });
    expect(record).toMatchObject({
      id: 'clm-1',
      subjectId: 'ent-1',
      predicate: 'founded',
      valueText: '2019',
      qualifiers: { asOf: '2026-02-01', asOfPrecision: 'month' },
      status: 'asserted',
    });
    expect(readClaimRecord({ id: 'x', primaryType: 'entity', fields: {} })).toBeNull();
  });
});
