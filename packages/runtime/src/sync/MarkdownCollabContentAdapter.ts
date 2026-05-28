/**
 * MarkdownCollabContentAdapter
 *
 * Canonical adapter for the markdown shared-doc type. Bridges the
 * generic CollabContentAdapter contract to the Lexical headless
 * editor + enhanced-markdown transformers that the renderer uses
 * for live editing.
 *
 * Extracted from `CollabLocalOriginService` (which previously
 * hard-coded the markdown-only flow). The service now dispatches
 * through the registry; this adapter holds the markdown specifics.
 *
 * Snapshot/restore intentionally falls back to the default Y
 * state-vector pair via `getRevisionSnapshotFns` -- markdown does
 * not need a denser snapshot format because the Y.Doc tree carries
 * everything the editor reads.
 */
import { $getRoot } from 'lexical';
import type { Doc } from 'yjs';
import type { Provider } from '@lexical/yjs';
import type { CollabContentAdapter } from '@nimbalyst/collab-adapters';
import {
  $convertFromEnhancedMarkdownString,
  $convertToEnhancedMarkdownString,
  EditorNodes,
  getEditorTransformers,
} from '../editor';
import { HeadlessLexicalYDoc } from './HeadlessLexicalYDoc';

const NOOP_PROVIDER: Provider = {
  awareness: {
    getLocalState: () => null,
    getStates: () => new Map(),
    setLocalState: () => {},
    setLocalStateField: () => {},
    on: () => {},
    off: () => {},
  },
  connect: () => Promise.resolve(),
  disconnect: () => {},
  on: () => {},
  off: () => {},
} as unknown as Provider;

function withHeadless<T>(yDoc: Doc, fn: (headless: HeadlessLexicalYDoc) => T): T {
  const provider: Provider = {
    ...NOOP_PROVIDER,
    getYDoc: () => yDoc,
  } as Provider;
  const headless = new HeadlessLexicalYDoc({
    doc: yDoc,
    nodes: EditorNodes,
    provider,
  });
  try {
    return fn(headless);
  } finally {
    try { headless.destroy(); } catch { /* ignore */ }
  }
}

function toMarkdownString(source: string | Uint8Array): string {
  if (typeof source === 'string') return source;
  return new TextDecoder('utf-8').decode(source);
}

export const MarkdownCollabContentAdapter: CollabContentAdapter = {
  documentType: 'markdown',
  fileExtensions: ['.md', '.markdown'],
  mimeType: 'text/markdown',
  layoutVersion: 1,

  isEmpty(yDoc) {
    // The Lexical CollaborationPlugin convention is a top-level
    // 'main' XmlText/XmlElement; a fresh Y.Doc has no such root.
    const sharedTypes = Array.from(yDoc.share.keys());
    return sharedTypes.length === 0;
  },

  seedFromFile(yDoc, source) {
    const markdown = toMarkdownString(source);
    withHeadless(yDoc, (headless) => {
      headless.applyUpdate(() => {
        $getRoot().clear();
        $convertFromEnhancedMarkdownString(markdown, getEditorTransformers());
      });
    });
  },

  applyFromFile(yDoc, source) {
    // Default wipe-and-reseed semantics: markdown adapter does not
    // try to diff -- a single Y.Doc transaction so peers observe one
    // CRDT step.
    const markdown = toMarkdownString(source);
    withHeadless(yDoc, (headless) => {
      headless.applyUpdate(() => {
        $getRoot().clear();
        $convertFromEnhancedMarkdownString(markdown, getEditorTransformers());
      });
    });
  },

  exportToFile(yDoc) {
    return withHeadless(yDoc, (headless) => {
      return headless.editor.getEditorState().read(() => {
        return $convertToEnhancedMarkdownString(getEditorTransformers());
      });
    });
  },

  toPlainText(yDoc) {
    return withHeadless(yDoc, (headless) => {
      return headless.editor.getEditorState().read(() => {
        return $convertToEnhancedMarkdownString(getEditorTransformers());
      });
    });
  },
};
