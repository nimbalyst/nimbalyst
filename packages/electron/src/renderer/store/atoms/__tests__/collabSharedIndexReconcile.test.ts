import { describe, expect, it } from 'vitest';
import {
  reconcileSharedDocuments,
  reconcileSharedFolders,
  mergeSharedDocument,
  mergeSharedFolder,
  type SharedDocument,
  type SharedFolder,
} from '../collabDocuments';

function doc(
  documentId: string,
  title: string,
  overrides: Partial<SharedDocument> = {},
): SharedDocument {
  return {
    documentId,
    title,
    documentType: 'markdown',
    createdBy: 'u1',
    createdAt: 1,
    updatedAt: 1,
    parentFolderId: null,
    decryptFailed: false,
    ...overrides,
  };
}

function folder(folderId: string, name: string, overrides: Partial<SharedFolder> = {}): SharedFolder {
  return {
    folderId,
    parentFolderId: null,
    name,
    sortOrder: 0,
    createdBy: 'u1',
    createdAt: 1,
    updatedAt: 1,
    decryptFailed: false,
    ...overrides,
  };
}

describe('reconcileSharedDocuments (NIM-1638: shared docs must not disappear)', () => {
  it('keeps every existing doc when a full-sync response arrives EMPTY', () => {
    // Reproduces the bug: a transient/empty docIndexSync on reconnect used to
    // wholesale-replace the list with [], blanking the sidebar tree.
    const existing = [doc('d1', 'latest meeting'), doc('d2', 'What is Next')];
    const result = reconcileSharedDocuments(existing, []);
    expect(result.map(d => d.documentId).sort()).toEqual(['d1', 'd2']);
  });

  it('restores a doc that a PARTIAL full-sync response dropped', () => {
    // Incoming set is missing d2 (partial/transient). d2 must survive, and the
    // incoming copy of d1 must win (updated title).
    const existing = [doc('d1', 'latest meeting'), doc('d2', 'What is Next')];
    const incoming = [doc('d1', 'latest meeting (edited)')];
    const result = reconcileSharedDocuments(existing, incoming);
    const byId = new Map(result.map(d => [d.documentId, d]));
    expect(byId.get('d1')?.title).toBe('latest meeting (edited)');
    expect(byId.get('d2')?.title).toBe('What is Next');
  });

  it('adds new docs from the incoming set', () => {
    const existing = [doc('d1', 'latest meeting')];
    const incoming = [doc('d1', 'latest meeting'), doc('d3', 'brand new')];
    const result = reconcileSharedDocuments(existing, incoming);
    expect(result.map(d => d.documentId).sort()).toEqual(['d1', 'd3']);
  });

  it('lets incoming data win over the existing row for the same id', () => {
    const existing = [doc('d1', 'stale', { parentFolderId: 'f_old', updatedAt: 1 })];
    const incoming = [doc('d1', 'fresh', { parentFolderId: 'f_new', updatedAt: 2 })];
    const result = reconcileSharedDocuments(existing, incoming);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ title: 'fresh', parentFolderId: 'f_new', updatedAt: 2 });
  });

  it('is idempotent when incoming matches existing', () => {
    const existing = [doc('d1', 'a'), doc('d2', 'b')];
    const once = reconcileSharedDocuments(existing, existing);
    const twice = reconcileSharedDocuments(once, existing);
    expect(twice.map(d => d.documentId).sort()).toEqual(['d1', 'd2']);
  });
});

