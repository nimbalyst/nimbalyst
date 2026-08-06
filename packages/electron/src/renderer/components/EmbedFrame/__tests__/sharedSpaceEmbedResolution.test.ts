import { describe, expect, it } from 'vitest';

import type { SharedDocument, SharedFolder } from '../../../store/atoms/collabDocuments';
import { resolveSharedSpaceEmbedReference } from '../sharedSpaceEmbedResolution';

const ORG_ID = 'organization-live-6bf853c3';

function makeDocument(overrides: Partial<SharedDocument> & { documentId: string; title: string }): SharedDocument {
  return {
    teamProjectId: null,
    documentType: 'mockup',
    fileExtension: '.mockup.html',
    editorId: 'com.nimbalyst.mockuplm',
    createdBy: 'user-1',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('resolveSharedSpaceEmbedReference', () => {
  it('resolves a workspace-relative link against a legacy path-in-title shared document', () => {
    const documents: SharedDocument[] = [
      makeDocument({
        documentId: 'doc-expand-button',
        title: 'nimbalyst-local/mockups/tracker-expand-to-shared-doc-button.mockup.html',
      }),
    ];

    expect(
      resolveSharedSpaceEmbedReference({
        src: 'nimbalyst-local/mockups/tracker-expand-to-shared-doc-button.mockup.html',
        hostOrgId: ORG_ID,
        documents,
        folders: [] as SharedFolder[],
      }),
    ).toEqual({ documentId: 'doc-expand-button', orgId: ORG_ID });
  });

  it('treats a ./-prefixed link as naming the same shared document', () => {
    const documents = [makeDocument({ documentId: 'doc-a', title: 'mockups/panel.mockup.html' })];

    expect(
      resolveSharedSpaceEmbedReference({
        src: './mockups/panel.mockup.html',
        hostOrgId: ORG_ID,
        documents,
        folders: [],
      }),
    ).toEqual({ documentId: 'doc-a', orgId: ORG_ID });
  });

  it('resolves against a first-class folder path', () => {
    const folders: SharedFolder[] = [
      {
        folderId: 'folder-mockups',
        parentFolderId: null,
        name: 'mockups',
        sortOrder: 0,
        createdBy: 'user-1',
        createdAt: 0,
        updatedAt: 0,
      },
    ];
    const documents = [
      makeDocument({
        documentId: 'doc-b',
        title: 'panel.mockup.html',
        parentFolderId: 'folder-mockups',
      }),
    ];

    expect(
      resolveSharedSpaceEmbedReference({
        src: 'mockups/panel.mockup.html',
        hostOrgId: ORG_ID,
        documents,
        folders,
      }),
    ).toEqual({ documentId: 'doc-b', orgId: ORG_ID });
  });

  it('falls back to a unique basename match when the shared doc lives elsewhere', () => {
    const documents = [
      makeDocument({ documentId: 'doc-c', title: 'design/archive/panel.mockup.html' }),
    ];

    expect(
      resolveSharedSpaceEmbedReference({
        src: 'nimbalyst-local/mockups/panel.mockup.html',
        hostOrgId: ORG_ID,
        documents,
        folders: [],
      }),
    ).toEqual({ documentId: 'doc-c', orgId: ORG_ID });
  });

  it('prefers an exact path match over a same-named document in another folder', () => {
    const documents = [
      makeDocument({ documentId: 'doc-other', title: 'design/archive/panel.mockup.html' }),
      makeDocument({ documentId: 'doc-exact', title: 'mockups/panel.mockup.html' }),
    ];

    expect(
      resolveSharedSpaceEmbedReference({
        src: 'mockups/panel.mockup.html',
        hostOrgId: ORG_ID,
        documents,
        folders: [],
      }),
    ).toEqual({ documentId: 'doc-exact', orgId: ORG_ID });
  });

  it('refuses to guess when the basename is ambiguous', () => {
    const documents = [
      makeDocument({ documentId: 'doc-d', title: 'a/panel.mockup.html' }),
      makeDocument({ documentId: 'doc-e', title: 'b/panel.mockup.html' }),
    ];

    expect(
      resolveSharedSpaceEmbedReference({
        src: 'mockups/panel.mockup.html',
        hostOrgId: ORG_ID,
        documents,
        folders: [],
      }),
    ).toBeNull();
  });

  it('ignores trashed and undecryptable shared documents', () => {
    const documents = [
      makeDocument({
        documentId: 'doc-trashed',
        title: 'mockups/panel.mockup.html',
        trashedAt: 1,
      }),
      makeDocument({
        documentId: 'doc-locked',
        title: 'mockups/other.mockup.html',
        decryptFailed: true,
      }),
    ];

    expect(
      resolveSharedSpaceEmbedReference({
        src: 'mockups/panel.mockup.html',
        hostOrgId: ORG_ID,
        documents,
        folders: [],
      }),
    ).toBeNull();
  });

  it.each([
    ['an absolute path', '/Users/someone/mockups/panel.mockup.html'],
    ['an explicit shared-document URI', 'nimbalyst://doc/abc?orgId=xyz'],
    ['a web URL', 'https://example.com/panel.mockup.html'],
    ['a parent-relative path', '../mockups/panel.mockup.html'],
    ['an empty target', ''],
  ])('does not resolve %s', (_label, src) => {
    const documents = [makeDocument({ documentId: 'doc-f', title: 'mockups/panel.mockup.html' })];

    expect(
      resolveSharedSpaceEmbedReference({ src, hostOrgId: ORG_ID, documents, folders: [] }),
    ).toBeNull();
  });

  it('does not resolve when the host document is not a shared document', () => {
    const documents = [makeDocument({ documentId: 'doc-g', title: 'mockups/panel.mockup.html' })];

    expect(
      resolveSharedSpaceEmbedReference({
        src: 'mockups/panel.mockup.html',
        hostOrgId: null,
        documents,
        folders: [],
      }),
    ).toBeNull();
  });
});
