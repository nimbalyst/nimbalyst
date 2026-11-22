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
import { readWithoutCommentMarks } from './commentMarkExport';
import type { Transformer } from '@lexical/markdown';
import type { CollabContentAdapter } from '@nimbalyst/collab-adapters';
import {
  $convertFromEnhancedMarkdownString,
  $convertToEnhancedMarkdownString,
  HeadlessBodyNodes,
  getEditorTransformers,
} from '../editor';
import {
  CollabDocumentReferenceTransformer,
  DocumentReferenceTransformer,
  LegacyDocumentReferenceTransformer,
} from '../plugins/DocumentLinkPlugin/DocumentLinkNode';
import { TrackerReferenceTransformer } from '../plugins/TrackerLinkPlugin/TrackerReferenceTransformer';
import type { HeadlessLexicalYDoc } from './HeadlessLexicalYDoc';
import { withHeadlessLexicalBridge } from './withHeadlessLexicalBridge';

function getHeadlessEditorTransformers() {
  const requiredTransformers: Transformer[] = [
    // Must precede TrackerReferenceTransformer, whose nimbalyst:// matcher is
    // intentionally broad enough to otherwise claim shared-document links.
    CollabDocumentReferenceTransformer,
    TrackerReferenceTransformer,
    DocumentReferenceTransformer,
    LegacyDocumentReferenceTransformer,
  ];
  const requiredSet = new Set(requiredTransformers);
  return [
    ...requiredTransformers,
    ...getEditorTransformers().filter(
      (transformer) => !requiredSet.has(transformer),
    ),
  ];
}

/**
 * Run `fn` against a headless Lexical editor holding `yDoc`'s content.
 *
 * `HeadlessBodyNodes`, not `EditorNodes`: this adapter runs in the main
 * process, where the renderer's extension graph never registers the
 * list/link/hr/image nodes. With anything less than the minimal set, any list-
 * or link-bearing document threw "Node list is not registered" mid-import,
 * aborting the conversion and leaving the Y.Doc empty.
 */
function withHeadless<T>(yDoc: Doc, fn: (headless: HeadlessLexicalYDoc) => T): T {
  return withHeadlessLexicalBridge(yDoc, { nodes: HeadlessBodyNodes }, fn);
}

/**
 * The live document's markdown with comment marks treated as transparent, read
 * from a private copy when it has any so the live Y.Doc is never written. Uses
 * this adapter's own transformer set. See commentMarkExport.ts.
 */
function exportMarkdown(yDoc: Doc): string {
  return readWithoutCommentMarks(yDoc, withHeadless, () =>
    $convertToEnhancedMarkdownString(getHeadlessEditorTransformers()),
  );
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
    return exportMarkdown(yDoc);
  },

  toPlainText(yDoc) {
    return exportMarkdown(yDoc);
  },
};
