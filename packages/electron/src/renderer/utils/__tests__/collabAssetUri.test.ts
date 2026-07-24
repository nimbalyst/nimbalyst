import { describe, expect, it } from 'vitest';
import { buildCollabAssetUri, isCollabAssetUri, parseCollabAssetUri } from '../collabAssetUri';

describe('collabAssetUri', () => {
  it('builds and parses collaborative asset URIs', () => {
    const uri = buildCollabAssetUri('doc/with spaces', 'asset#1');

    expect(uri).toBe('collab-asset://doc/doc%2Fwith%20spaces/asset/asset%231');
    expect(parseCollabAssetUri(uri)).toEqual({
      documentId: 'doc/with spaces',
      assetId: 'asset#1',
    });
  });

  it('rejects non-collaborative asset URIs', () => {
    expect(parseCollabAssetUri('https://example.com/file.png')).toBeNull();
    expect(parseCollabAssetUri('collab-asset://doc/doc-1')).toBeNull();
    expect(isCollabAssetUri('file:///tmp/test.pdf')).toBe(false);
  });
});
