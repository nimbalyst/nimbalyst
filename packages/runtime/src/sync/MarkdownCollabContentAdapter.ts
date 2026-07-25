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
import { Doc as YDoc, applyUpdate, encodeStateAsUpdate } from 'yjs';
import type { Doc } from 'yjs';
import type { Provider } from '@lexical/yjs';
import type { CollabContentAdapter } from '@nimbalyst/collab-adapters';
import {
  $convertFromEnhancedMarkdownString,
  $convertToEnhancedMarkdownString,
  HeadlessBodyNodes,
  getEditorTransformers,
} from '../editor';
import { TrackerReferenceTransformer } from '../plugins/TrackerLinkPlugin/TrackerReferenceTransformer';
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

/** Origin for bridge traffic, so an update is never echoed back to its source. */
const BRIDGE_ORIGIN = Symbol('nimbalyst:markdown-adapter-bridge');

function getHeadlessEditorTransformers() {
  const transformers = getEditorTransformers();
  return transformers.includes(TrackerReferenceTransformer)
    ? transformers
    : [TrackerReferenceTransformer, ...transformers];
}

/**
 * Run `fn` against a headless Lexical editor holding `yDoc`'s content.
 *
 * Binds to a FRESH working doc and replays `yDoc`'s state into it, rather than
 * binding to `yDoc` directly. This is the same editor-doc bridge
 * `CollabLexicalProvider` uses in the renderer, and it exists for the same
 * reason (its FAILURE HISTORY note 1, NIM-1764): a binding only builds its
 * collab tree from updates it observes, so binding straight to an
 * already-populated doc yields an EMPTY editor state.
 *
 * That emptiness was silent and destructive: `exportToFile` / `toPlainText`
 * returned '' for every non-empty document, and `applyFromFile`'s
 * `$getRoot().clear()` was a no-op against content the editor had never seen.
 *
 * Edits made inside `fn` flow back to `yDoc` through the bridge, so callers
 * still observe their own doc being updated.
 */
function withHeadless<T>(yDoc: Doc, fn: (headless: HeadlessLexicalYDoc) => T): T {
  const workDoc = new YDoc();
  const provider: Provider = {
    ...NOOP_PROVIDER,
    getYDoc: () => workDoc,
  } as Provider;
  const headless = new HeadlessLexicalYDoc({
    // `HeadlessBodyNodes`, not `EditorNodes`: this adapter runs in the main
    // process, where the renderer's extension graph never registers the
    // list/link/hr/image nodes. With the minimal set, any list- or
    // link-bearing document threw "Node list is not registered" mid-import,
    // aborting the conversion and leaving the Y.Doc empty.
    doc: workDoc,
    nodes: HeadlessBodyNodes,
    provider,
  });

  // Step 1: replay the source state so the binding observes it and builds its
  // collab tree. Step 2: materialize that tree into the Lexical editor state.
  // Both are required -- see `hydrateFromYDoc`.
  applyUpdate(workDoc, encodeStateAsUpdate(yDoc), BRIDGE_ORIGIN);
  headless.hydrateFromYDoc();

  const forwardToSource = (update: Uint8Array, origin: unknown) => {
    if (origin === BRIDGE_ORIGIN) return;
    applyUpdate(yDoc, update, BRIDGE_ORIGIN);
  };
  workDoc.on('update', forwardToSource);

  try {
    return fn(headless);
  } finally {
    try { workDoc.off('update', forwardToSource); } catch { /* ignore */ }
    try { headless.destroy(); } catch { /* ignore */ }
    try { workDoc.destroy(); } catch { /* ignore */ }
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
        $convertFromEnhancedMarkdownString(
          markdown,
          getHeadlessEditorTransformers(),
        );
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
        $convertFromEnhancedMarkdownString(
          markdown,
          getHeadlessEditorTransformers(),
        );
      });
    });
  },

  exportToFile(yDoc) {
    return withHeadless(yDoc, (headless) => {
      return headless.editor.getEditorState().read(() => {
        return $convertToEnhancedMarkdownString(
          getHeadlessEditorTransformers(),
        );
      });
    });
  },

  toPlainText(yDoc) {
    return withHeadless(yDoc, (headless) => {
      return headless.editor.getEditorState().read(() => {
        return $convertToEnhancedMarkdownString(
          getHeadlessEditorTransformers(),
        );
      });
    });
  },
};
