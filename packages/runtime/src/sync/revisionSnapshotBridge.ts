/**
 * RevisionSnapshotAdapter <- CollabContentAdapter bridge.
 *
 * The extension SDK has a small per-tab `RevisionSnapshotAdapter`
 * registered at editor-mount time. The generic
 * `CollabContentAdapter` registry can fully express the same
 * contract (and more), so the host can synthesise a tab adapter on
 * demand for any document type that has a registered content
 * adapter.
 *
 * Editors that want fine-grained control (custom snapshot format,
 * async restore) still register their own RevisionSnapshotAdapter
 * directly; this bridge is the default path for editors that don't.
 */
import type { Doc } from 'yjs';
import {
  getCollabContentAdapter,
  getRevisionSnapshotFns,
} from '@nimbalyst/collab-adapters';
import type { RevisionSnapshotAdapter } from '@nimbalyst/extension-sdk';

type RevisionPreviewKind = NonNullable<RevisionSnapshotAdapter['previewKind']>;

export interface CollabAdapterRevisionBridgeOptions {
  documentType: string;
  getYDoc: () => Doc | null;
  /** Override the snapshot format identifier. Defaults to the
   *  adapter's documentType. */
  contentFormat?: string;
  /** Override the preview kind. Defaults to 'text' (matches the
   *  toPlainText projection the dialog can render). */
  previewKind?: RevisionPreviewKind;
}

export function createRevisionAdapterFromCollabContent(
  options: CollabAdapterRevisionBridgeOptions,
): RevisionSnapshotAdapter | null {
  const adapter = getCollabContentAdapter(options.documentType);
  if (!adapter) return null;

  const { exportRevisionSnapshot, restoreRevisionSnapshot } =
    getRevisionSnapshotFns(adapter);

  return {
    contentFormat: options.contentFormat ?? adapter.documentType,
    previewKind: options.previewKind ?? 'text',
    exportRevisionSnapshot() {
      const yDoc = options.getYDoc();
      if (!yDoc) {
        throw new Error(
          `[revisionSnapshotBridge] Y.Doc unavailable for documentType=${options.documentType}`,
        );
      }
      return exportRevisionSnapshot(yDoc);
    },
    restoreRevisionSnapshot(plaintext: Uint8Array) {
      const yDoc = options.getYDoc();
      if (!yDoc) {
        throw new Error(
          `[revisionSnapshotBridge] Y.Doc unavailable for documentType=${options.documentType}`,
        );
      }
      restoreRevisionSnapshot(yDoc, plaintext);
    },
  };
}
