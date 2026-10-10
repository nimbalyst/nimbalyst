// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@nimbalyst/tracker-schema', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@nimbalyst/tracker-schema')>()),
  globalRegistry: { get: (type: string) => (type === 'competitor' ? { type } : undefined) },
}));

import { detectFlatTypedPage, setLocalWikiRoot, updateFlatTypedPageFields } from '../flatTypedPage';
import { shouldRenderTrackerHeader } from '../TrackerDocumentHeader';

const WIKI = '/repo/nimbalyst-local/wiki';

afterEach(() => setLocalWikiRoot('/repo', null));

describe('flat typed pages (Local wiki format)', () => {
  it('reads a flat type only inside a Local wiki, or with an id and a registered type', () => {
    const page = '---\nid: 01J9\ntitle: "R/D"\ntype: competitor\norder: 3000\nstatus: active\n---\nBody\n';
    const blog = '---\ntype: post\ntags: [a]\n---\nHello\n';

    expect(detectFlatTypedPage(page, '/repo/notes/Acme.md')).toEqual({ type: 'competitor', data: { status: 'active' }, id: '01J9' });
    // An arbitrary `type:` outside the wiki is not a typed page.
    expect(detectFlatTypedPage(blog, '/repo/blog/hello.md')).toBeNull();
    expect(shouldRenderTrackerHeader(blog, '/repo/blog/hello.md')).toBe(false);
    expect(detectFlatTypedPage('---\ntype: competitor\n---\n', '/repo/notes/x.md')).toBeNull();

    setLocalWikiRoot('/repo', WIKI);
    expect(detectFlatTypedPage(blog, `${WIKI}/Posts/hello.md`)).toEqual({ type: 'post', data: { tags: ['a'] }, id: null });
    expect(shouldRenderTrackerHeader(blog, `${WIKI}/Posts/hello.md`)).toBe(true);
    // A trackerStatus block stays with the wrapped reader.
    expect(detectFlatTypedPage('---\ntype: x\ntrackerStatus:\n  type: plan\n---\n', `${WIKI}/p.md`)).toBeNull();
  });

  it('writes field edits back as flat keys and leaves the reserved keys and formatting alone', () => {
    const page = '---\nid: 01J9 # keep me\ntype: competitor\norder: 3000\nstatus: active\n---\nBody\n';
    expect(updateFlatTypedPageFields(page, { status: 'defunct', tier: 2, id: 'other', type: 'x' }))
      .toBe('---\nid: 01J9 # keep me\ntype: competitor\norder: 3000\nstatus: defunct\ntier: 2\n---\nBody\n');
    expect(updateFlatTypedPageFields(page, { status: null })).toBe('---\nid: 01J9 # keep me\ntype: competitor\norder: 3000\n---\nBody\n');
  });
});
