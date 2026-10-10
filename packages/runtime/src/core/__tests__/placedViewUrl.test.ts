// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  createPlacedViewMarkdown,
  createPlacedViewUrl,
  decodeViewAttrValue,
  encodeViewAttrValue,
  parsePlacedViewUrl,
} from '../placedViewUrl';
import { TrackerReferenceTransformer } from '../../plugins/TrackerLinkPlugin/TrackerReferenceTransformer';
import { isTrackerReferenceKey } from '../../plugins/TrackerLinkPlugin/trackerReferenceHref';

describe('placedViewUrl', () => {
  it('round-trips a type view and a marks view', () => {
    const type = { kind: 'type', typeId: 'competitor' } as const;
    expect(parsePlacedViewUrl(createPlacedViewUrl(type))).toEqual(type);
    expect(createPlacedViewUrl(type)).toBe('nimbalyst://view/type/competitor');

    const odd = { kind: 'type', typeId: 'my type/2' } as const;
    expect(parsePlacedViewUrl(createPlacedViewUrl(odd))).toEqual(odd);

    for (const marks of ['decided', 'open', 'all'] as const) {
      const target = { kind: 'marks', marks } as const;
      expect(parsePlacedViewUrl(createPlacedViewUrl(target))).toEqual(target);
    }
    expect(createPlacedViewUrl({ kind: 'marks', marks: 'open' })).toBe('nimbalyst://view/marks?kind=open');
  });

  it('writes a console link for the page\'s scope and reads it back with that scope', () => {
    const team = { orgId: 'org 1', projectId: 'proj-1' };
    const typeUrl = createPlacedViewUrl({ kind: 'type', typeId: 'competitor' }, team);
    expect(typeUrl).toBe('https://console.nimbalyst.com/org/org%201/project/proj-1/view/type/competitor');
    expect(parsePlacedViewUrl(typeUrl)).toEqual({ kind: 'type', typeId: 'competitor', scope: team });

    const marksUrl = createPlacedViewUrl({ kind: 'marks', marks: 'open' }, 'local');
    expect(marksUrl).toBe('https://console.nimbalyst.com/app/view/marks?kind=open');
    expect(parsePlacedViewUrl(marksUrl)).toEqual({ kind: 'marks', marks: 'open', scope: 'local' });

    // Older pages keep their app links.
    expect(parsePlacedViewUrl('nimbalyst://view/type/competitor')).toEqual({ kind: 'type', typeId: 'competitor' });
    expect(createPlacedViewMarkdown({ kind: 'type', typeId: 'competitor' }, 'Competitors', { mode: '2x2' }, 'local'))
      .toBe('[Competitors](https://console.nimbalyst.com/app/view/type/competitor "mode=2x2")');
  });

  it('rejects other links', () => {
    for (const url of [
      'nimbalyst://view/abc',
      'nimbalyst://view/type/',
      'nimbalyst://view/marks?kind=closed',
      'nimbalyst://NIM-12',
      'https://example.com/view/type/x',
      'https://console.nimbalyst.com/org/o/project/p/document/doc-1',
      'https://console.nimbalyst.com/app/item/NIM-1',
      '',
    ]) expect(parsePlacedViewUrl(url)).toBeNull();
  });

  it('writes the definition into the link title with no spaces or quotes', () => {
    const markdown = createPlacedViewMarkdown({ kind: 'type', typeId: 'competitor' }, 'All [competitors]', {
      cols: 'title,realtime',
      sort: 'realtime:desc',
      xl: encodeViewAttrValue('Developer-first, "open"'),
    });
    expect(markdown).toBe('[All competitors](nimbalyst://view/type/competitor "cols=title,realtime sort=realtime:desc xl=Developer-first%2C%20%22open%22")');
    expect(decodeViewAttrValue('Developer-first%2C%20%22open%22')).toBe('Developer-first, "open"');
    expect(decodeViewAttrValue('Batch+to+realtime')).toBe('Batch to realtime');
  });

  it('is not claimed as a tracker reference', () => {
    const link = createPlacedViewMarkdown({ kind: 'type', typeId: 'competitor' }, 'Competitors', { mode: '2x2' });
    expect(TrackerReferenceTransformer.type).toBe('text-match');
    const transformer = TrackerReferenceTransformer as { importRegExp: RegExp };
    expect(transformer.importRegExp.test(link)).toBe(false);
    expect(transformer.importRegExp.test('[Decided](nimbalyst://view/marks?kind=decided)')).toBe(false);
    expect(isTrackerReferenceKey('view/type/competitor')).toBe(false);
    const consoleLink = createPlacedViewMarkdown({ kind: 'type', typeId: 'competitor' }, 'Competitors', {}, 'local');
    expect(transformer.importRegExp.test(consoleLink)).toBe(false);
  });
});
