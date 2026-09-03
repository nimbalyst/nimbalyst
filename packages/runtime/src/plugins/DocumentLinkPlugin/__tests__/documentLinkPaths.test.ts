import { describe, expect, it } from 'vitest';

import {
  buildImportedDocumentReference,
  exportDocumentLinkHref,
  resolveDocumentLinkLookupPaths,
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
      resolveDocumentLinkLookupPaths(
        './other-doc.md',
        '/workspace/docs/readme.md',
        '/workspace',
      ),
    ).toEqual(['docs/other-doc.md']);
  });

  it('resolves parent-directory links on Windows-style paths', () => {
    expect(
      resolveDocumentLinkLookupPaths(
        '../other-doc.md',
        'C:\\workspace\\docs\\guides\\readme.md',
        'C:\\workspace',
      ),
    ).toEqual(['docs/other-doc.md']);
  });

  it('tries a bare sibling href next to the document before the workspace root', () => {
    // Markdown authors write `[x](sibling.md)`, not `./sibling.md`; resolving
    // that only against the workspace root made every such link a silent no-op.
    expect(
      resolveDocumentLinkLookupPaths(
        'animation-diff.anim.json',
        'marketing/calendar.md',
        '/workspace',
      ),
    ).toEqual([
      'marketing/animation-diff.anim.json',
      'animation-diff.anim.json',
    ]);
  });

  it('keeps the workspace-root candidate for bare hrefs stored by reference chips', () => {
    // `@` mention chips export workspace-relative paths with no `./` prefix.
    expect(
      resolveDocumentLinkLookupPaths(
        'docs/other-doc.md',
        'docs/readme.md',
        '/workspace',
      ),
    ).toContain('docs/other-doc.md');
  });
});
