import { describe, expect, it } from 'vitest';
import {
  buildCollabTree,
  buildCollabTreeAdaptive,
  buildCollabTreeFromFolders,
  computeLegacyFolderRenameUpdates,
  filterCollabTree,
  flattenCollabFolderOptions,
  getCollabDocumentPath,
  getSharedDocumentDisplayPathWithFallback,
  getSharedDocumentDisplayPath,
  getCollabNodeName,
  getCollabParentPath,
  joinCollabPath,
  normalizeCollabPath,
  reconcileSharedDocumentDisplayName,
  renameCollabDocumentPath,
  resolveCollabCreateTargetFolderId,
} from '../collabTree';
import type { SharedDocument, SharedFolder } from '../../../store/atoms/collabDocuments';

function makeDocument(
  documentId: string,
  title: string,
  updatedAt = 1,
  parentFolderId: string | null = null,
): SharedDocument {
  return {
    documentId,
    title,
    documentType: 'markdown',
    createdBy: 'user-1',
    createdAt: updatedAt,
    updatedAt,
    parentFolderId,
  };
}

function makeFolder(
  folderId: string,
  name: string,
  parentFolderId: string | null = null,
  sortOrder = 0,
): SharedFolder {
  return {
    folderId,
    name,
    parentFolderId,
    sortOrder,
    createdBy: 'user-1',
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('collabTree', () => {
  describe('create location options', () => {
    it('lists Root first and flattens folders by depth with alphabetical siblings', () => {
      const options = flattenCollabFolderOptions([
        makeFolder('f-zebra', 'Zebra'),
        makeFolder('f-api', 'API', 'f-specs'),
        makeFolder('f-specs', 'Specs'),
        makeFolder('f-archive', 'Archive', 'f-specs'),
        makeFolder('f-alpha', 'Alpha'),
      ]);

      expect(options).toEqual([
        { folderId: null, name: 'Root', depth: 0 },
        { folderId: 'f-alpha', name: 'Alpha', depth: 0 },
        { folderId: 'f-specs', name: 'Specs', depth: 0 },
        { folderId: 'f-api', name: 'API', depth: 1 },
        { folderId: 'f-archive', name: 'Archive', depth: 1 },
        { folderId: 'f-zebra', name: 'Zebra', depth: 0 },
      ]);
    });

    it('keeps orphaned and cyclic folders selectable without looping', () => {
      const options = flattenCollabFolderOptions([
        makeFolder('f-orphan', 'Orphan', 'f-missing'),
        makeFolder('f-a', 'A', 'f-b'),
        makeFolder('f-b', 'B', 'f-a'),
      ]);

      expect(options[0]).toEqual({ folderId: null, name: 'Root', depth: 0 });
      expect(options.slice(1).map(option => option.folderId).sort()).toEqual([
        'f-a',
        'f-b',
        'f-orphan',
      ]);
    });

    it('seeds from the context folder, then selection, then Root', () => {
      expect(resolveCollabCreateTargetFolderId('f-context', 'f-selected')).toBe('f-context');
      expect(resolveCollabCreateTargetFolderId(undefined, 'f-selected')).toBe('f-selected');
      expect(resolveCollabCreateTargetFolderId(undefined, null)).toBeNull();
      expect(resolveCollabCreateTargetFolderId(null, 'f-selected')).toBeNull();
    });
  });

  it('normalizes collab paths consistently', () => {
    expect(normalizeCollabPath(' /Specs//API Spec  ')).toBe('Specs/API Spec');
    expect(normalizeCollabPath('Specs\\Deprecated\\Auth')).toBe('Specs/Deprecated/Auth');
    expect(normalizeCollabPath('')).toBe('');
  });

  it('joins and splits folder paths', () => {
    expect(joinCollabPath('Specs/Deprecated', 'Auth')).toBe('Specs/Deprecated/Auth');
    expect(getCollabParentPath('Specs/Deprecated/Auth')).toBe('Specs/Deprecated');
    expect(getCollabParentPath('Specs')).toBeNull();
    expect(getCollabNodeName('Specs/Deprecated/Auth')).toBe('Auth');
  });

  it('renames a document while preserving its parent folder', () => {
    expect(renameCollabDocumentPath('Specs/Deprecated/Auth', 'Legacy Auth')).toBe('Specs/Deprecated/Legacy Auth');
    expect(renameCollabDocumentPath('Roadmap', 'Q2 Roadmap')).toBe('Q2 Roadmap');
  });

  it('builds nested folders from slash-delimited document titles', () => {
    const tree = buildCollabTree([
      makeDocument('doc-1', 'Specs/API Spec'),
      makeDocument('doc-2', 'Specs/Deprecated/Legacy Auth'),
      makeDocument('doc-3', 'RFCs/Auth Redesign'),
    ], []);

    expect(tree).toHaveLength(2);
    expect(tree[0]).toMatchObject({ type: 'folder', path: 'RFCs' });
    expect(tree[1]).toMatchObject({ type: 'folder', path: 'Specs' });

    const specsFolder = tree[1];
    if (specsFolder.type !== 'folder') {
      throw new Error('Expected folder');
    }

    expect(specsFolder.children).toHaveLength(2);
    expect(specsFolder.children[0]).toMatchObject({
      type: 'folder',
      path: 'Specs/Deprecated',
    });
    expect(specsFolder.children[1]).toMatchObject({
      type: 'document',
      path: 'Specs/API Spec',
      name: 'API Spec',
    });
  });

  it('keeps explicit empty folders even without documents', () => {
    const tree = buildCollabTree([], ['Architecture', 'Specs/Deprecated']);

    expect(tree).toHaveLength(2);
    expect(tree[0]).toMatchObject({ type: 'folder', path: 'Architecture' });
    expect(tree[1]).toMatchObject({ type: 'folder', path: 'Specs' });

    const specsFolder = tree[1];
    if (specsFolder.type !== 'folder') {
      throw new Error('Expected folder');
    }

    expect(specsFolder.children[0]).toMatchObject({
      type: 'folder',
      path: 'Specs/Deprecated',
    });
  });

  it('falls back to document id when title is empty', () => {
    const document = makeDocument('doc-123', '');
    expect(getCollabDocumentPath(document)).toBe('doc-123');
  });

  it('derives a title-safe display path from first-class folders', () => {
    const document = makeDocument('1af74157-fe92-481b', 'Architecture Plan', 1, 'f-auth');
    const folders = [
      makeFolder('f-specs', 'Specs'),
      makeFolder('f-auth', 'Auth', 'f-specs'),
    ];

    expect(getSharedDocumentDisplayPath(document, folders)).toBe('Specs/Auth/Architecture Plan');
  });

  it('uses a neutral placeholder instead of a document id while the title is unresolved', () => {
    const document = makeDocument('1af74157-fe92-481b', '');
    expect(getSharedDocumentDisplayPath(document, [])).toBe('Shared document');
  });

  it('preserves a known tab name while a newer title is unresolved', () => {
    expect(reconcileSharedDocumentDisplayName(
      'Architecture Plan',
      '',
      '1af74157-fe92-481b',
    )).toBe('Architecture Plan');
    expect(reconcileSharedDocumentDisplayName(
      '1af74157-fe92-481b',
      '',
      '1af74157-fe92-481b',
    )).toBe('Shared document');
  });

  it('preserves a restored path until its first-class folder metadata resolves', () => {
    const document = makeDocument('doc-123', 'Architecture Plan', 1, 'f-auth');
    expect(getSharedDocumentDisplayPathWithFallback(
      document,
      [],
      'Specs/Auth/Architecture Plan',
    )).toBe('Specs/Auth/Architecture Plan');

    expect(getSharedDocumentDisplayPathWithFallback(
      document,
      [makeFolder('f-auth', 'Auth')],
      'Specs/Auth/Architecture Plan',
    )).toBe('Auth/Architecture Plan');
  });

  it('filters documents by query while preserving matching ancestors', () => {
    const tree = buildCollabTree([
      makeDocument('doc-1', 'Specs/API Spec'),
      makeDocument('doc-2', 'Specs/Deprecated/Legacy Auth'),
      makeDocument('doc-3', 'RFCs/Auth Redesign'),
    ], []);

    const filtered = filterCollabTree(tree, 'auth');

    expect(filtered).toHaveLength(2);
    expect(filtered[0]).toMatchObject({ type: 'folder', path: 'RFCs' });
    expect(filtered[1]).toMatchObject({ type: 'folder', path: 'Specs' });

    const specsFolder = filtered[1];
    if (specsFolder.type !== 'folder') {
      throw new Error('Expected folder');
    }

    expect(specsFolder.children).toHaveLength(1);
    expect(specsFolder.children[0]).toMatchObject({
      type: 'folder',
      path: 'Specs/Deprecated',
    });
  });

  it('keeps full folder contents when the folder path matches the query', () => {
    const tree = buildCollabTree([
      makeDocument('doc-1', 'Specs/API Spec'),
      makeDocument('doc-2', 'Specs/Deprecated/Legacy Auth'),
      makeDocument('doc-3', 'RFCs/Auth Redesign'),
    ], []);

    const filtered = filterCollabTree(tree, 'specs');

    expect(filtered).toHaveLength(1);
    expect(filtered[0]).toMatchObject({ type: 'folder', path: 'Specs' });

    const specsFolder = filtered[0];
    if (specsFolder.type !== 'folder') {
      throw new Error('Expected folder');
    }

    expect(specsFolder.children).toHaveLength(2);
    expect(specsFolder.children[0]).toMatchObject({
      type: 'folder',
      path: 'Specs/Deprecated',
    });
    expect(specsFolder.children[1]).toMatchObject({
      type: 'document',
      path: 'Specs/API Spec',
    });
  });

  describe('buildCollabTreeFromFolders (first-class folders)', () => {
    it('builds nested folders from real folder nodes + parentFolderId', () => {
      const folders = [
        makeFolder('f-specs', 'Specs'),
        makeFolder('f-deprecated', 'Deprecated', 'f-specs'),
        makeFolder('f-rfcs', 'RFCs'),
      ];
      const documents = [
        makeDocument('doc-1', 'API Spec', 1, 'f-specs'),
        makeDocument('doc-2', 'Legacy Auth', 1, 'f-deprecated'),
        makeDocument('doc-3', 'Auth Redesign', 1, 'f-rfcs'),
      ];

      const tree = buildCollabTreeFromFolders(documents, folders);
      expect(tree).toHaveLength(2);
      expect(tree[0]).toMatchObject({ type: 'folder', folderId: 'f-rfcs', path: 'RFCs' });
      expect(tree[1]).toMatchObject({ type: 'folder', folderId: 'f-specs', path: 'Specs' });

      const specs = tree[1];
      if (specs.type !== 'folder') throw new Error('Expected folder');
      expect(specs.children).toHaveLength(2);
      // Folders sort before documents.
      expect(specs.children[0]).toMatchObject({ type: 'folder', folderId: 'f-deprecated', path: 'Specs/Deprecated' });
      expect(specs.children[1]).toMatchObject({ type: 'document', name: 'API Spec', path: 'Specs/API Spec' });
    });

    it('keeps empty first-class folders with no documents', () => {
      const tree = buildCollabTreeFromFolders([], [makeFolder('f-arch', 'Architecture')]);
      expect(tree).toHaveLength(1);
      expect(tree[0]).toMatchObject({ type: 'folder', folderId: 'f-arch', name: 'Architecture' });
      if (tree[0].type !== 'folder') throw new Error('Expected folder');
      expect(tree[0].children).toHaveLength(0);
    });

    it('reduces a dual-write full-path title to its leaf name', () => {
      // During dual-write a new client also writes the full-path title.
      const tree = buildCollabTreeFromFolders(
        [makeDocument('doc-1', 'Specs/API Spec', 1, 'f-specs')],
        [makeFolder('f-specs', 'Specs')],
      );
      const specs = tree[0];
      if (specs.type !== 'folder') throw new Error('Expected folder');
      expect(specs.children[0]).toMatchObject({ type: 'document', name: 'API Spec' });
    });

    it('places documents with a missing parent folder at root', () => {
      const tree = buildCollabTreeFromFolders(
        [makeDocument('doc-orphan', 'Orphan', 1, 'f-gone')],
        [],
      );
      expect(tree).toHaveLength(1);
      expect(tree[0]).toMatchObject({ type: 'document', name: 'Orphan' });
    });

    it('does not infinite-loop on a corrupt parent cycle', () => {
      const folders = [
        makeFolder('f-a', 'A', 'f-b'),
        makeFolder('f-b', 'B', 'f-a'),
      ];
      // Should return without hanging; both folders reference each other.
      const tree = buildCollabTreeFromFolders([], folders);
      expect(Array.isArray(tree)).toBe(true);
    });
  });

  describe('buildCollabTreeAdaptive (graceful legacy transition)', () => {
    it('REGRESSION: keeps folders visible for a legacy path-in-title dataset before migration', () => {
      // Reproduces the "Shared Items shows NO folders" regression: legacy docs
      // encode their structure in the TITLE and still have parentFolderId=null,
      // and no first-class folder rows exist yet. The first-class-only builder
      // collapses these to a flat root list; the adaptive builder must fall back
      // to the path-in-title builder so folders never disappear.
      const documents = [
        makeDocument('doc-1', 'Specs/API Spec'),
        makeDocument('doc-2', 'Specs/Deprecated/Legacy Auth'),
        makeDocument('doc-3', 'RFCs/Auth Redesign'),
      ];

      // No first-class folder rows yet (migration not completed / not round-tripped).
      const tree = buildCollabTreeAdaptive(documents, []);

      // Folders must survive, not collapse to a flat root document list.
      expect(tree).toHaveLength(2);
      expect(tree[0]).toMatchObject({ type: 'folder', path: 'RFCs' });
      expect(tree[1]).toMatchObject({ type: 'folder', path: 'Specs' });
    });

    it('uses first-class folders once folder rows exist', () => {
      const folders = [makeFolder('f-specs', 'Specs')];
      const documents = [makeDocument('doc-1', 'API Spec', 1, 'f-specs')];

      const tree = buildCollabTreeAdaptive(documents, folders);
      expect(tree).toHaveLength(1);
      expect(tree[0]).toMatchObject({ type: 'folder', folderId: 'f-specs', path: 'Specs' });
    });

    it('uses first-class builder when no folders and no path-in-title docs (flat root)', () => {
      const documents = [makeDocument('doc-1', 'Standalone Doc')];
      const tree = buildCollabTreeAdaptive(documents, []);
      expect(tree).toHaveLength(1);
      expect(tree[0]).toMatchObject({ type: 'document', name: 'Standalone Doc' });
    });

    it('prefers first-class folders even if a doc title still contains a slash (dual-write)', () => {
      // A doc already migrated (parentFolderId set) whose title is still a full
      // path must NOT trigger the legacy fallback once real folder rows exist.
      const folders = [makeFolder('f-specs', 'Specs')];
      const documents = [makeDocument('doc-1', 'Specs/API Spec', 1, 'f-specs')];
      const tree = buildCollabTreeAdaptive(documents, folders);
      expect(tree[0]).toMatchObject({ type: 'folder', folderId: 'f-specs' });
    });
  });

  describe('computeLegacyFolderRenameUpdates (rename path-in-title folders)', () => {
    const documents = [
      makeDocument('d1', 'Specs/API Spec'),
      makeDocument('d2', 'Specs/Deprecated/Legacy Auth'),
      makeDocument('d3', 'RFCs/Auth Redesign'),
      makeDocument('d4', 'Specset/Not A Match'), // sibling prefix, must NOT match
    ];

    it('rewrites the folder segment across all descendant document titles', () => {
      const updates = computeLegacyFolderRenameUpdates(documents, 'Specs', 'Specifications');
      const byId = new Map(updates.map(u => [u.documentId, u.newTitle]));
      expect(byId.get('d1')).toBe('Specifications/API Spec');
      expect(byId.get('d2')).toBe('Specifications/Deprecated/Legacy Auth');
      // Untouched: different top folder and a sibling prefix ("Specset").
      expect(byId.has('d3')).toBe(false);
      expect(byId.has('d4')).toBe(false);
    });

    it('renames a nested folder while preserving its parent path', () => {
      const updates = computeLegacyFolderRenameUpdates(documents, 'Specs/Deprecated', 'Archive');
      expect(updates).toEqual([{ documentId: 'd2', newTitle: 'Specs/Archive/Legacy Auth' }]);
    });

    it('returns no updates for a blank or unchanged name', () => {
      expect(computeLegacyFolderRenameUpdates(documents, 'Specs', '  ')).toEqual([]);
      expect(computeLegacyFolderRenameUpdates(documents, 'Specs', 'Specs')).toEqual([]);
    });
  });
});
