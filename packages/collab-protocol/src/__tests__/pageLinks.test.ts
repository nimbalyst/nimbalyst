// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { findPageLinks } from '../pageLinks.js';

const TEAM = 'https://console.nimbalyst.com/org/o/project/p';

describe('findPageLinks', () => {
  it('reads console item links (current and older shape), legacy nimbalyst:// links and page links, with their relation and sentence', () => {
    const markdown = [
      `Sync is [NIM-1](${TEAM}/page/item/NIM-1 "view=card rel=built-on") underneath. Old: [NIM-2](nimbalyst://NIM-2 "rel=owned-by").`,
      `Before: [NIM-5](${TEAM}/trackers/item/NIM-5). See [the spec](${TEAM}/document/doc-1 "rel=described-by").`,
    ].join('\n');
    expect(findPageLinks(markdown)).toEqual([
      { target: { kind: 'item', ref: 'NIM-1' }, scope: { orgId: 'o', projectId: 'p' }, rel: 'built-on', sentence: 'Sync is NIM-1 underneath.' },
      { target: { kind: 'item', ref: 'NIM-2' }, scope: 'home', rel: 'owned-by', sentence: 'Old: NIM-2.' },
      { target: { kind: 'item', ref: 'NIM-5' }, scope: { orgId: 'o', projectId: 'p' }, rel: null, sentence: 'Before: NIM-5.' },
      { target: { kind: 'page', documentId: 'doc-1' }, scope: { orgId: 'o', projectId: 'p' }, rel: 'described-by', sentence: 'See the spec.' },
    ]);
  });

  it('keeps another project\'s scope so a reader can tell it is not a local relation', () => {
    const [link] = findPageLinks(`[a](https://console.nimbalyst.com/org/o/project/elsewhere/page/item/NIM-1 "rel=built-on").`);
    expect(link).toMatchObject({ target: { kind: 'item', ref: 'NIM-1' }, scope: { orgId: 'o', projectId: 'elsewhere' } });
  });

  it('decodes the key and ignores the list-context query the console adds', () => {
    expect(findPageLinks(`[x](${TEAM}/page/item/NIM%2D3?type=bug "rel=built-on")`).map((link) => link.target)).toEqual([{ kind: 'item', ref: 'NIM-3' }]);
  });

  it('skips local links, types, views, other sites, code, and a bad relation id', () => {
    const markdown = [
      '[Mine](https://console.nimbalyst.com/app/item/tk_9) and [Home](https://console.nimbalyst.com/app/page/pp-1) and',
      `[Bugs](${TEAM}/page/type/bug) and [View](${TEAM}/view/type/bug) and`,
      '[x](https://example.com/org/o/project/p/page/item/NIM-1) and',
      `\`[NIM-4](${TEAM}/page/item/NIM-4)\``,
      '```',
      `[NIM-6](${TEAM}/page/item/NIM-6)`,
      '```',
    ].join('\n');
    expect(findPageLinks(markdown)).toEqual([]);
    expect(findPageLinks(`[a](nimbalyst://NIM-7 "rel=Not_Valid").`)[0]?.rel).toBeNull();
  });
});
