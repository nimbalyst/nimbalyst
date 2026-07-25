import { describe, expect, it } from 'vitest';

import type {
  EncryptedDocIndexEntry,
  TeamDocIndexRegisterMessage,
} from '../teamRoom.js';

describe('shared-document metadata V2 protocol', () => {
  it('keeps legacy register payloads and index entries valid when V2 fields are absent', () => {
    const legacyRegister = {
      type: 'docIndexRegister',
      documentId: 'legacy-doc',
      encryptedTitle: 'ciphertext',
      titleIv: 'iv',
      documentType: 'markdown',
    } satisfies TeamDocIndexRegisterMessage;
    const legacyEntry = {
      documentId: 'legacy-doc',
      encryptedTitle: 'ciphertext',
      titleIv: 'iv',
      documentType: 'markdown',
      createdBy: 'user-1',
      createdAt: 1,
      updatedAt: 2,
    } satisfies EncryptedDocIndexEntry;

    expect(JSON.parse(JSON.stringify(legacyRegister))).toEqual(legacyRegister);
    expect(JSON.parse(JSON.stringify(legacyEntry))).toEqual(legacyEntry);
  });

  it('round-trips explicit V2 type metadata without changing documentType', () => {
    const register = {
      type: 'docIndexRegister',
      documentId: 'code-doc',
      encryptedTitle: 'ciphertext',
      titleIv: 'iv',
      documentType: 'code',
      metadataVersion: 2,
      fileExtension: '.ts',
      editorId: 'builtin.monaco',
    } satisfies TeamDocIndexRegisterMessage;
    const entry = {
      documentId: register.documentId,
      encryptedTitle: register.encryptedTitle,
      titleIv: register.titleIv,
      documentType: register.documentType,
      metadataVersion: register.metadataVersion,
      fileExtension: register.fileExtension,
      editorId: register.editorId,
      createdBy: 'user-1',
      createdAt: 1,
      updatedAt: 2,
    } satisfies EncryptedDocIndexEntry;

    const roundTrippedRegister = JSON.parse(JSON.stringify(register)) as TeamDocIndexRegisterMessage;
    const roundTrippedEntry = JSON.parse(JSON.stringify(entry)) as EncryptedDocIndexEntry;

    expect(roundTrippedRegister).toMatchObject({
      documentType: 'code',
      metadataVersion: 2,
      fileExtension: '.ts',
      editorId: 'builtin.monaco',
    });
    expect(roundTrippedEntry).toMatchObject({
      documentType: 'code',
      metadataVersion: 2,
      fileExtension: '.ts',
      editorId: 'builtin.monaco',
    });
  });
});
