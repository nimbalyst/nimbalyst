import { describe, expect, it } from 'vitest';
import {
  buildTrackerDeepLink,
  buildTrackerDocumentDeepLink,
} from '../collabDocuments';
import { parseTrackerDeepLink } from '../../../../shared/trackerDeepLinks';

describe('tracker deep-link URLs', () => {
  it('builds and parses the backward-compatible link without a view', () => {
    const url = buildTrackerDeepLink('tracker/one', 'org one');

    expect(url).toBe('nimbalyst://tracker/tracker%2Fone?orgId=org%20one');
    expect(parseTrackerDeepLink(url)).toEqual({
      trackerId: 'tracker/one',
      orgId: 'org one',
    });
  });

  it('builds and parses view=document through the options argument', () => {
    const url = buildTrackerDeepLink('tracker/one', 'org one', {
      view: 'document',
    });

    expect(url).toBe(
      'nimbalyst://tracker/tracker%2Fone?orgId=org%20one&view=document',
    );
    expect(parseTrackerDeepLink(url)).toEqual({
      trackerId: 'tracker/one',
      orgId: 'org one',
      view: 'document',
    });
  });

  it('provides the document-link helper without handling the clipboard', () => {
    expect(buildTrackerDocumentDeepLink('tracker-2', 'org-2')).toBe(
      'nimbalyst://tracker/tracker-2?orgId=org-2&view=document',
    );
  });

  it('rejects unsupported tracker view values at the URL boundary', () => {
    expect(() => parseTrackerDeepLink(
      'nimbalyst://tracker/tracker-1?orgId=org-1&view=detail',
    )).toThrow(/unsupported view/i);
  });
});
