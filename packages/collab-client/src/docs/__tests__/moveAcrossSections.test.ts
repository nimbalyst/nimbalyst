// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { moveAcrossSections, readMoveTree, type MoveAcrossSectionsDependencies, type MovePageNode } from '../moveAcrossSections';

const tree: MovePageNode = {
  documentId: 'p', title: 'Product', fields: { status: 'current' },
  children: [{ documentId: 'c', title: 'Pricing', children: [] }],
};

function harness(bodies: Record<string, string>, overrides: Partial<MoveAcrossSectionsDependencies> = {}) {
  const events: string[] = [];
  const stored = new Map<string, string>();
  let next = 0;
  const deps: MoveAcrossSectionsDependencies = {
    readTree: () => ({ ok: true, root: tree }),
    readSource: async (id) => ({ markdown: bodies[id] }),
    sourceUnchanged: async () => true,
    createDestination: async ({ title, markdown, parentId, fields }) => {
      const id = `new-${++next}`;
      events.push(`create ${title} under ${parentId ?? 'top'}${fields ? ` ${JSON.stringify(fields)}` : ''}`);
      stored.set(id, `${markdown}\n\n`);
      return id;
    },
    readDestination: async (id) => stored.get(id) ?? '',
    trashDestination: async (id) => { events.push(`trash copy ${id}`); },
    trashSource: async (id) => { events.push(`trash source ${id}`); return { ok: true }; },
    ...overrides,
  };
  return { deps, events };
}

describe('moving a page between sections', () => {
  it('copies parents first, checks every body, and only then trashes the source', async () => {
    const { deps, events } = harness({ p: 'Why we build it.', c: 'What we charge.' });
    expect(await moveAcrossSections('p', deps)).toEqual({ ok: true, pageId: 'new-1', moved: 2 });
    expect(events).toEqual([
      'create Product under top {"status":"current"}',
      'create Pricing under new-1',
      'trash source p',
    ]);
  });

  it('leaves the source alone and trashes the copies when a body does not arrive or the source changed', async () => {
    const garbled = harness({ p: 'Why.', c: 'What.' }, { readDestination: async () => 'something else' });
    expect(await moveAcrossSections('p', garbled.deps)).toMatchObject({ ok: false, error: expect.stringContaining('did not arrive intact') });
    expect(garbled.events).toEqual(['create Product under top {"status":"current"}', 'trash copy new-1']);

    const edited = harness({ p: 'Why.', c: 'What.' }, { sourceUnchanged: async (id) => id !== 'c' });
    expect(await moveAcrossSections('p', edited.deps)).toMatchObject({ ok: false, error: expect.stringContaining('changed') });
    expect(edited.events.at(-1)).toBe('trash copy new-1');
    expect(edited.events.some((event) => event.startsWith('trash source'))).toBe(false);
  });

  it('refuses a page with images before copying anything', async () => {
    const { deps, events } = harness({ p: 'Intro', c: 'See ![chart](assets/a.png)' });
    expect(await moveAcrossSections('p', deps)).toMatchObject({ ok: false, error: expect.stringContaining('"Pricing" has images') });
    expect(events).toEqual([]);
  });
});

describe('what a move takes', () => {
  const doc = (documentId: string, parentFolderId: string | null, extra: Record<string, unknown> = {}) => ({
    documentId, title: documentId, documentType: 'markdown', parentFolderId, teamProjectId: null, createdBy: '', createdAt: 0, updatedAt: 0, ...extra,
  });
  const none = { items: [], types: [] };

  it('takes the page and its plain pages, but not trashed ones', () => {
    const result = readMoveTree('p', [doc('p', null, { fields: { status: 'draft' } }), doc('c', 'p'), doc('gone', 'p', { trashedAt: 1 })], none);
    expect(result).toEqual({ ok: true, root: { documentId: 'p', title: 'p', fields: { status: 'draft' }, children: [{ documentId: 'c', title: 'c', children: [] }] } });
  });

  it('refuses a subtree holding a typed page, a type, a type\'s prose or a non-markdown page', () => {
    expect(readMoveTree('p', [doc('p', null), doc('c', 'p')], { items: [{ parentId: 'c' }], types: [] })).toMatchObject({ ok: false, error: expect.stringContaining('"c" holds typed pages') });
    expect(readMoveTree('p', [doc('p', null)], { items: [], types: [{ parentFolderId: 'p' }] })).toMatchObject({ ok: false });
    expect(readMoveTree('p', [doc('p', null), doc('type-page:module', 'p')], none)).toMatchObject({ ok: false, error: expect.stringContaining("type's description") });
    expect(readMoveTree('p', [doc('p', null, { documentType: 'excalidraw' })], none)).toMatchObject({ ok: false, error: expect.stringContaining('not a markdown page') });
  });
});
