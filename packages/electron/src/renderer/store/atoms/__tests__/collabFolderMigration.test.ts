import { describe, expect, it } from 'vitest';
import {
  buildMigratedFolderRows,
  deriveVirtualFolderStructure,
  type SharedDocument,
} from '../collabDocuments';

function doc(
  documentId: string,
  title: string,
  parentFolderId: string | null = null,
  decryptFailed = false,
): SharedDocument {
  return {
    documentId,
    title,
    documentType: 'markdown',
    createdBy: 'u1',
    createdAt: 1,
    updatedAt: 1,
    parentFolderId,
    decryptFailed,
  };
}

describe('deriveVirtualFolderStructure (folder migration)', () => {
  it('derives every ancestor folder path from slash-delimited titles', () => {
    const { folderPaths, docParent } = deriveVirtualFolderStructure([
      doc('d1', 'Specs/API Spec'),
      doc('d2', 'Specs/Deprecated/Legacy Auth'),
      doc('d3', 'RFCs/Auth Redesign'),
      doc('d4', 'Root Doc'), // root-level, not migrated
    ]);

    expect(new Set(folderPaths)).toEqual(new Set(['Specs', 'Specs/Deprecated', 'RFCs']));
    expect(docParent.get('d1')).toBe('Specs');
    expect(docParent.get('d2')).toBe('Specs/Deprecated');
    expect(docParent.get('d3')).toBe('RFCs');
    expect(docParent.has('d4')).toBe(false);
  });

  it('orders folder paths shallowest-first so parents register before children', () => {
    const { folderPaths } = deriveVirtualFolderStructure([
      doc('d1', 'A/B/C/Deep Doc'),
    ]);
    expect(folderPaths).toEqual(['A', 'A/B', 'A/B/C']);
  });

  it('skips documents already migrated to first-class (parentFolderId set)', () => {
    const { folderPaths, docParent } = deriveVirtualFolderStructure([
      doc('d1', 'Specs/API Spec', 'fld_existing'),
    ]);
    expect(folderPaths).toEqual([]);
    expect(docParent.size).toBe(0);
  });

  it('skips undecryptable titles so raw ciphertext never derives garbage folders', () => {
    // Base64 ciphertext can contain '/', which would otherwise be split into
    // bogus folders. A decryptFailed doc must contribute nothing.
    const { folderPaths, docParent } = deriveVirtualFolderStructure([
      doc('d1', 'AB/CD+ciphertext/xyz', null, true), // decryptFailed
      doc('d2', 'Specs/Real Doc'),
    ]);
    expect(new Set(folderPaths)).toEqual(new Set(['Specs']));
    expect(docParent.has('d1')).toBe(false);
    expect(docParent.get('d2')).toBe('Specs');
  });

  it('derives nothing when every path-in-title doc is still locked (retry later)', () => {
    // The raw teamSync pass: titles not yet decrypted. Must yield an empty
    // structure so the migration one-shot is NOT consumed and the decrypted
    // pass can retry.
    const { folderPaths } = deriveVirtualFolderStructure([
      doc('d1', 'locked-ciphertext-blob', null, true),
    ]);
    expect(folderPaths).toEqual([]);
  });

  it('is idempotent: re-running on the same input yields the same structure', () => {
    const docs = [doc('d1', 'Specs/API Spec'), doc('d2', 'Specs/Deprecated/Auth')];
    const a = deriveVirtualFolderStructure(docs);
    const b = deriveVirtualFolderStructure(docs);
    expect(a.folderPaths).toEqual(b.folderPaths);
    expect([...a.docParent]).toEqual([...b.docParent]);
  });
});

describe('buildMigratedFolderRows (optimistic folder rows)', () => {
  const idByPath = new Map<string, string>([
    ['Specs', 'fld_specs'],
    ['Specs/Deprecated', 'fld_dep'],
    ['RFCs', 'fld_rfcs'],
  ]);

  it('links each folder row to its parent id and takes the leaf as the name', () => {
    const rows = buildMigratedFolderRows(
      ['Specs', 'RFCs', 'Specs/Deprecated'],
      idByPath,
      'user-1',
      1234,
    );

    const byId = new Map(rows.map(r => [r.folderId, r]));
    expect(byId.get('fld_specs')).toMatchObject({ name: 'Specs', parentFolderId: null });
    expect(byId.get('fld_rfcs')).toMatchObject({ name: 'RFCs', parentFolderId: null });
    // Nested folder points at its parent id and is named by its leaf.
    expect(byId.get('fld_dep')).toMatchObject({ name: 'Deprecated', parentFolderId: 'fld_specs' });
  });

  it('stamps createdBy/timestamps and assigns a stable sortOrder', () => {
    const rows = buildMigratedFolderRows(['Specs', 'RFCs'], idByPath, 'user-1', 999);
    expect(rows.map(r => r.sortOrder)).toEqual([0, 1]);
    for (const r of rows) {
      expect(r).toMatchObject({ createdBy: 'user-1', createdAt: 999, updatedAt: 999 });
    }
  });
});
