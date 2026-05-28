/**
 * Excalidraw CollabContentAdapter
 *
 * Bridges the generic Y.Doc content contract to the Excalidraw
 * Y.Array<Y.Map> + Y.Map layout used by the renderer.
 *
 * `applyFromFile` is the default wipe-and-reseed -- per-element
 * diffing already exists in `excalidrawDiff.ts` and is used by the
 * live editor, but a `re-upload from local source` operation is
 * coarse-grained (replace everything) so a single transactional
 * clear + seed is appropriate.
 */
import type * as Y from 'yjs';
import type { CollabContentAdapter } from '@nimbalyst/extension-sdk';
import type { ExcalidrawFile } from '../types';
import { yjsToExcalidraw } from './excalidrawHelpers';
import {
  isExcalidrawYDocEmpty,
  seedExcalidrawYDoc,
} from './seed';

function decodeSource(source: string | Uint8Array): string {
  if (typeof source === 'string') return source;
  try {
    return new TextDecoder('utf-8').decode(source);
  } catch {
    return '';
  }
}

function projectAppState(yAppState: Y.Map<unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  yAppState.forEach((v, k) => { out[k] = v; });
  return out;
}

function projectAssets(yAssets: Y.Map<unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  yAssets.forEach((v, k) => { out[k] = v; });
  return out;
}

function projectToFile(yDoc: Y.Doc): ExcalidrawFile {
  const yElements = yDoc.getArray<Y.Map<unknown>>('elements');
  const yAssets = yDoc.getMap<unknown>('assets');
  const yAppState = yDoc.getMap<unknown>('appState');
  return {
    type: 'excalidraw',
    version: 2,
    source: 'https://excalidraw.com',
    elements: yjsToExcalidraw(yElements),
    appState: projectAppState(yAppState) as ExcalidrawFile['appState'],
    files: projectAssets(yAssets) as ExcalidrawFile['files'],
  };
}

export const ExcalidrawCollabContentAdapter: CollabContentAdapter = {
  documentType: 'excalidraw',
  fileExtensions: ['.excalidraw'],
  mimeType: 'application/json',
  layoutVersion: 1,

  isEmpty(yDoc) {
    return isExcalidrawYDocEmpty(yDoc);
  },

  seedFromFile(yDoc, source) {
    const text = decodeSource(source);
    yDoc.transact(() => {
      seedExcalidrawYDoc(yDoc, text);
    });
  },

  applyFromFile(yDoc, source) {
    const text = decodeSource(source);
    yDoc.transact(() => {
      const yElements = yDoc.getArray<Y.Map<unknown>>('elements');
      const yAssets = yDoc.getMap<unknown>('assets');
      const yAppState = yDoc.getMap<unknown>('appState');
      if (yElements.length > 0) yElements.delete(0, yElements.length);
      yAssets.forEach((_, key) => yAssets.delete(key));
      yAppState.forEach((_, key) => yAppState.delete(key));
      seedExcalidrawYDoc(yDoc, text);
    });
  },

  exportToFile(yDoc) {
    return JSON.stringify(projectToFile(yDoc), null, 2);
  },

  toPlainText(yDoc) {
    const file = projectToFile(yDoc);
    const labels: string[] = [];
    for (const element of file.elements) {
      const e = element as { type?: string; text?: string; label?: { text?: string } };
      if (typeof e.text === 'string' && e.text.length > 0) labels.push(e.text);
      if (e.label?.text) labels.push(e.label.text);
    }
    return labels.join('\n');
  },
};
