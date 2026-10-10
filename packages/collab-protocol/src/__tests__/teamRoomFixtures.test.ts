// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

import type {
  EncryptedDocIndexEntry,
  ItemPlacementNode,
  PageLinkEntry,
  PageMarkEntry,
  PageSearchHit,
  TeamClientMessage,
  TeamServerMessage,
  TeamState,
  TypePlacementNode,
} from '../teamRoom.js';

/**
 * Golden TeamRoom fixtures for the one page tree (`fixtures/team/`). Team
 * messages never reach iOS or Android, so they stay out of the mobile manifest
 * in `fixtures/index.json`; the server and the runtime client both compile
 * against these same types. Each witness must spell out every optional field,
 * so a field added to the wire type without its fixture fails tsc.
 */

type Exhaustive<T> = { [K in keyof T]-?: Exclude<T[K], undefined> };
type Client<T extends TeamClientMessage['type']> = Exhaustive<Extract<TeamClientMessage, { type: T }>>;
type Server<T extends TeamServerMessage['type']> = Exhaustive<Extract<TeamServerMessage, { type: T }>>;

const node = {
  itemId: 'NIM-42', projectId: 'project-1', parentId: 'page-1', parentKind: 'page', sortOrder: 2,
  createdBy: 'member-1', createdAt: 1790000000000, updatedAt: 1790000001000,
} satisfies Exhaustive<ItemPlacementNode>;
const rootNode = { ...node, itemId: 'NIM-43', parentId: null, sortOrder: 0 } satisfies ItemPlacementNode;
// An item under another item.
const childNode = { ...node, itemId: 'NIM-44', parentId: 'NIM-42', parentKind: 'item', sortOrder: 1 } satisfies ItemPlacementNode;
const typeNode = {
  typeId: 'bug', projectId: 'project-1', parentFolderId: 'NIM-42', parentKind: 'item', sortOrder: 1024,
  createdBy: 'member-1', createdAt: 1790000000000, updatedAt: 1790000001000,
} satisfies Exhaustive<TypePlacementNode>;
// A page under a tracker item, reordered among its siblings.
const pageUnderItem = {
  documentId: 'page-2', encryptedTitle: 'Notes', titleIv: '', documentType: 'markdown', metadataVersion: 2,
  fileExtension: '.md', editorId: 'com.nimbalyst.markdown', createdBy: 'member-1', createdAt: 1790000000000,
  updatedAt: 1790000002000, projectId: 'project-1', lastWriterUserId: 'member-1', parentFolderId: 'NIM-42',
  parentKind: 'item', sortOrder: 2048, trashedAt: null, hasContent: true,
  fields: { status: 'current', owner: 'greg@example.com', summary: 'Meeting notes', tags: ['notes'] },
} satisfies Exhaustive<EncryptedDocIndexEntry>;

const pageTreeTeam = {
  metadata: {
    orgId: 'org-1', name: 'Team', gitRemoteHash: null, teamProjectId: 'project-1',
    createdBy: 'member-1', createdAt: 1790000000000,
  },
  members: [],
  documents: [{
    documentId: 'page-1', encryptedTitle: 'Specs', titleIv: '', documentType: 'markdown',
    createdBy: 'member-1', createdAt: 1790000000000, updatedAt: 1790000000000,
    projectId: 'project-1', lastWriterUserId: null, parentFolderId: null, parentKind: 'page', sortOrder: null,
    // A converted folder: its body was never edited, so the tree shows a folder.
    trashedAt: null, hasContent: false,
    // No fields set.
    fields: null,
  }, pageUnderItem],
  // The older-client projection: the page has a child placement.
  folders: [{
    folderId: 'page-1', parentFolderId: null, encryptedName: 'Specs', nameIv: '', sortOrder: 0,
    projectId: 'project-1', createdBy: 'member-1', createdAt: 1790000000000, updatedAt: 1790000000000,
  }],
  pageTree: true,
  authorWriteEcho: true,
  pageFields: true,
  typePlacements: [typeNode],
  itemPlacements: [node, childNode],
} satisfies Omit<TeamState, 'settings'> & Exhaustive<Pick<TeamState, 'folders' | 'pageTree' | 'authorWriteEcho' | 'pageFields' | 'typePlacements' | 'itemPlacements'>>;

