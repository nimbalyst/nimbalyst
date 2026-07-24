import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import type { CollabContentAdapter } from '../CollabContentAdapter';
import {
  COLLAB_CONVERSION_ORIGIN,
  handleCollabConversionRequest,
  noCodecError,
} from '../conversionHost';
import { clearCollabContentAdapters, registerCollabContentAdapter } from '../registry';

/**
 * Portable stand-in for a real codec: one `Y.Text` named `body`, wipe-and-
 * reseed semantics. Deliberately not the markdown codec -- this package must
 * not depend on the Lexical graph. Markdown parity is covered by
 * `packages/runtime/src/sync/__tests__/collabConversionParity.test.ts`.
 */
const textCodec: CollabContentAdapter = {
  documentType: 'text-fixture',
  fileExtensions: ['.txt'],
  layoutVersion: 1,
  isEmpty: (yDoc) => yDoc.share.size === 0,
  seedFromFile: (yDoc, source) => {
    yDoc.getText('body').insert(0, String(source));
  },
  applyFromFile: (yDoc, source) => {
    yDoc.transact(() => {
      const text = yDoc.getText('body');
      text.delete(0, text.length);
      text.insert(0, String(source));
    });
  },
  exportToFile: (yDoc) => yDoc.getText('body').toString(),
  toPlainText: (yDoc) => yDoc.getText('body').toString(),
};

function docWith(content: string): Y.Doc {
  const doc = new Y.Doc();
  textCodec.seedFromFile(doc, content);
  return doc;
}

describe('handleCollabConversionRequest', () => {
  afterEach(() => {
    clearCollabContentAdapters();
  });

  it('reports an unregistered document type instead of throwing', () => {
    const response = handleCollabConversionRequest({
      id: 1,
      op: 'toPlainText',
      documentType: 'nope',
      state: new Uint8Array(),
    });

    expect(response).toEqual({ id: 1, ok: false, error: noCodecError('nope') });
  });

  it('reads an existing doc from its encoded state', () => {
    registerCollabContentAdapter(textCodec);
    const live = docWith('hello world');

    const response = handleCollabConversionRequest({
      id: 2,
      op: 'toPlainText',
      documentType: 'text-fixture',
      state: Y.encodeStateAsUpdate(live),
    });

    expect(response).toMatchObject({ id: 2, ok: true, op: 'toPlainText', text: 'hello world' });
  });

  it('returns a delta that reproduces the in-process result on the live doc', () => {
    registerCollabContentAdapter(textCodec);
    const live = new Y.Doc();
    const inProcess = new Y.Doc();
    textCodec.seedFromFile(inProcess, 'seeded body');

    const response = handleCollabConversionRequest({
      id: 3,
      op: 'seedFromFile',
      documentType: 'text-fixture',
      state: Y.encodeStateAsUpdate(live),
      source: 'seeded body',
    });

    if (!response.ok || response.op !== 'seedFromFile') throw new Error('expected a seed delta');
    Y.applyUpdate(live, response.update, COLLAB_CONVERSION_ORIGIN);

    expect(textCodec.exportToFile(live)).toBe(textCodec.exportToFile(inProcess));
  });

  it('replaces rather than appends when applyFromFile wipes and reseeds', () => {
    registerCollabContentAdapter(textCodec);
    const live = docWith('original content');

    const response = handleCollabConversionRequest({
      id: 4,
      op: 'applyFromFile',
      documentType: 'text-fixture',
      state: Y.encodeStateAsUpdate(live),
      source: 'replacement',
    });

    if (!response.ok || response.op !== 'applyFromFile') throw new Error('expected an apply delta');
    Y.applyUpdate(live, response.update, COLLAB_CONVERSION_ORIGIN);

    expect(textCodec.exportToFile(live)).toBe('replacement');
  });

  it('merges a concurrent local edit made during the round trip', () => {
    registerCollabContentAdapter(textCodec);
    const live = docWith('base');
    const state = Y.encodeStateAsUpdate(live);

    // A peer edit lands while the host is converting -- the whole point of
    // shipping a delta instead of full state.
    live.getText('body').insert(live.getText('body').length, ' + peer');

    const response = handleCollabConversionRequest({
      id: 5,
      op: 'applyFromFile',
      documentType: 'text-fixture',
      state,
      source: 'converted',
    });

    if (!response.ok || response.op !== 'applyFromFile') throw new Error('expected an apply delta');
    Y.applyUpdate(live, response.update, COLLAB_CONVERSION_ORIGIN);

    // The conversion's deletion covers only what it saw; the peer insert
    // survives. What must NOT happen is the peer edit being silently lost by a
    // full-state overwrite.
    expect(textCodec.exportToFile(live)).toContain('converted');
    expect(textCodec.exportToFile(live)).toContain('+ peer');
  });

  it('surfaces a codec failure as an error response, not a throw', () => {
    registerCollabContentAdapter({
      ...textCodec,
      documentType: 'exploding',
      fileExtensions: ['.boom'],
      exportToFile: () => { throw new Error('codec exploded'); },
    });

    const response = handleCollabConversionRequest({
      id: 6,
      op: 'exportToFile',
      documentType: 'exploding',
      state: new Uint8Array(),
    });

    expect(response).toEqual({ id: 6, ok: false, error: 'codec exploded' });
  });
});
