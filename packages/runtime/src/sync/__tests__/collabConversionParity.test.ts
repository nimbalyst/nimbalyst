/**
 * Codec parity for the delegated conversion path.
 *
 * The Electron main process is losing its codec registry: conversion moves to a
 * *codec host* (renderer today; web console and mobile later) that answers
 * state-based requests and returns a delta. The claim that makes that safe is
 * "the delegated path is indistinguishable from running the codec in-process."
 * This asserts it over a corpus that exercises the shapes headless conversion
 * has historically dropped -- lists, links, images, code fences, rules.
 *
 * See `nimbalyst-local/plans/collab-conversion-off-main.md`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  COLLAB_CONVERSION_ORIGIN,
  clearCollabContentAdapters,
  handleCollabConversionRequest,
  registerCollabContentAdapter,
} from '@nimbalyst/collab-adapters';

import { MarkdownCollabContentAdapter } from '../MarkdownCollabContentAdapter';
// Side-effect: populate the transformer set so the headless editor sees the
// same transformers the live one does.
import '../../editor/extensions/registerBuiltinExtensions';

const CORPUS = `# Title

Intro paragraph with **bold**, _italic_, and a [link](https://example.com/docs).

- bullet one
- bullet two

1. ordered one
2. ordered two

![alt text](https://example.com/image.png)

\`\`\`ts
const answer = 42;
\`\`\`

---

Closing line.`;

function asText(source: string | Uint8Array): string {
  return typeof source === 'string' ? source : new TextDecoder('utf-8').decode(source);
}

/** The delegated path: encode state, hand it to a host, apply the delta back. */
function convertViaHost(
  live: Y.Doc,
  op: 'seedFromFile' | 'applyFromFile',
  source: string,
): void {
  const response = handleCollabConversionRequest({
    id: 1,
    op,
    documentType: 'markdown',
    state: Y.encodeStateAsUpdate(live),
    source,
  });
  if (!response.ok) throw new Error(response.error);
  if (response.op !== op) throw new Error(`expected a ${op} delta`);
  Y.applyUpdate(live, response.update, COLLAB_CONVERSION_ORIGIN);
}

describe('markdown conversion parity between the in-process and delegated paths', () => {
  beforeEach(() => {
    registerCollabContentAdapter(MarkdownCollabContentAdapter);
  });
  afterEach(() => {
    clearCollabContentAdapters();
  });

  it('seeds an empty doc identically', () => {
    const inProcess = new Y.Doc();
    MarkdownCollabContentAdapter.seedFromFile(inProcess, CORPUS);

    const delegated = new Y.Doc();
    convertViaHost(delegated, 'seedFromFile', CORPUS);

    expect(asText(MarkdownCollabContentAdapter.exportToFile(delegated)))
      .toBe(asText(MarkdownCollabContentAdapter.exportToFile(inProcess)));
  });

  it('replaces a populated doc identically', () => {
    const inProcess = new Y.Doc();
    MarkdownCollabContentAdapter.seedFromFile(inProcess, '# Old content\n\nto be replaced.');
    MarkdownCollabContentAdapter.applyFromFile(inProcess, CORPUS);

    const delegated = new Y.Doc();
    MarkdownCollabContentAdapter.seedFromFile(delegated, '# Old content\n\nto be replaced.');
    convertViaHost(delegated, 'applyFromFile', CORPUS);

    const delegatedText = asText(MarkdownCollabContentAdapter.exportToFile(delegated));
    expect(delegatedText).toBe(asText(MarkdownCollabContentAdapter.exportToFile(inProcess)));
    // Replace, not append -- the tombstone-delta assumption.
    expect(delegatedText).not.toContain('to be replaced');
  });

  it('exports and projects an existing doc identically', () => {
    const live = new Y.Doc();
    MarkdownCollabContentAdapter.seedFromFile(live, CORPUS);
    const state = Y.encodeStateAsUpdate(live);

    const exported = handleCollabConversionRequest({
      id: 2, op: 'exportToFile', documentType: 'markdown', state,
    });
    const plain = handleCollabConversionRequest({
      id: 3, op: 'toPlainText', documentType: 'markdown', state,
    });

    if (!exported.ok || exported.op !== 'exportToFile') throw new Error('expected an export');
    if (!plain.ok || plain.op !== 'toPlainText') throw new Error('expected plain text');

    expect(asText(exported.bytes))
      .toBe(asText(MarkdownCollabContentAdapter.exportToFile(live)));
    expect(plain.text).toBe(MarkdownCollabContentAdapter.toPlainText(live));
    // Guards the hydration invariant: reading a populated doc headlessly used
    // to come back empty.
    expect(plain.text).toContain('Closing line.');
  });

  it('does not duplicate content when the same doc is converted twice', () => {
    const live = new Y.Doc();
    convertViaHost(live, 'seedFromFile', CORPUS);
    convertViaHost(live, 'applyFromFile', CORPUS);

    const text = asText(MarkdownCollabContentAdapter.exportToFile(live));
    expect(text.match(/Closing line\./g) ?? []).toHaveLength(1);
    expect(text.match(/bullet one/g) ?? []).toHaveLength(1);
  });
});