// A decision on a plain page, and an open question in a typed page's body
// (no project or title: the client resolves the tracker item).
const decidedMark = {
  documentId: 'page-1', projectId: 'project-1', title: 'Specs', kind: 'decided',
  text: 'Storage lives in [Flagship](https://console.nimbalyst.com/x).', plainText: 'Storage lives in Flagship.',
  by: 'Greg Hinkle', email: 'greg@example.com', on: '2026-09-30', over: 'our own engine', line: 3, offset: 41,
} satisfies Omit<Exhaustive<PageMarkEntry>, 'typedPage'>;
const openMark = {
  documentId: 'tracker-content/NIM-42', projectId: null, title: null, kind: 'open',
  typedPage: { itemId: 'NIM-42', typeId: 'bug', issueKey: 'NIM-42' },
  text: 'Pricing is unknown.', plainText: 'Pricing is unknown.', by: 'Spike 6', email: null, on: null, over: null, line: 1, offset: 0,
} satisfies Exhaustive<PageMarkEntry>;

// A typed page that underlies NIM-42 (incoming to it), and NIM-42's own link
// out to a plain page.
const incomingLink = {
  source: { kind: 'item', itemId: 'item-7' }, projectId: 'project-1', title: null,
  target: { kind: 'item', ref: 'NIM-42' }, rel: 'built-on', sentence: 'Sync is built on NIM-42.', count: 1,
} satisfies Exhaustive<PageLinkEntry>;
const outgoingLink = {
  source: { kind: 'item', itemId: 'item-42' }, projectId: 'project-1', title: null,
  target: { kind: 'page', documentId: 'page-1' }, rel: null, sentence: 'See Specs.', count: 2,
} satisfies PageLinkEntry;
const pageSourcedLink = {
  source: { kind: 'page', documentId: 'page-1' }, projectId: 'project-1', title: 'Specs',
  target: { kind: 'item', ref: 'item-42' }, rel: null, sentence: 'Covers item-42.', count: 1,
} satisfies PageLinkEntry;

// A page found by its body, and a typed page (no title: the client's tree names it).
const pageHit = {
  kind: 'page', id: 'page-1', documentId: 'page-1', title: 'Specs', issueKey: null,
  snippet: '…the team chose Yjs over Automerge…', highlights: [{ start: 20, end: 23 }], updatedAt: 1790000000000, score: 4.2,
} satisfies Exhaustive<PageSearchHit>;
const typedHit = {
  kind: 'typed', id: 'item-42', documentId: 'tracker-content/item-42', title: null, issueKey: 'NIM-42',
  snippet: 'Yjs sync for pages.', highlights: [{ start: 0, end: 3 }], updatedAt: null, score: 1.5,
} satisfies PageSearchHit;

