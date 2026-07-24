import { describe, expect, it } from 'vitest';

import {
  buildImportedDocumentReference,
  exportDocumentLinkHref,
  resolveDocumentLinkLookupPath,
} from '../documentLinkPaths';

describe('documentLinkPaths', () => {
  it('preserves the authored markdown label and does not invent a document id for imported links', () => {
    expect(
      buildImportedDocumentReference('Spec', './docs/other-doc.md'),
    ).toEqual({
      documentId: '',
      name: 'Spec',
      path: './docs/other-doc.md',
    });
  });

  it('preserves bare workspace-relative hrefs on export', () => {
    expect(exportDocumentLinkHref('docs/other-doc.md')).toBe('docs/other-doc.md');
  });

  it('resolves same-directory relative links against the current document path', () => {
    expect(
      resolveDocumentLinkLookupPath(
        './other-doc.md',
        '/workspace/docs/readme.md',
        '/workspace',
      ),
    ).toBe('docs/other-doc.md');
  });

  it('resolves parent-directory links on Windows-style paths', () => {
    expect(
      resolveDocumentLinkLookupPath(
        '../other-doc.md',
        'C:\\workspace\\docs\\guides\\readme.md',
        'C:\\workspace',
      ),
    ).toBe('docs/other-doc.md');
  });
});
