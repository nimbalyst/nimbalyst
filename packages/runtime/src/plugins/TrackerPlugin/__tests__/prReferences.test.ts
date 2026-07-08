import { describe, it, expect } from 'vitest';
import { parsePrUrl, buildPrUrl, getRecordPrReferences } from '../prReferences';
import { dbRowToRecord } from '../../../core/TrackerRecord';
import type { TrackerRecord } from '../../../core/TrackerRecord';

function makeRecord(fields: Record<string, unknown>, system: Partial<TrackerRecord['system']> = {}): TrackerRecord {
  return {
    id: 'tk_test',
    primaryType: 'github-pr',
    typeTags: ['github-pr'],
    source: 'native',
    archived: false,
    syncStatus: 'local',
    system: {
      workspace: '/tmp/ws',
      createdAt: '2026-07-06T00:00:00.000Z',
      updatedAt: '2026-07-06T00:00:00.000Z',
      ...system,
    },
    fields,
  };
}

describe('parsePrUrl', () => {
  it('parses a canonical PR URL', () => {
    expect(parsePrUrl('https://github.com/nimbalyst/nimbalyst/pull/712')).toEqual({
      remote: 'nimbalyst/nimbalyst',
      number: 712,
    });
  });

  it('tolerates www, http, trailing slash, and sub-pages', () => {
    for (const url of [
      'http://www.github.com/Owner/Repo/pull/9',
      'https://github.com/Owner/Repo/pull/9/',
      'https://github.com/Owner/Repo/pull/9/files',
      'https://github.com/Owner/Repo/pull/9?diff=split',
      'https://github.com/Owner/Repo/pull/9#discussion_r1',
    ]) {
      expect(parsePrUrl(url)).toEqual({ remote: 'owner/repo', number: 9 });
    }
  });

  it('rejects non-PR github URLs and junk', () => {
    expect(parsePrUrl('https://github.com/owner/repo/issues/9')).toBeNull();
    expect(parsePrUrl('https://github.com/owner/repo')).toBeNull();
    expect(parsePrUrl('https://example.com/owner/repo/pull/9')).toBeNull();
    expect(parsePrUrl('https://github.com/owner/repo/pull/0')).toBeNull();
    expect(parsePrUrl('https://github.com/owner/repo/pull/12abc')).toBeNull();
    expect(parsePrUrl('')).toBeNull();
  });

  it('round-trips buildPrUrl', () => {
    expect(parsePrUrl(buildPrUrl('owner/repo', 42))).toEqual({ remote: 'owner/repo', number: 42 });
  });
});

describe('getRecordPrReferences', () => {
  it('finds a url field stored as a {url, label} object', () => {
    const record = makeRecord({
      prUrl: { url: 'https://github.com/nimbalyst/nimbalyst/pull/712', label: '#712' },
    });
    expect(getRecordPrReferences(record)).toEqual([{ remote: 'nimbalyst/nimbalyst', number: 712 }]);
  });

  it('finds a plain string url field', () => {
    const record = makeRecord({ link: 'https://github.com/a/b/pull/3' });
    expect(getRecordPrReferences(record)).toEqual([{ remote: 'a/b', number: 3 }]);
  });

  it('parses JSON-string field values (SQLite JSONB sub-extraction shape)', () => {
    const record = makeRecord({
      prUrl: JSON.stringify({ url: 'https://github.com/a/b/pull/5', label: '#5' }),
    });
    expect(getRecordPrReferences(record)).toEqual([{ remote: 'a/b', number: 5 }]);
  });

  it('includes explicit system.linkedPullRequests entries and dedupes against field matches', () => {
    const record = makeRecord(
      { prUrl: { url: 'https://github.com/a/b/pull/7' } },
      { linkedPullRequests: [
        { remote: 'A/B', number: 7 },
        { remote: 'a/b', number: 8, url: 'https://github.com/a/b/pull/8' },
      ] },
    );
    expect(getRecordPrReferences(record)).toEqual([
      { remote: 'a/b', number: 7 },
      { remote: 'a/b', number: 8 },
    ]);
  });

  it('ignores malformed linkedPullRequests entries and non-url fields', () => {
    const record = makeRecord(
      { title: 'Some PR', prNumber: 712, notes: 'see pull/9' },
      { linkedPullRequests: [{ remote: 42, number: 'x' } as never] },
    );
    expect(getRecordPrReferences(record)).toEqual([]);
  });

  it('finds PR URLs after dbRowToRecord lifts nested customFields', () => {
    const record = dbRowToRecord({
      id: 'tk_nested',
      type: 'github-pr',
      workspace: '/tmp/ws',
      data: {
        title: 'Nested PR',
        customFields: {
          prUrl: { url: 'https://github.com/a/b/pull/11', label: '#11' },
        },
      },
      created: '2026-07-06T00:00:00.000Z',
      updated: '2026-07-06T00:00:00.000Z',
    });

    expect(record.fields.prUrl).toEqual({ url: 'https://github.com/a/b/pull/11', label: '#11' });
    expect(getRecordPrReferences(record)).toEqual([{ remote: 'a/b', number: 11 }]);
  });
});