const fixtures: Record<string, unknown> = {
  'pageSearchQuery.json': {
    type: 'pageSearchQuery', requestId: 'search-1', projectId: 'project-1', query: 'yjs autom', limit: 20, typeIds: ['module', 'decision'],
  } satisfies Client<'pageSearchQuery'>,
  'pageSearchResponse.json': {
    type: 'pageSearchResponse', requestId: 'search-1', hits: [pageHit, typedHit], status: 'partial',
  } satisfies Server<'pageSearchResponse'>,
  'pageLinksQuery.json': {
    type: 'pageLinksQuery', requestId: 'links-1', projectId: 'project-1',
    from: { kind: 'item', itemId: 'item-42' }, to: [{ kind: 'item', ref: 'item-42' }, { kind: 'item', ref: 'NIM-42' }],
  } satisfies Client<'pageLinksQuery'>,
  'pageLinksResponse.json': {
    type: 'pageLinksResponse', requestId: 'links-1', outgoing: [outgoingLink], incoming: [incomingLink, pageSourcedLink], status: 'ready',
  } satisfies Server<'pageLinksResponse'>,
  'pageLinksChanged.json': { type: 'pageLinksChanged' } satisfies Server<'pageLinksChanged'>,
  'pageMarksQuery.json': {
    type: 'pageMarksQuery', requestId: 'marks-1', projectId: 'project-1', kind: 'decided', email: 'greg@example.com', documentIds: ['page-1'],
  } satisfies Client<'pageMarksQuery'>,
  'pageMarksResponse.json': {
    type: 'pageMarksResponse', requestId: 'marks-1', marks: [decidedMark, openMark], status: 'ready', coverage: 'all-page-kinds',
  } satisfies Server<'pageMarksResponse'>,
  'itemPlacementIndexSync.json': { type: 'itemPlacementIndexSync' } satisfies Client<'itemPlacementIndexSync'>,
  'itemPlacementSet.json': {
    type: 'itemPlacementSet', itemId: 'NIM-44', projectId: 'project-1', parentId: 'NIM-42', parentKind: 'item', sortOrder: 1,
  } satisfies Client<'itemPlacementSet'>,
  'itemPlacementRemove.json': {
    type: 'itemPlacementRemove', itemId: 'NIM-42', projectId: 'project-1',
  } satisfies Client<'itemPlacementRemove'>,
  'itemPlacementIndexSyncResponse.json': {
    type: 'itemPlacementIndexSyncResponse', placements: [node, rootNode, childNode],
  } satisfies Server<'itemPlacementIndexSyncResponse'>,
  'itemPlacementBroadcast.json': { type: 'itemPlacementBroadcast', placement: childNode } satisfies Server<'itemPlacementBroadcast'>,
  'typePlacementSet.json': {
    type: 'typePlacementSet', typeId: 'bug', projectId: 'project-1', parentFolderId: 'NIM-42', parentKind: 'item', sortOrder: 1024,
  } satisfies Client<'typePlacementSet'>,
  'typePlacementBroadcast.json': { type: 'typePlacementBroadcast', placement: typeNode } satisfies Server<'typePlacementBroadcast'>,
  'docIndexRegister.json': {
    type: 'docIndexRegister', documentId: 'page-2', encryptedTitle: 'Notes', titleIv: '', documentType: 'markdown',
    metadataVersion: 2, fileExtension: '.md', editorId: 'com.nimbalyst.markdown', projectId: 'project-1',
    parentFolderId: 'NIM-42', parentKind: 'item', sortOrder: 2048,
  } satisfies Client<'docIndexRegister'>,
  // Same parent with a new sortOrder: a reorder.
  'docMove.json': {
    type: 'docMove', documentId: 'page-2', newParentFolderId: 'NIM-42', parentKind: 'item', sortOrder: 512, requestId: 'move-1',
  } satisfies Client<'docMove'>,
  // Writes a client confirms by their echo carry a requestId.
  'docIndexRemove.json': { type: 'docIndexRemove', documentId: 'page-2', requestId: 'remove-1' } satisfies Omit<Client<'docIndexRemove'>, 'purge'>,
  // Only Trash's permanent delete sends `purge`; a plain remove never deletes a trashed page.
  'docIndexRemove.purge.json': {
    type: 'docIndexRemove', documentId: 'page-3', requestId: 'remove-3', purge: true,
  } satisfies Client<'docIndexRemove'>,
  // A patch: null clears owner, the other keys keep their stored values.
  'docIndexSetFields.json': {
    type: 'docIndexSetFields', documentId: 'page-2', fields: { status: 'outdated', owner: null }, requestId: 'fields-1',
  } satisfies Client<'docIndexSetFields'>,
  'folderRemove.json': { type: 'folderRemove', folderId: 'page-1', requestId: 'remove-2' } satisfies Client<'folderRemove'>,
  // A refused write, answered with the message's requestId.
  'error.requestId.json': {
    type: 'error', code: 'folder_cycle', message: 'A page cannot move under itself', requestId: 'move-1',
  } satisfies Server<'error'>,
  'docIndexBroadcast.json': { type: 'docIndexBroadcast', document: pageUnderItem } satisfies Server<'docIndexBroadcast'>,
  'itemPlacementRemoveBroadcast.json': {
    type: 'itemPlacementRemoveBroadcast', projectId: 'project-1', itemIds: ['NIM-42', 'NIM-43'],
  } satisfies Server<'itemPlacementRemoveBroadcast'>,
  'teamSyncResponse.pageTree.json': { type: 'teamSyncResponse', team: pageTreeTeam } satisfies Extract<TeamServerMessage, { type: 'teamSyncResponse' }>,
};

const fixtureDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../fixtures/team');

it('binds every team fixture file to its typed witness', () => {
  expect(readdirSync(fixtureDir).filter(file => file.endsWith('.json')).sort()).toEqual(Object.keys(fixtures).sort());
  for (const [file, witness] of Object.entries(fixtures)) {
    expect(JSON.parse(readFileSync(resolve(fixtureDir, file), 'utf8')), file).toEqual(witness);
  }
});
