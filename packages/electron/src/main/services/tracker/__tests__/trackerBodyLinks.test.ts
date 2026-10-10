// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { bodyLinkKeys, deriveBodyLinkEdges, parseBodyLinks } from '../trackerBodyLinks';

const TEAM_ITEM = 'https://console.nimbalyst.com/org/o/project/p/page/item';
const HOME = { homeScope: { orgId: 'o', projectId: 'p' } };

describe('trackerBodyLinks', () => {
  it('reads console item links, in the current and the older trackers shape, and nimbalyst:// links alike', () => {
    const markdown = [
      `Sync is [NIM-1](${TEAM_ITEM}/NIM-1 "view=card rel=built-on") underneath. Old: [NIM-2](nimbalyst://NIM-2 "rel=owned-by").`,
      'Mine: [tk_9](https://console.nimbalyst.com/app/item/tk_9).',
      'Before: [NIM-5](https://console.nimbalyst.com/org/o/project/p/trackers/item/NIM-5).',
    ].join('\n');
    expect(parseBodyLinks(markdown, HOME)).toEqual([
      { key: 'NIM-1', rel: 'built-on', sentence: 'Sync is NIM-1 underneath.' },
      { key: 'NIM-2', rel: 'owned-by', sentence: 'Old: NIM-2.' },
      { key: 'tk_9', rel: null, sentence: 'Mine: tk_9.' },
      { key: 'NIM-5', rel: null, sentence: 'Before: NIM-5.' },
    ]);
  });

  it('decodes the key and ignores the list-context query the console adds', () => {
    expect(bodyLinkKeys(`[x](${TEAM_ITEM}/NIM%2D3?type=bug "rel=built-on")`, HOME)).toEqual(['NIM-3']);
  });

  it('does not read console links to pages, types or views, other sites, or code', () => {
    const markdown = [
      '[Spec](https://console.nimbalyst.com/org/o/project/p/document/doc-1) and',
      '[Bugs](https://console.nimbalyst.com/org/o/project/p/trackers/type/bug) and',
      '[x](https://example.com/org/o/project/p/trackers/item/NIM-1) and',
      `\`[NIM-4](${TEAM_ITEM}/NIM-4)\``,
    ].join('\n');
    expect(parseBodyLinks(markdown, HOME)).toEqual([]);
  });

  it('makes one edge per target and relation across both link forms', () => {
    const markdown = `[a](${TEAM_ITEM}/NIM-1 "rel=built-on") then [b](nimbalyst://NIM-1 "rel=built-on").`;
    const edges = deriveBodyLinkEdges('src', markdown, (key) => (key === 'NIM-1' ? { itemId: 'item-1', type: 'module' } : null), HOME);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ sourceFieldId: 'body:built-on', targetItemId: 'item-1', metadata: { count: 2 } });
  });

  it('never resolves another team project\'s item as this project\'s item with the same key', () => {
    const other = 'https://console.nimbalyst.com/org/o/project/elsewhere/trackers/item';
    const markdown = `[a](${other}/NIM-1 "rel=built-on") and [b](${TEAM_ITEM}/NIM-2 "rel=built-on") and [c](nimbalyst://NIM-3).`;
    const resolve = (key: string) => ({ itemId: `item-${key}`, type: 'module' });
    const home = { orgId: 'o', projectId: 'p' };

    expect(bodyLinkKeys(markdown, { homeScope: home })).toEqual(['NIM-2', 'NIM-3']);
    expect(deriveBodyLinkEdges('src', markdown, resolve, { homeScope: home }).map((edge) => edge.targetItemId)).toEqual(['item-NIM-2', 'item-NIM-3']);
    // A workspace with no team, or whose team is not known yet (signed out), holds no team project's items.
    expect(bodyLinkKeys(markdown, { homeScope: null })).toEqual(['NIM-3']);
    expect(bodyLinkKeys(markdown)).toEqual(['NIM-3']);
    expect(deriveBodyLinkEdges('src', markdown, resolve).map((edge) => edge.targetItemId)).toEqual(['item-NIM-3']);
  });
});
