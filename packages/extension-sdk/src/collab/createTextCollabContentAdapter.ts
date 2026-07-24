/**
 * createTextCollabContentAdapter
 *
 * Factory for the common case: a text-first document whose entire content
 * lives in a single `Y.Text`. This is the same shape the CSV spreadsheet
 * adapter uses, generalized so any plain-text / source-style editor (Monaco,
 * CodeMirror, a textarea) can become collaborative without hand-writing a
 * CollabContentAdapter.
 *
 * Pair it with a live binding (e.g. `createMonacoCollabBinding` from
 * `@nimbalyst/runtime`) that wires the editor model to the SAME `Y.Text`
 * field this adapter reads/writes.
 *
 * Bootstrap-race safety: two clients opening an empty doc both seed the same
 * file text into `Y.Text`; Y.Text's char-level CRDT merges identical inserts
 * as a no-op, so there is no duplication.
 */
import * as Y from 'yjs';
import type {
  CollabAdapterDescriptor,
  CollabContentAdapter,
  CollabContentFileSource,
} from '../types/collab.js';

/** Default `Y.Text` field name used when none is supplied. */
export const TEXT_COLLAB_DEFAULT_FIELD = 'content';

export interface TextCollabContentAdapterOptions {
  /** Logical document type. Matches the shared doc's documentType and, by
   *  convention, the custom-editor suffix without its dot (e.g. 'calc.md'). */
  documentType: string;
  /** On-disk extensions this adapter is the codec for (leading dot). The
   *  first entry is the default for save-a-copy / export. */
  fileExtensions: string[];
  /** Optional MIME type for save dialogs / asset uploads. */
  mimeType?: string;
  /** Y.Text field name carrying the document text. Default 'content'. The
   *  live binding MUST use the same field. */
  textField?: string;
  /** Layout schema version. Default 1. */
  layoutVersion?: number;
}

function decodeSource(source: CollabContentFileSource): string {
  if (typeof source === 'string') return source;
  try {
    return new TextDecoder('utf-8').decode(source);
  } catch {
    return '';
  }
}

export function createTextCollabContentAdapter(
  options: TextCollabContentAdapterOptions,
): CollabContentAdapter {
  const field = options.textField ?? TEXT_COLLAB_DEFAULT_FIELD;
  const layoutVersion = options.layoutVersion ?? 1;
  const getText = (yDoc: Y.Doc): Y.Text => yDoc.getText(field);

  return {
    documentType: options.documentType,
    fileExtensions: options.fileExtensions,
    mimeType: options.mimeType,
    layoutVersion,

    // Lets the host rebuild this adapter in another process (e.g. Electron
    // main) without loading the extension. See reconstruct fn below.
    serializableDescriptor: {
      kind: 'text',
      documentType: options.documentType,
      fileExtensions: options.fileExtensions,
      mimeType: options.mimeType,
      textField: field,
      layoutVersion,
    },

    isEmpty(yDoc) {
      return getText(yDoc).length === 0;
    },

    seedFromFile(yDoc, source) {
      const text = decodeSource(source);
      if (!text) return;
      const yText = getText(yDoc);
      // Guard against a concurrent seed during the open race.
      if (yText.length > 0) return;
      yText.insert(0, text);
    },

    applyFromFile(yDoc, source) {
      const text = decodeSource(source);
      yDoc.transact(() => {
        const yText = getText(yDoc);
        if (yText.length > 0) yText.delete(0, yText.length);
        if (text.length > 0) yText.insert(0, text);
      });
    },

    exportToFile(yDoc) {
      return getText(yDoc).toString();
    },

    toPlainText(yDoc) {
      return getText(yDoc).toString();
    },
  };
}

/**
 * Rebuild a CollabContentAdapter from a serializable descriptor (produced by a
 * host factory and shipped across the process boundary). Returns null for an
 * unknown descriptor kind so callers can fall back gracefully.
 */
export function reconstructCollabContentAdapterFromDescriptor(
  descriptor: CollabAdapterDescriptor,
): CollabContentAdapter | null {
  if (descriptor.kind === 'text') {
    return createTextCollabContentAdapter({
      documentType: descriptor.documentType,
      fileExtensions: descriptor.fileExtensions,
      mimeType: descriptor.mimeType,
      textField: descriptor.textField,
      layoutVersion: descriptor.layoutVersion,
    });
  }
  return null;
}
