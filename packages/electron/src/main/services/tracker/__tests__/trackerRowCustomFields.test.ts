import { describe, it, expect } from 'vitest';
import { trackerItemToRecord, type TrackerItem } from '@nimbalyst/runtime';
import { extractItemCustomFields } from '../trackerRowCustomFields';

const KNOWN = new Set([
  'title', 'description', 'status', 'priority', 'owner', 'tags',
  'created', 'updated', 'dueDate', 'assigneeEmail', 'reporterEmail',
  'authorIdentity', 'lastModifiedBy', 'createdByAgent', 'assigneeId',
  'reporterId', 'labels', 'linkedSessions', 'linkedCommitSha', 'documentId',
]);

describe('extractItemCustomFields (NIM-863)', () => {
  it('un-nests a nested data.customFields object so schema columns resolve', () => {
    const data = {
      title: 'fix: thing (#321)',
      status: 'backlog',
      customFields: {
        prUrl: { url: 'https://github.com/nimbalyst/nimbalyst/pull/335', label: '#335' },
        author: 'ademczuk',
        prNumber: 335,
      },
      kanbanSortOrder: 'a0',
    };

    const cf = extractItemCustomFields(data, KNOWN);
    // The PR fields are lifted to the top level of the customFields bag...
    expect(cf?.prUrl).toEqual({ url: 'https://github.com/nimbalyst/nimbalyst/pull/335', label: '#335' });
    expect(cf?.author).toBe('ademczuk');
    expect(cf?.prNumber).toBe(335);
    // ...top-level extras are still preserved...
    expect(cf?.kanbanSortOrder).toBe('a0');
    // ...and the raw nested `customFields` key is NOT carried through.
    expect(cf && 'customFields' in cf).toBe(false);
  });

  it('round-trips through trackerItemToRecord so table columns see the values', () => {
    const data = {
      title: 'fix: thing',
      status: 'backlog',
      customFields: { prUrl: { url: 'https://x/pull/1', label: '#1' }, author: 'lisah2u', prNumber: 1 },
    };
    const item = {
      id: 'pr_1', type: 'github-pr', typeTags: ['github-pr'],
      title: 'fix: thing', status: 'backlog',
      customFields: extractItemCustomFields(data, KNOWN),
    } as unknown as TrackerItem;

    const record = trackerItemToRecord(item);
    expect(record.fields.prUrl).toEqual({ url: 'https://x/pull/1', label: '#1' });
    expect(record.fields.author).toBe('lisah2u');
    expect(record.fields.prNumber).toBe(1);
  });

  it('still works when custom fields are stored flat at the top level (legacy)', () => {
    const data = {
      title: 'x', status: 'backlog',
      prUrl: { url: 'https://x/pull/2', label: '#2' }, author: 'flatuser',
    };
    const cf = extractItemCustomFields(data, KNOWN);
    expect(cf?.prUrl).toEqual({ url: 'https://x/pull/2', label: '#2' });
    expect(cf?.author).toBe('flatuser');
  });

  it('returns undefined when there are no extra fields', () => {
    expect(extractItemCustomFields({ title: 'x', status: 'backlog' }, KNOWN)).toBeUndefined();
  });
});
