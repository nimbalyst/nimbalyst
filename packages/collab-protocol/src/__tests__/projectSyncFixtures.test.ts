// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

import type { ProjectSyncClientMessage, ProjectSyncServerMessage } from '../projectSync.js';

/**
 * Golden fixtures for the push, ack and push-confirmation slice of project file sync
 * (`fixtures/projectSync/`). iOS and Android decode these frames with their own
 * types (`SyncProtocol.swift`, `DocumentSyncProtocol.kt`), which ignore unknown
 * keys, so the files stay out of the session-sync manifest in
 * `fixtures/index.json`. Each witness spells out every optional field, so a
 * field added to one of these wire types without its fixture fails tsc.
 */

type Exhaustive<T> = { [K in keyof T]-?: Exclude<T[K], undefined> };
type Client<T extends ProjectSyncClientMessage['type']> = Exhaustive<Extract<ProjectSyncClientMessage, { type: T }>>;
type Server<T extends ProjectSyncServerMessage['type']> = Exhaustive<Extract<ProjectSyncServerMessage, { type: T }>>;

const ciphertext = {
  encryptedContent: 'Y2lwaGVydGV4dA==', contentIv: 'aXYtY29udGVudA==', encryptedPath: 'cGF0aA==', pathIv: 'aXYtcGF0aA==',
  encryptedTitle: 'dGl0bGU=', titleIv: 'aXYtdGl0bGU=', lastModifiedAt: 1790000001000,
};
const pushedFile = { syncId: 'sync-a', contentHash: 'hash-a', ...ciphertext };
const tooLarge = 'Encrypted file is 2500000 bytes; the limit is 2031616';

const fixtures: Record<string, unknown> = {
  'projectSyncResponse.json': {
    type: 'projectSyncResponse', transferId: 'transfer-1', batchIndex: 0, isLastBatch: true, pushAck: true,
    pushConfirmations: [{ syncId: 'sync-unanswered', contentHash: 'hash-unanswered' }, { syncId: 'sync-missing', contentHash: null }],
    updatedFiles: [{ syncId: 'sync-updated', contentHash: 'hash-updated', ...ciphertext, hasYjs: false }],
    yjsUpdates: [{ syncId: 'sync-yjs', encryptedUpdate: 'dXBkYXRl', iv: 'aXYteWpz', sequence: 3 }],
    newFiles: [], needFromClient: ['sync-needed'], deletedSyncIds: ['sync-deleted'],
  } satisfies Server<'projectSyncResponse'>,
  'projectSyncRequest.json': {
    type: 'projectSyncRequest',
    files: [{ syncId: 'sync-a', contentHash: 'hash-a', lastModifiedAt: 1790000001000, hasYjs: false, yjsSeq: 0 }],
    confirm: ['sync-unanswered'],
  } satisfies Client<'projectSyncRequest'>,
  'fileContentPush.json': { type: 'fileContentPush', ...pushedFile, requestId: 'push-1' } satisfies Client<'fileContentPush'>,
  'fileContentBatchPush.json': { type: 'fileContentBatchPush', files: [pushedFile], requestId: 'batch-1' } satisfies Client<'fileContentBatchPush'>,
  'fileContentPushAck.json': {
    type: 'fileContentPushAck', requestId: 'batch-1', stored: ['sync-a'],
    rejected: [{ syncId: 'sync-big', code: 'file_too_large', message: tooLarge }],
  } satisfies Server<'fileContentPushAck'>,
  'error.json': { type: 'error', code: 'file_too_large', message: tooLarge, syncId: 'sync-big' } satisfies Server<'error'>,
};

const fixtureDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../fixtures/projectSync');
it('binds every project sync fixture file to its typed witness', () => {
  expect(readdirSync(fixtureDir).filter(file => file.endsWith('.json')).sort()).toEqual(Object.keys(fixtures).sort());
  for (const [file, witness] of Object.entries(fixtures)) {
    expect(JSON.parse(readFileSync(resolve(fixtureDir, file), 'utf8')), file).toEqual(witness);
  }
});
