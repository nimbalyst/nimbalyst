/**
 * CSV CollabContentAdapter
 *
 * Bridges the generic Y.Doc content contract to the single
 * `Y.Text('csv')` layout used by the spreadsheet editor.
 */
import type * as Y from 'yjs';
import type { CollabContentAdapter } from '@nimbalyst/extension-sdk';
import {
  Y_CSV_TEXT,
  getYCsv,
  isCsvYDocEmpty,
  seedCsvYDoc,
} from './seed';

function decodeSource(source: string | Uint8Array): string {
  if (typeof source === 'string') return source;
  try {
    return new TextDecoder('utf-8').decode(source);
  } catch {
    return '';
  }
}

export const CsvCollabContentAdapter: CollabContentAdapter = {
  documentType: 'csv',
  fileExtensions: ['.csv'],
  mimeType: 'text/csv',
  layoutVersion: 1,

  isEmpty(yDoc: Y.Doc) {
    return isCsvYDocEmpty(yDoc);
  },

  seedFromFile(yDoc: Y.Doc, source) {
    seedCsvYDoc(yDoc, typeof source === 'string' ? source : source.buffer.slice(
      source.byteOffset,
      source.byteOffset + source.byteLength,
    ) as ArrayBuffer);
  },

  applyFromFile(yDoc: Y.Doc, source) {
    const text = decodeSource(source);
    yDoc.transact(() => {
      const yText = yDoc.getText(Y_CSV_TEXT);
      if (yText.length > 0) {
        yText.delete(0, yText.length);
      }
      if (text.length > 0) {
        yText.insert(0, text);
      }
    });
  },

  exportToFile(yDoc: Y.Doc) {
    return getYCsv(yDoc).toString();
  },

  toPlainText(yDoc: Y.Doc) {
    return getYCsv(yDoc).toString();
  },
};
