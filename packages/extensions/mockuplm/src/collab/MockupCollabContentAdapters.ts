/**
 * MockupLM CollabContentAdapters
 *
 * Two adapters, one per documentType:
 *
 * - `mockup-html`     -> `.mockup.html` (Y.Text shape)
 * - `mockup-project`  -> `.mockupproject` (Y.Map<id, Y.Map> Pattern A)
 *
 * Both reuse the existing seed.ts helpers for read/write so the
 * adapter is a thin contract bridge and not a parallel
 * implementation.
 */
import type * as Y from 'yjs';
import type { CollabContentAdapter } from '@nimbalyst/extension-sdk';
import {
  Y_MOCKUP_HTML,
  Y_PROJECT_CONNECTIONS,
  Y_PROJECT_META,
  Y_PROJECT_MOCKUPS,
  getYMockupText,
  isMockupProjectYDocEmpty,
  isMockupYDocEmpty,
  readProjectFromYDoc,
  seedMockupProjectYDoc,
  seedMockupYDoc,
} from './seed';

function decodeSource(source: string | Uint8Array): string {
  if (typeof source === 'string') return source;
  try {
    return new TextDecoder('utf-8').decode(source);
  } catch {
    return '';
  }
}

export const MockupHtmlCollabContentAdapter: CollabContentAdapter = {
  documentType: 'mockup-html',
  fileExtensions: ['.mockup.html'],
  mimeType: 'text/html',
  layoutVersion: 1,

  isEmpty(yDoc) {
    return isMockupYDocEmpty(yDoc);
  },

  seedFromFile(yDoc, source) {
    seedMockupYDoc(yDoc, typeof source === 'string' ? source : source.buffer.slice(
      source.byteOffset,
      source.byteOffset + source.byteLength,
    ) as ArrayBuffer);
  },

  applyFromFile(yDoc, source) {
    const text = decodeSource(source);
    yDoc.transact(() => {
      const yText = yDoc.getText(Y_MOCKUP_HTML);
      if (yText.length > 0) yText.delete(0, yText.length);
      if (text.length > 0) yText.insert(0, text);
    });
  },

  exportToFile(yDoc) {
    return getYMockupText(yDoc).toString();
  },

  toPlainText(yDoc) {
    return getYMockupText(yDoc).toString();
  },
};

export const MockupProjectCollabContentAdapter: CollabContentAdapter = {
  documentType: 'mockup-project',
  fileExtensions: ['.mockupproject'],
  mimeType: 'application/json',
  layoutVersion: 1,

  isEmpty(yDoc) {
    return isMockupProjectYDocEmpty(yDoc);
  },

  seedFromFile(yDoc, source) {
    yDoc.transact(() => {
      seedMockupProjectYDoc(yDoc, typeof source === 'string' ? source : source.buffer.slice(
        source.byteOffset,
        source.byteOffset + source.byteLength,
      ) as ArrayBuffer);
    });
  },

  applyFromFile(yDoc, source) {
    yDoc.transact(() => {
      const yMockups = yDoc.getMap<Y.Map<unknown>>(Y_PROJECT_MOCKUPS);
      const yConnections = yDoc.getMap<Y.Map<unknown>>(Y_PROJECT_CONNECTIONS);
      const yMeta = yDoc.getMap<unknown>(Y_PROJECT_META);
      yMockups.forEach((_, key) => yMockups.delete(key));
      yConnections.forEach((_, key) => yConnections.delete(key));
      yMeta.forEach((_, key) => yMeta.delete(key));
      seedMockupProjectYDoc(yDoc, typeof source === 'string' ? source : source.buffer.slice(
        source.byteOffset,
        source.byteOffset + source.byteLength,
      ) as ArrayBuffer);
    });
  },

  exportToFile(yDoc) {
    return JSON.stringify(readProjectFromYDoc(yDoc), null, 2);
  },

  toPlainText(yDoc) {
    const file = readProjectFromYDoc(yDoc);
    const parts: string[] = [];
    if (file.name) parts.push(file.name);
    if (file.description) parts.push(file.description);
    for (const m of file.mockups) {
      parts.push(`${m.label}: ${m.path}`);
    }
    return parts.join('\n');
  },
};