describe('reconcileSharedDocuments (NIM-1636: file name must not go blank)', () => {
  it('keeps the known title when a transient sync delivers an empty (decrypt-failed) title', () => {
    // Reproduces the bug: a raw/teamSync pass (or a broadcast during key
    // transition) delivers title:'' + decryptFailed for a doc we already
    // decrypted. Reconcile used to let that blank row win, blanking the name.
    const existing = [doc('d1', 'latest meeting')];
    const incoming = [doc('d1', '', { decryptFailed: true })];
    const result = reconcileSharedDocuments(existing, incoming);
    const d1 = result.find(d => d.documentId === 'd1');
    expect(d1?.title).toBe('latest meeting');
    expect(d1?.decryptFailed).toBe(false);
  });

  it('does not let a whitespace-only title blank a known name', () => {
    const existing = [doc('d1', 'latest meeting')];
    const incoming = [doc('d1', '   ')];
    const result = reconcileSharedDocuments(existing, incoming);
    expect(result.find(d => d.documentId === 'd1')?.title).toBe('latest meeting');
  });

  it('fills the name in as soon as a real title arrives after a blank one', () => {
    // Row first appears blank (before its metadata decrypts), then the real
    // title lands on a later pass — it must fill in, not stay blank.
    const blank = reconcileSharedDocuments([], [doc('d1', '', { decryptFailed: true })]);
    expect(blank.find(d => d.documentId === 'd1')?.title).toBe('');
    const filled = reconcileSharedDocuments(blank, [doc('d1', 'latest meeting')]);
    expect(filled.find(d => d.documentId === 'd1')?.title).toBe('latest meeting');
  });

  it('lets a genuine rename (non-blank) win', () => {
    const existing = [doc('d1', 'old name')];
    const incoming = [doc('d1', 'new name')];
    const result = reconcileSharedDocuments(existing, incoming);
    expect(result.find(d => d.documentId === 'd1')?.title).toBe('new name');
  });
});

describe('mergeSharedDocument / mergeSharedFolder (NIM-1636: per-item broadcasts)', () => {
  it('keeps the known title when a collaborator broadcast decrypts to empty', () => {
    const merged = mergeSharedDocument(doc('d1', 'latest meeting'), doc('d1', '', { decryptFailed: true }));
    expect(merged.title).toBe('latest meeting');
    expect(merged.decryptFailed).toBe(false);
  });

  it('keeps the known folder name when a broadcast decrypts to empty', () => {
    const merged = mergeSharedFolder(folder('f1', 'Specs'), folder('f1', '', { decryptFailed: true }));
    expect(merged.name).toBe('Specs');
    expect(merged.decryptFailed).toBe(false);
  });

  it('still applies fresh non-title metadata from an empty-title broadcast', () => {
    const merged = mergeSharedDocument(
      doc('d1', 'latest meeting', { parentFolderId: 'f_old', updatedAt: 1 }),
      doc('d1', '', { decryptFailed: true, parentFolderId: 'f_new', updatedAt: 2 }),
    );
    expect(merged.title).toBe('latest meeting');
    expect(merged.parentFolderId).toBe('f_new');
    expect(merged.updatedAt).toBe(2);
  });
});

describe('reconcileSharedFolders (NIM-1636: folder name must not go blank)', () => {
  it('keeps the known folder name when a transient sync delivers an empty name', () => {
    const existing = [folder('f1', 'Specs')];
    const incoming = [folder('f1', '', { decryptFailed: true })];
    const result = reconcileSharedFolders(existing, incoming);
    const f1 = result.find(f => f.folderId === 'f1');
    expect(f1?.name).toBe('Specs');
    expect(f1?.decryptFailed).toBe(false);
  });
});

describe('reconcileSharedFolders (NIM-1638: shared folders must not disappear)', () => {
  it('keeps existing folders when a full-sync response arrives EMPTY', () => {
    const existing = [folder('f1', 'Specs'), folder('f2', 'RFCs')];
    const result = reconcileSharedFolders(existing, []);
    expect(result.map(f => f.folderId).sort()).toEqual(['f1', 'f2']);
  });

  it('restores a folder that a partial sync dropped and lets incoming win', () => {
    const existing = [folder('f1', 'Specs'), folder('f2', 'RFCs')];
    const incoming = [folder('f1', 'Specifications')];
    const result = reconcileSharedFolders(existing, incoming);
    const byId = new Map(result.map(f => [f.folderId, f]));
    expect(byId.get('f1')?.name).toBe('Specifications');
    expect(byId.get('f2')?.name).toBe('RFCs');
  });
});
