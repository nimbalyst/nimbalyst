/**
 * Bootstrap seeding for the Excalidraw collaborative Y.Doc.
 *
 * Called by `useCollaborativeEditor` when this client is the first to open
 * an `.excalidraw` collab document. The hook wraps this call in a
 * `yDoc.transact(..., COLLAB_INIT_ORIGIN)`, so the binding's own change
 * handler can recognise and ignore the seeding writes.
 *
 * Bootstrap-race safety: this routine MUST be deterministic given the same
 * input content. Two clients racing both call seed -> their CRDT updates
 * merge -> the merged shape is identical to either client's individual
 * shape (no duplicates). Achieved by:
 *   - Using each element's pre-existing `id` (Excalidraw assigns stable
 *     nanoid-style ids at creation; we never invent new ones here).
 *   - Using a fixed fractional-indexing key sequence derived from element
 *     order in the file (`generateNKeysBetween(null, null, n)` is
 *     deterministic for a given `n`).
 */

import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import { generateNKeysBetween } from 'fractional-indexing';
import * as Y from 'yjs';
import type { ExcalidrawFile } from '../types';

const EMPTY_FILE: ExcalidrawFile = {
  type: 'excalidraw',
  version: 2,
  source: 'https://excalidraw.com',
  elements: [],
  appState: {},
  files: {},
};

/**
 * Whether the Y.Doc has any Excalidraw content yet. Used as the
 * `useCollaborativeEditor` `isEmpty` guard so we don't re-seed a doc that
 * was just sync'd in.
 */
export function isExcalidrawYDocEmpty(yDoc: Y.Doc): boolean {
  return yDoc.getArray('elements').length === 0 && yDoc.getMap('assets').size === 0;
}

/**
 * Populate the Y.Doc from raw file content. MUST be called inside a
 * transaction with the SDK's COLLAB_INIT_ORIGIN.
 */
export function seedExcalidrawYDoc(
  yDoc: Y.Doc,
  content: string | ArrayBuffer,
): void {
  const file = parseExcalidrawFile(content);
  const yElements = yDoc.getArray<Y.Map<unknown>>('elements');
  const yAssets = yDoc.getMap<unknown>('assets');
  const yAppState = yDoc.getMap<unknown>('appState');

  const elements = (file.elements ?? []) as ExcalidrawElement[];
  if (elements.length > 0) {
    const keys = generateNKeysBetween(null, null, elements.length);
    for (let i = 0; i < elements.length; i++) {
      const m = new Y.Map<unknown>();
      m.set('el', { ...elements[i] });
      m.set('pos', keys[i]);
      yElements.push([m]);
    }
  }

  const assets = file.files ?? {};
  for (const [fileId, data] of Object.entries(assets)) {
    yAssets.set(fileId, data);
  }

  if (file.appState && typeof file.appState === 'object') {
    for (const [k, v] of Object.entries(file.appState)) {
      // Only persist primitive scalars in appState -- viewport state etc.
      // is per-client and shouldn't sync.
      if (k === 'viewBackgroundColor' || k === 'gridSize' || k === 'theme') {
        yAppState.set(k, v);
      }
    }
  }
}

function parseExcalidrawFile(content: string | ArrayBuffer): ExcalidrawFile {
  if (typeof content !== 'string') {
    try {
      const text = new TextDecoder().decode(content);
      return JSON.parse(text) as ExcalidrawFile;
    } catch {
      return EMPTY_FILE;
    }
  }
  if (!content.trim()) return EMPTY_FILE;
  try {
    return JSON.parse(content) as ExcalidrawFile;
  } catch {
    return EMPTY_FILE;
  }
}
