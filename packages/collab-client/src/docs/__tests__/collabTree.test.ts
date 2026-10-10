// @vitest-environment node

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
  getSharedDocumentDisplayName,
  UNRESOLVED_SHARED_DOCUMENT_NAME,
  getCollabNodeName,
  getCollabParentPath,
  joinCollabPath,
  normalizeCollabPath,
  reconcileSharedDocumentDisplayName,
  renameCollabDocumentPath,
  resolveCollabCreateTargetFolderId,
  pruneEmptyFolders,
  pageDisplayName,
  projectPagesAsFolders,
  type CollabTreeDocumentNode,
  type CollabTreeFolderNode,
  type CollabTreeItemNode,
  type CollabTreeNode,
  type CollabTreeTypeNode,
  type CollabTypeTreeResolver,
} from '../collabTree';
import { pageTreeAncestorRefs, pageTreeAncestors } from '../../trackers-ui/embed/pageTreeAncestors';
import { buildCollabPageTree, buildCollabTreeForScope, nextSiblingOrder, pageTreeDropZone, planPageTreeDrop, treeMoveRefused, typeWithSubtypes } from '../collabPageTree';
import type { SharedDocument, SharedFolder, SharedItemPlacement, SharedTypePlacement } from '../types';

function makeDocument(
  documentId: string,
  title: string,
  updatedAt = 1,
  parentFolderId: string | null = null,
): SharedDocument {
  return {
    documentId,
    teamProjectId: null,
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

  describe('getSharedDocumentDisplayName never leaks the transport id', () => {
    // A shared doc whose title has not resolved yet -- or whose title is
    // pre-cutover ciphertext no client can read -- must fall back to a plain
    // label. Showing the raw document id in the tab was NIM-1641; the guard
    // that fixed it had no coverage, so it could regress silently.
    const ID = '4b37906e-fffd-455f-bd6e-0b3d57f0766e';

    it.each([
      ['title missing', undefined],
      ['title null', null],
      ['title blank', '   '],
      ['title is the id itself', ID],
      ['title is the id with path noise', `/${ID}/`],
    ])('%s -> generic label', (_label, title) => {
      expect(getSharedDocumentDisplayName(title, ID)).toBe(UNRESOLVED_SHARED_DOCUMENT_NAME);
    });

    it('shows a page by its bare name, whatever path or ".md" its stored title carries', () => {
      expect(pageDisplayName('Specs/Child.md', 'markdown')).toBe('Child');
      expect(pageDisplayName('Child', 'markdown')).toBe('Child');
      expect(pageDisplayName('Budget.calc.md', 'calc.md')).toBe('Budget.calc.md');
      expect(pageDisplayName('Specs/Architecture.md', 'markdown')).toBe('Architecture');
    });

    it('uses the leaf name when a real title is present', () => {
      expect(getSharedDocumentDisplayName('Specs/API Spec', ID)).toBe('API Spec');
    });
  });

  describe('placed tracker types', () => {
    const placement = (typeId: string, parentFolderId: string | null, sortOrder = 0): SharedTypePlacement => ({
      typeId,
      projectId: null,
      parentFolderId,
      sortOrder,
      createdBy: 'user-1',
      createdAt: 1,
      updatedAt: 1,
    });
    const types: Record<string, { name: string; extends?: string; items: string[] }> = {
      module: { name: 'Modules', items: ['Tracking', 'Identity'] },
      technology: { name: 'Technologies', items: ['Cloudflare'] },
      library: { name: 'Libraries', extends: 'technology', items: ['Yjs'] },
      competitor: { name: 'Competitors', items: [] },
    };
    const resolver: CollabTypeTreeResolver = {
      typeName: (typeId) => types[typeId]?.name ?? null,
      typeExtends: (typeId) => types[typeId]?.extends ?? null,
      itemsOfType: (typeId) => (types[typeId]?.items ?? []).map((title) => ({ itemId: `${typeId}-${title}`, title })),
    };

    it('places types after folders and before documents, by sortOrder, with items in resolver order', () => {
      const tree = buildCollabTreeFromFolders(
        [makeDocument('d-root', 'Readme'), makeDocument('d-spec', 'Architecture', 1, 'f-spec')],
        [makeFolder('f-spec', 'Spec')],
        {
          placements: [
            placement('competitor', null, 2),
            placement('technology', null, 1),
            placement('module', 'f-spec'),
            placement('ghost', null),
          ],
          resolver,
        },
      );

      expect(tree.map((node) => node.id)).toEqual([
        'folder:f-spec',
        'type:technology',
        'type:competitor',
        'document:d-root',
      ]);
      const spec = tree[0] as CollabTreeFolderNode;
      expect(spec.children.map((node) => node.id)).toEqual(['type:module', 'document:d-spec']);
      const modules = spec.children[0] as CollabTreeTypeNode;
      expect(modules).toMatchObject({ name: 'Modules', path: 'Spec/Modules', count: 2 });
      expect(modules.children.map((node) => node.name)).toEqual(['Tracking', 'Identity']);
      expect(modules.children[0]).toMatchObject({ type: 'item', itemId: 'module-Tracking', typeId: 'module', path: 'Spec/Modules/Tracking' });
    });

    it('nests a placed subtype inside its placed base type', () => {
      const tree = buildCollabTreeFromFolders([], [makeFolder('f-spec', 'Spec')], {
        placements: [placement('library', 'f-spec'), placement('technology', null)],
        resolver,
      });

      expect(tree.map((node) => node.id)).toEqual(['folder:f-spec', 'type:technology']);
      expect((tree[0] as CollabTreeFolderNode).children).toEqual([]);
      const technologies = tree[1] as CollabTreeTypeNode;
      expect(technologies.count).toBe(1);
      expect(technologies.children.map((node) => node.id)).toEqual(['type:library', 'item:technology-Cloudflare']);
      expect(technologies.children[0].path).toBe('Technologies/Libraries');
    });

    it('counts subtype items in a page-tree type row, placed or not', () => {
      const listed = { ...resolver, listedTypes: () => Object.entries(types).map(([typeId, type]) => ({ typeId, name: type.name })) };
      const tree = buildCollabPageTree([], { typePlacements: [placement('technology', null)], resolver: listed });
      expect((tree[0] as CollabTreeTypeNode).count).toBe(2);
      expect(typeWithSubtypes('technology', listed)).toEqual(['technology', 'library']);
    });

    it('keeps a type node when only one of its items matches the filter', () => {
      const tree = buildCollabTreeAdaptive([makeDocument('d-1', 'Notes')], [], {
        placements: [placement('module', null), placement('competitor', null)],
        resolver,
      });

      const filtered = filterCollabTree(tree, 'identity');
      expect(filtered).toHaveLength(1);
      const modules = filtered[0] as CollabTreeTypeNode;
      expect(modules.id).toBe('type:module');
      expect(modules.children.map((node) => node.name)).toEqual(['Identity']);
      expect(pruneEmptyFolders(tree).map((node) => node.id)).toContain('type:competitor');
    });
  });

  describe('one page tree (pageTree snapshots)', () => {
    const typePlacement = (typeId: string, parentFolderId: string | null): SharedTypePlacement => ({
      typeId, projectId: null, parentFolderId, sortOrder: 0, createdBy: 'u', createdAt: 1, updatedAt: 1,
    });
    const itemPlacement = (itemId: string, parentId: string | null): SharedItemPlacement => ({
      itemId, projectId: null, parentId, sortOrder: 0, createdBy: 'u', createdAt: 1, updatedAt: 1,
    });
    const items: Record<string, { typeId: string; title: string }> = {
      'mod-sync': { typeId: 'module', title: 'Sync engine' },
      'mod-tracker': { typeId: 'module', title: 'Tracker engine' },
      'lib-yjs': { typeId: 'library', title: 'Yjs' },
    };
    const resolver: CollabTypeTreeResolver = {
      typeName: (typeId) => ({ module: 'Modules', library: 'Libraries' } as Record<string, string>)[typeId] ?? null,
      typeLabel: (typeId) => ({ module: 'Module', library: 'Library' } as Record<string, string>)[typeId] ?? null,
      itemsOfType: (typeId) => Object.entries(items)
        .filter(([, item]) => item.typeId === typeId)
        .map(([itemId, item]) => ({ itemId, title: item.title })),
      item: (itemId) => (items[itemId] ? { itemId, ...items[itemId] } : null),
    };
    const ids = (nodes: CollabTreeNode[]) => nodes.map((node) => node.id);
    const childrenOf = (node: CollabTreeNode | undefined) =>
      (node && 'children' in node ? node.children ?? [] : []) as CollabTreeNode[];

    it('nests pages under pages, with paths from the page chain', () => {
      const tree = buildCollabPageTree([
        makeDocument('arch', 'Architecture'),
        makeDocument('overview', 'Overview', 1, 'arch'),
        makeDocument('deep', 'Specs/Deep', 1, 'overview'),
      ]);
      expect(ids(tree)).toEqual(['document:arch']);
      const overview = childrenOf(tree[0])[0] as CollabTreeDocumentNode;
      expect(overview).toMatchObject({ id: 'document:overview', path: 'Architecture/Overview' });
      // A legacy full-path title contributes only its leaf.
      expect(childrenOf(overview)[0]).toMatchObject({ name: 'Deep', path: 'Architecture/Overview/Deep' });
    });

    it('shows a placed item under its page and an unplaced one under its type', () => {
      const tree = buildCollabPageTree(
        [makeDocument('arch', 'Architecture'), makeDocument('overview', 'Overview', 1, 'arch')],
        {
          resolver,
          typePlacements: [typePlacement('module', 'arch')],
          itemPlacements: [itemPlacement('mod-sync', 'overview')],
        },
      );
      const arch = tree[0];
      expect(ids(childrenOf(arch))).toEqual(['type:module', 'document:overview']);
      const modules = childrenOf(arch)[0] as CollabTreeTypeNode;
      // The type's count is every item of the type, wherever it lives.
      expect(modules.count).toBe(2);
      expect(ids(modules.children)).toEqual(['item:mod-tracker']);
      const placed = childrenOf(childrenOf(arch)[1])[0] as CollabTreeItemNode;
      expect(placed).toMatchObject({
        id: 'item:mod-sync', itemId: 'mod-sync', typeId: 'module', name: 'Sync engine',
        typeLabel: 'Module', placed: true, path: 'Architecture/Overview/Sync engine',
      });
    });

    it('roots an item placed at root and leaves one with a missing page under its type', () => {
      const tree = buildCollabPageTree([], {
        resolver,
        typePlacements: [typePlacement('module', null)],
        itemPlacements: [itemPlacement('mod-sync', null), itemPlacement('mod-tracker', 'gone')],
      });
      expect(ids(tree)).toEqual(['type:module', 'item:mod-sync']);
      expect(ids((tree[0] as CollabTreeTypeNode).children)).toEqual(['item:mod-tracker']);
    });

    it('names pages bare in rows, paths and the pages-as-folders list', () => {
      const docs = [makeDocument('arch', 'Specs/Architecture.md'), makeDocument('child', 'Child.md', 1, 'arch')];
      const tree = buildCollabPageTree(docs);
      expect(childrenOf(tree[0])[0]).toMatchObject({ name: 'Child', path: 'Architecture/Child' });
      expect(projectPagesAsFolders(docs).map((folder) => folder.name)).toEqual(['Architecture', 'Child']);
    });

    it('never shows a type-page document as a row', () => {
      const docs = [makeDocument('type-page:module', 'Modules'), makeDocument('notes', 'Notes')];
      expect(ids(buildCollabPageTree(docs))).toEqual(['document:notes']);
      expect(projectPagesAsFolders(docs).map((folder) => folder.folderId)).toEqual(['notes']);
    });

    it('keeps every page of a corrupt parent cycle in the tree', () => {
      const tree = buildCollabPageTree([makeDocument('a', 'A', 1, 'b'), makeDocument('b', 'B', 1, 'a')]);
      const all: string[] = [];
      const walk = (nodes: CollabTreeNode[]) => nodes.forEach((node) => { all.push(node.id); walk(childrenOf(node)); });
      walk(tree);
      expect(all.sort()).toEqual(['document:a', 'document:b']);
    });

    describe('ordering, subtypes and drops', () => {
      const ordered = <T extends { sortOrder: number }>(row: T, sortOrder: number): T => ({ ...row, sortOrder });
      const withExtends: CollabTypeTreeResolver = {
        ...resolver,
        typeExtends: (typeId) => (typeId === 'library' ? 'module' : null),
      };
      // Placement timestamps: nobody has reordered these groups yet.
      const T0 = 1_700_000_000_000;
      const build = () => buildCollabPageTree(
        [makeDocument('arch', 'Architecture'), makeDocument('overview', 'Overview', 1, 'arch'), makeDocument('zeta', 'Zeta', 1, 'arch')],
        {
          resolver: withExtends,
          typePlacements: [ordered(typePlacement('module', 'arch'), T0 + 10), ordered(typePlacement('library', null), T0 + 20)],
          itemPlacements: [ordered(itemPlacement('mod-tracker', 'arch'), T0 + 5), ordered(itemPlacement('lib-yjs', 'arch'), T0 + 1)],
        },
      );

      it('nests a subtype placed elsewhere inside its base and orders typed pages after pages by sortOrder', () => {
        const arch = build()[0];
        expect(ids(childrenOf(arch))).toEqual(['type:module', 'document:overview', 'document:zeta', 'item:lib-yjs', 'item:mod-tracker']);
        expect(ids((childrenOf(arch)[0] as CollabTreeTypeNode).children)).toEqual(['type:library', 'item:mod-sync']);
      });

      it('plans middle drops as moves inside and edge drops as reorders', () => {
        const tree = build();
        const item = (itemId: string) => ({ kind: 'item' as const, itemId, typeId: items[itemId].typeId });
        // Into a page: after its last typed page.
        expect(planPageTreeDrop(tree, item('mod-sync'), 'document:overview', 'inside'))
          .toEqual({ kind: 'item', itemId: 'mod-sync', parentId: 'overview', parentKind: 'page', sortOrder: expect.any(Number) });
        // A placed typed page dropped on its own type goes back under it.
        expect(planPageTreeDrop(tree, item('mod-tracker'), 'type:module', 'inside'))
          .toEqual({ kind: 'unplace-item', itemId: 'mod-tracker' });
        // Not inside its own subtree.
        expect(planPageTreeDrop(tree, { kind: 'page', documentId: 'arch' }, 'document:zeta', 'after')).toBeNull();
        expect(planPageTreeDrop(tree, { kind: 'page', documentId: 'zeta' }, 'document:arch', 'before'))
          .toEqual({
            kind: 'page', documentId: 'zeta', parentId: null, parentKind: 'page', sortOrder: 1024,
            renumber: [{ kind: 'page', documentId: 'arch', parentId: null, parentKind: 'page', sortOrder: 2048 }],
          });
        expect(planPageTreeDrop(tree, { kind: 'page', documentId: 'overview' }, 'document:zeta', 'after'))
          .toMatchObject({ kind: 'page', documentId: 'overview', parentId: 'arch', sortOrder: 3072 });
      });

      it('reorders types among siblings and lets a subtype drop onto its base only', () => {
        const tree = buildCollabPageTree([makeDocument('arch', 'Architecture')], {
          resolver: withExtends,
          typePlacements: [
            ordered(typePlacement('module', null), 10),
            ordered(typePlacement('library', 'arch'), 20),
            ordered(typePlacement('competitor', null), 30),
          ],
        });
        // `competitor` is unknown to the resolver and skipped; add a named root type.
        const twoTypes = buildCollabPageTree([], {
          resolver: { ...withExtends, typeName: (typeId) => ({ module: 'Modules', library: 'Libraries', person: 'People' } as Record<string, string>)[typeId] ?? null },
          typePlacements: [ordered(typePlacement('module', null), 10), ordered(typePlacement('person', null), 30)],
        });
        expect(planPageTreeDrop(twoTypes, { kind: 'type', typeId: 'person' }, 'type:module', 'before'))
          .toEqual({ kind: 'type', typeId: 'person', parentFolderId: null, parentKind: 'page', sortOrder: 9 });
        expect(planPageTreeDrop(tree, { kind: 'type', typeId: 'library' }, 'type:module', 'inside'))
          .toEqual({ kind: 'type', typeId: 'library', parentFolderId: null, parentKind: 'page', sortOrder: 20 });
        expect(planPageTreeDrop(twoTypes, { kind: 'type', typeId: 'person' }, 'type:module', 'inside')).toBeNull();
        // A nested subtype moved to a page would still render inside its base.
        expect(planPageTreeDrop(tree, { kind: 'type', typeId: 'library' }, 'document:arch', 'inside')).toBeNull();
      });

      it('renumbers tied siblings instead of writing a colliding key', () => {
        const names: Record<string, string> = { alpha: 'Alpha', beta: 'Beta', zed: 'Zed' };
        const tree = buildCollabPageTree([], {
          resolver: { ...withExtends, typeName: (typeId) => names[typeId] ?? null },
          typePlacements: [ordered(typePlacement('alpha', null), 10), ordered(typePlacement('beta', null), 10), ordered(typePlacement('zed', null), 30)],
        });
        const plan = planPageTreeDrop(tree, { kind: 'type', typeId: 'zed' }, 'type:beta', 'before');
        expect(plan).toMatchObject({ kind: 'type', typeId: 'zed', parentFolderId: null });
        const orders = new Map([['alpha', 10], ['beta', 10], ['zed', 30]]);
        if (plan?.kind !== 'type') throw new Error('expected a type plan');
        orders.set('zed', plan.sortOrder);
        for (const write of plan.renumber ?? []) if (write.kind === 'type') orders.set(write.typeId, write.sortOrder);
        expect(orders.get('alpha')!).toBeLessThan(orders.get('zed')!);
        expect(orders.get('zed')!).toBeLessThan(orders.get('beta')!);
      });

      it('keeps inserting between timestamp-scale neighbours past float precision', () => {
        const base = 1_700_000_000_000;
        const placements = new Map<string, number>([['lib-yjs', base], ['mod-tracker', base + 1]]);
        const inserted = Array.from({ length: 40 }, (_, index) => `n${index}`);
        const itemResolver: CollabTypeTreeResolver = {
          ...resolver,
          item: (itemId) => (items[itemId] ? { itemId, ...items[itemId] } : { itemId, title: itemId, typeId: 'module' }),
        };
        for (const itemId of inserted) {
          const tree = buildCollabPageTree([makeDocument('arch', 'Architecture')], {
            resolver: itemResolver,
            itemPlacements: [...placements].map(([id, sortOrder]) => ordered(itemPlacement(id, 'arch'), sortOrder)),
          });
          const plan = planPageTreeDrop(tree, { kind: 'item', itemId, typeId: 'module' }, 'item:mod-tracker', 'before');
          if (plan?.kind !== 'item') throw new Error('expected an item plan');
          placements.set(itemId, plan.sortOrder);
          for (const write of plan.renumber ?? []) if (write.kind === 'item') placements.set(write.itemId, write.sortOrder);
        }
        const order = [...placements].sort((left, right) => left[1] - right[1]).map(([id]) => id);
        expect(order).toEqual(['lib-yjs', ...inserted, 'mod-tracker']);
        expect(new Set(placements.values()).size).toBe(placements.size);
      });

      it('splits a row into before / inside / after bands', () => {
        expect(pageTreeDropZone(2, 24)).toBe('before');
        expect(pageTreeDropZone(12, 24)).toBe('inside');
        expect(pageTreeDropZone(22, 24)).toBe('after');
      });
    });

    describe('typed pages as parents and one sibling order', () => {
      const T = 1_700_000_000_000;
      const underItem = <R extends object>(row: R): R & { parentKind: 'item' } => ({ ...row, parentKind: 'item' });
      const doc = (id: string, title: string, parentId: string | null, extra: Partial<SharedDocument> = {}): SharedDocument =>
        ({ ...makeDocument(id, title, 1, parentId), ...extra });
      const find = (nodes: CollabTreeNode[], id: string): CollabTreeNode | undefined => {
        for (const node of nodes) {
          if (node.id === id) return node;
          const hit = find(childrenOf(node), id);
          if (hit) return hit;
        }
        return undefined;
      };

      it('nests pages, types and typed pages under placed and unplaced typed pages', () => {
        const tree = buildCollabPageTree(
          [
            makeDocument('arch', 'Architecture'),
            doc('notes', 'Notes', 'mod-sync', { parentKind: 'item' }),
            doc('plan', 'Plan', 'mod-tracker', { parentKind: 'item' }),
          ],
          {
            resolver,
            typePlacements: [{ ...typePlacement('module', null), sortOrder: T }, underItem({ ...typePlacement('library', 'mod-tracker'), sortOrder: T })],
            itemPlacements: [{ ...itemPlacement('mod-sync', 'arch'), sortOrder: T }],
          },
        );
        const placed = find(tree, 'item:mod-sync') as CollabTreeItemNode;
        expect(ids(childrenOf(placed))).toEqual(['document:notes']);
        expect(childrenOf(placed)[0]).toMatchObject({ path: 'Architecture/Sync engine/Notes' });
        // An unplaced typed page holds children beneath its type.
        const unplaced = find(tree, 'item:mod-tracker') as CollabTreeItemNode;
        expect(find(tree, 'type:module')!.id).toBe(tree[0].id);
        expect(ids(childrenOf(unplaced))).toEqual(['type:library', 'document:plan']);
        expect(ids(childrenOf(find(tree, 'type:library')))).toEqual(['item:lib-yjs']);
      });

      it('roots children of a typed page that is gone, and breaks a cycle through a type', () => {
        const tree = buildCollabPageTree(
          [doc('lost', 'Lost', 'deleted-item', { parentKind: 'item' })],
          {
            resolver,
            // Modules sits under one of its own unplaced items: a cycle only the client can see.
            typePlacements: [underItem({ ...typePlacement('module', 'mod-sync'), sortOrder: T })],
          },
        );
        expect(ids(tree).sort()).toEqual(['document:lost', 'type:module']);
        const modules = tree.find((node) => node.id === 'type:module')!;
        expect(ids(childrenOf(modules))).toEqual(['item:mod-sync', 'item:mod-tracker']);
        expect(childrenOf(childrenOf(modules)[0])).toEqual([]);
      });

      it('shows an unreordered group exactly as before and a reordered one by sortOrder', () => {
        const input = (orders: { arch: number | null; zeta: number | null; module: number; sync: number }) => buildCollabPageTree(
          [doc('arch', 'Architecture', null, { sortOrder: orders.arch }), doc('zeta', 'Zeta', null, { sortOrder: orders.zeta })],
          {
            resolver,
            typePlacements: [{ ...typePlacement('module', null), sortOrder: orders.module }],
            itemPlacements: [{ ...itemPlacement('mod-sync', null), sortOrder: orders.sync }],
          },
        );
        // Placement timestamps only: types, pages by name, typed pages.
        expect(ids(input({ arch: null, zeta: null, module: T + 5, sync: T }))).toEqual(['type:module', 'document:arch', 'document:zeta', 'item:mod-sync']);
        // Renumbered: one order across kinds; a node without an order goes last.
        expect(ids(input({ arch: 3072, zeta: null, module: 2048, sync: 1024 }))).toEqual(['item:mod-sync', 'type:module', 'document:arch', 'document:zeta']);
      });

      // Home is pinned first in either mode, whatever its name or order, and a
      // reorder never renumbers it or lands a row above it.
      it('keeps a Home page first among its siblings and out of reorders', () => {
        const build = (homeOrder: number | null, archOrder: number | null) => buildCollabPageTree(
          [doc('home:team-1', 'Welcome', null, { sortOrder: homeOrder }), doc('arch', 'Architecture', null, { sortOrder: archOrder }), makeDocument('zeta', 'Zeta')],
          { resolver, typePlacements: [{ ...typePlacement('module', null), sortOrder: T }] },
        );
        expect(ids(build(null, null))).toEqual(['document:home:team-1', 'type:module', 'document:arch', 'document:zeta']);
        expect(ids(build(9999, 1024))).toEqual(['document:home:team-1', 'document:arch', 'type:module', 'document:zeta']);

        const plan = planPageTreeDrop(build(null, null), { kind: 'page', documentId: 'zeta' }, 'document:home:team-1', 'before');
        expect(plan).toEqual({
          kind: 'page', documentId: 'zeta', parentId: null, parentKind: 'page', sortOrder: 1024,
          renumber: [
            { kind: 'type', typeId: 'module', parentFolderId: null, parentKind: 'page', sortOrder: 2048 },
            { kind: 'page', documentId: 'arch', parentId: null, parentKind: 'page', sortOrder: 3072 },
          ],
        });
      });

      it('renumbers an unreordered group on its first reorder and moves pages with an order', () => {
        const tree = buildCollabPageTree(
          [makeDocument('arch', 'Architecture'), makeDocument('zeta', 'Zeta')],
          {
            resolver,
            typePlacements: [{ ...typePlacement('module', null), sortOrder: T + 5 }],
            itemPlacements: [{ ...itemPlacement('mod-sync', null), sortOrder: T }],
          },
        );
        const plan = planPageTreeDrop(tree, { kind: 'item', itemId: 'mod-sync', typeId: 'module' }, 'document:arch', 'before');
        expect(plan).toEqual({
          kind: 'item', itemId: 'mod-sync', parentId: null, parentKind: 'page', sortOrder: 2048,
          renumber: [
            { kind: 'type', typeId: 'module', parentFolderId: null, parentKind: 'page', sortOrder: 1024 },
            { kind: 'page', documentId: 'arch', parentId: null, parentKind: 'page', sortOrder: 3072 },
            { kind: 'page', documentId: 'zeta', parentId: null, parentKind: 'page', sortOrder: 4096 },
          ],
        });
        // A page edge drop beside its siblings is now a reorder, not a no-op.
        expect(planPageTreeDrop(tree, { kind: 'page', documentId: 'zeta' }, 'document:arch', 'before'))
          .toMatchObject({ kind: 'page', documentId: 'zeta', parentId: null, sortOrder: 2048 });
      });

      it('drops inside typed pages and refuses cycles, including through a type', () => {
        const tree = buildCollabPageTree(
          [makeDocument('arch', 'Architecture'), doc('notes', 'Notes', 'mod-sync', { parentKind: 'item' })],
          {
            resolver,
            typePlacements: [{ ...typePlacement('module', 'arch'), sortOrder: T }],
            itemPlacements: [{ ...itemPlacement('mod-sync', 'arch'), sortOrder: T }],
          },
        );
        expect(planPageTreeDrop(tree, { kind: 'page', documentId: 'arch' }, 'item:mod-sync', 'inside')).toBeNull();
        expect(planPageTreeDrop(tree, { kind: 'type', typeId: 'module' }, 'item:mod-tracker', 'inside')).toBeNull();
        expect(planPageTreeDrop(tree, { kind: 'page', documentId: 'notes' }, 'item:mod-tracker', 'inside'))
          .toEqual({ kind: 'page', documentId: 'notes', parentId: 'mod-tracker', parentKind: 'item', sortOrder: null });
        expect(planPageTreeDrop(tree, { kind: 'item', itemId: 'mod-tracker', typeId: 'module' }, 'item:mod-sync', 'inside'))
          .toEqual({ kind: 'item', itemId: 'mod-tracker', parentId: 'mod-sync', parentKind: 'item', sortOrder: expect.any(Number) });
      });

      it('refuses sending a typed page back under its type when that type sits under it, on every path', () => {
        // mod-sync at root; Modules placed under mod-sync. Unplacing mod-sync would give mod-sync -> Modules -> mod-sync.
        const tree = buildCollabPageTree([], {
          resolver,
          typePlacements: [underItem({ ...typePlacement('module', 'mod-sync'), sortOrder: T })],
          itemPlacements: [{ ...itemPlacement('mod-sync', null), sortOrder: T }],
        });
        expect(planPageTreeDrop(tree, { kind: 'item', itemId: 'mod-sync', typeId: 'module' }, 'type:module', 'inside')).toBeNull();
        expect(treeMoveRefused(tree, 'item:mod-sync', { underOwnType: true })).toBe(true);
        expect(treeMoveRefused(tree, 'item:mod-sync', { nodeId: 'item:mod-tracker' })).toBe(true);
        expect(treeMoveRefused(tree, 'item:mod-tracker', { underOwnType: true })).toBe(false);
        expect(treeMoveRefused(tree, 'type:module', { nodeId: null })).toBe(false);
      });

      it('gives a new page the end of an ordered group and no order in an unreordered one', () => {
        expect(nextSiblingOrder([T, null, T + 1])).toBeNull();
        expect(nextSiblingOrder([2048, null, 1024, T])).toBe(T + 1024);
        expect(nextSiblingOrder([])).toBeNull();
      });
    });

    it('keeps the folder tree unchanged when the snapshot is not a page tree', () => {
      const documents = [makeDocument('d-spec', 'Architecture', 1, 'f-spec')];
      const folders = [makeFolder('f-spec', 'Spec')];
      expect(buildCollabTreeForScope({ pageTree: false, documents, folders }))
        .toEqual(buildCollabTreeAdaptive(documents, folders));
      expect(ids(buildCollabTreeForScope({ pageTree: true, documents, folders }))).toEqual(['document:d-spec']);
    });
  });

  it('names the ancestors of a tree position through pages, typed pages and types', () => {
    const tree = {
      documents: [makeDocument('arch', 'Architecture'), { ...makeDocument('notes', 'Specs/Notes.md', 1, 'sync'), parentKind: 'item' as const }],
      itemPlacements: [{ itemId: 'sync', parentId: 'arch', parentKind: 'page' as const }],
      typePlacements: [{ typeId: 'module', parentFolderId: 'arch' }],
      item: (itemId: string) => ({ sync: { title: 'Sync engine', typeId: 'module' }, loose: { title: 'Loose', typeId: 'module' } } as Record<string, { title: string; typeId: string }>)[itemId] ?? null,
      typeName: (typeId: string) => (typeId === 'module' ? 'Modules' : null),
    };
    expect(pageTreeAncestors({ id: 'notes', kind: 'page' }, tree)).toEqual(['Architecture', 'Sync engine', 'Notes']);
    // An unplaced typed page sits under its type.
    expect(pageTreeAncestors({ id: 'loose', kind: 'item' }, tree)).toEqual(['Architecture', 'Modules', 'Loose']);
    expect(pageTreeAncestors({ id: 'gone', kind: 'item' }, tree)).toEqual([]);
    // Header crumbs open each node, so the walk also says what each one is.
    expect(pageTreeAncestorRefs({ id: 'loose', kind: 'item' }, tree).map(({ id, kind }) => `${kind}:${id}`))
      .toEqual(['page:arch', 'type:module', 'item:loose']);
  });
});
