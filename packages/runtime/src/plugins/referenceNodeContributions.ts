/**
 * The reference-node contributions every host that opens a Nimbalyst document
 * must publish: the two node classes a shared Y.Doc can contain, plus the
 * markdown transformers that round-trip them.
 *
 * Why this is one shared module rather than a list per host:
 *   A host that mounts the collaborative editor without these node classes does
 *   not merely lose a chip. `@lexical/yjs` throws ``Node <type> is not
 *   registered`` from inside the observer that `Y.applyUpdate` fires, so the
 *   first update carrying a reference aborts the binding and NOTHING paints.
 *   In the web console that surfaced as `[DocumentSync] Skipping undecodable
 *   update` — the payload had decrypted fine; the Lexical binding threw. The
 *   desktop app writes these nodes, so any second host has to understand them,
 *   and two hand-maintained lists would drift apart again.
 *
 * Only the portable half lives here. The interactive half — the `@`/`#`
 * typeahead pickers, the electron document service, the live tracker-store
 * lookup behind the chip — stays with the host that can actually provide it.
 * A host with no tracker store still renders references read-only via
 * `setTrackerReferenceNodeRenderer`.
 *
 * `HeadlessBodyNodes` solves the same class of problem for the main process and
 * is the closest precedent; it registers node CLASSES for the same reason.
 */

import { defineExtension } from 'lexical';

import { setExtensionContributions } from '../editor/extensions/extensionContributionsStore';
import { setExtensionLexicalExtension } from '../editor/extensions/extensionLexicalExtensionsStore';
import {
  DocumentReferenceNode,
  DocumentReferenceTransformer,
  CollabDocumentReferenceTransformer,
  LegacyDocumentReferenceTransformer,
} from './DocumentLinkPlugin/DocumentLinkNode';
import { TrackerReferenceNode } from './TrackerLinkPlugin/TrackerReferenceNode';
import { TrackerReferenceTransformer } from './TrackerLinkPlugin/TrackerReferenceTransformer';

export const TRACKER_LINK_SOURCE = 'tracker-link';
export const DOCUMENT_LINK_SOURCE = 'document-link';

/** Node class + markdown round-trip for `[NIM-123](nimbalyst://NIM-123)`. */
export function registerTrackerReferenceContributions(): void {
  setExtensionLexicalExtension(
    TRACKER_LINK_SOURCE,
    defineExtension({
      name: '@nimbalyst/tracker-link',
      nodes: [TrackerReferenceNode],
    }),
  );
  setExtensionContributions(TRACKER_LINK_SOURCE, {
    markdownTransformers: [TrackerReferenceTransformer],
  });
}

/** Node class + markdown round-trip for file and shared-document references. */
export function registerDocumentReferenceContributions(): void {
  setExtensionLexicalExtension(
    DOCUMENT_LINK_SOURCE,
    defineExtension({
      name: '@nimbalyst/document-link',
      nodes: [DocumentReferenceNode],
    }),
  );
  setExtensionContributions(DOCUMENT_LINK_SOURCE, {
    markdownTransformers: [
      // Main transformer exports as markdown links; the collab transformer
      // imports shared-doc references (`nimbalyst://doc/...` / `collab://...`);
      // the legacy transformer imports the old `[[wikilink]]`-style format
      // produced before the CommonMark migration.
      DocumentReferenceTransformer,
      CollabDocumentReferenceTransformer,
      LegacyDocumentReferenceTransformer,
    ],
  });
}

/** Both reference types — the minimum for opening any desktop-authored document. */
export function registerReferenceNodeContributions(): void {
  registerTrackerReferenceContributions();
  registerDocumentReferenceContributions();
}
