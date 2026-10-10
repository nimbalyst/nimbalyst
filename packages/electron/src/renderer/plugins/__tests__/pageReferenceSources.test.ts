// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../services/CollaborativeDocumentTypeCatalog', () => ({
  getCollaborativeDocumentTypeCatalog: () => ({
    inferFileExtension: (documentType: string) => (documentType === 'excalidraw' ? '.excalidraw' : '.md'),
    resolveMetadata: () => ({ state: 'unavailable' }),
  }),
}));

import type { SharedDocument } from '../../store/atoms/collabDocuments';
import {
  isPersonalPageLink,
  localFileReferenceSource,
  personalPageIdOf,
  personalPageReferenceOptions,
  referenceContextOf,
} from '../pageReferenceSources';

function page(documentId: string, title: string, parentFolderId: string | null = null): SharedDocument {
  return { documentId, title, documentType: 'markdown', teamProjectId: null, createdBy: 'me', createdAt: 0, updatedAt: 0, parentFolderId };
}

describe('page reference sources', () => {
  it('scopes `@` by where the editor is', () => {
    expect(referenceContextOf('collab://org:o:doc:d')).toBe('team');
    expect(referenceContextOf('personal-doc://p1')).toBe('personal');
    expect(referenceContextOf('personal-doc://tracker-content/item-1')).toBe('personal');
    expect(referenceContextOf('/ws/docs/notes.md')).toBe('local');
    expect(referenceContextOf('C:\\ws\\notes.md')).toBe('local');
    expect(referenceContextOf('virtual://shared-home')).toBe('other');
    expect(referenceContextOf(null)).toBe('other');
    // A typed page's body is not itself a page that could be listed.
    expect(personalPageIdOf('personal-doc://tracker-content/item-1')).toBeNull();
  });

  it('lists Personal pages by their console link, under their parent pages, without the current one', () => {
    const options = personalPageReferenceOptions({
      documents: [page('home', 'Home'), page('design', 'Design', 'home'), { ...page('drawing', 'Architecture', 'design'), documentType: 'excalidraw' }],
      currentDocumentId: 'home',
    });
    expect(options.map((o) => o.documentId)).toEqual(['design', 'drawing']);
    const drawing = options.find((o) => o.documentId === 'drawing')!;
    expect(drawing.folderPath).toBe('Home/Design');
    // Its type travels with the link, so the drawing embeds.
    expect(drawing.embedType).toBe('.excalidraw');
    expect(isPersonalPageLink(drawing.target)).toBe(true);
    expect(isPersonalPageLink('https://console.nimbalyst.com/org/o/project/p/document/d')).toBe(false);
  });

  it('opens a local file\'s Team and Personal references through their own openers', () => {
    const openTeam = vi.fn();
    const openPersonal = vi.fn();
    const source = localFileReferenceSource({ listTeam: () => [], listPersonal: () => [], openTeam, openPersonal });
    const personal = personalPageReferenceOptions({ documents: [page('p1', 'Mine')] })[0]!.target;

    expect(source.includeLocalFiles).toBe(true);
    expect(source.ownsTarget!(personal)).toBe(true);
    expect(source.ownsTarget!('nimbalyst://doc/d1?orgId=o')).toBe(true);
    expect(source.ownsTarget!('docs/notes.md')).toBe(false);
    source.openReference(personal);
    source.openReference('nimbalyst://doc/d1?orgId=o');
    expect(openPersonal).toHaveBeenCalledWith(personal, undefined);
    expect(openTeam).toHaveBeenCalledWith('nimbalyst://doc/d1?orgId=o', undefined);
  });

  it('opens a link to another Local wiki page as that page, not as a file', () => {
    const openPersonal = vi.fn();
    const source = localFileReferenceSource({
      listTeam: () => [],
      listPersonal: () => [],
      openTeam: vi.fn(),
      openPersonal,
      wikiPageFor: (target) => (target === 'Product.md' ? 'product-id' : null),
    });

    expect(source.ownsTarget!('Product.md')).toBe(true);
    // A file outside the wiki still opens as a file.
    expect(source.ownsTarget!('../spec/tech.md')).toBe(false);
    source.openReference('Product.md', { newTab: false });
    expect(openPersonal).toHaveBeenCalledWith(personalPageReferenceOptions({ documents: [page('product-id', 'Product')] })[0]!.target, { newTab: false });
  });
});
