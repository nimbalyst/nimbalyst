/**
 * CollabAssetService
 *
 * Thin renderer-side facade over the `documentSync.uploadAsset` IPC.
 * All encryption + network I/O happens in main; the renderer only hands off
 * the bytes and gets back an `collab-asset://` URI to insert into the doc.
 *
 * Image rendering: `<img src="collab-asset://...">` is handled natively by
 * the main-process protocol handler (see `protocols/collabAssetProtocol.ts`).
 * No `resolveImageSrc` shim is needed.
 *
 * Anchor link clicks: handled by `window.open(href)`, which Chromium routes
 * to the same protocol. No custom plugin required.
 */
import type { UploadedEditorAsset } from '@nimbalyst/runtime';
import type { CollabDocumentConfig } from '../utils/collabDocumentOpener';

export class CollabAssetService {
  constructor(private readonly config: CollabDocumentConfig) {}

  async uploadFile(file: File): Promise<UploadedEditorAsset> {
    const fileBytes = await file.arrayBuffer();
    const mimeType = file.type || 'application/octet-stream';

    const result = await window.electronAPI.documentSync.uploadAsset({
      orgId: this.config.orgId,
      documentId: this.config.documentId,
      fileBytes,
      mimeType,
      fileName: file.name,
    });

    if (!result.success || !result.uri) {
      throw new Error(result.error || 'Attachment upload failed');
    }

    return {
      kind: mimeType.startsWith('image/') ? 'image' : 'file',
      src: result.uri,
      name: file.name,
      altText: file.name,
    };
  }

  /**
   * Notify main that these specific `collab-asset://` URIs disappeared
   * from the live editor state since the previous scan. Main deletes
   * exactly those R2 objects -- no diff against the server-side asset
   * list, so concurrent inserts on other peers are not at risk.
   */
  async notifyAssetReferencesRemoved(removedUris: string[]): Promise<void> {
    if (removedUris.length === 0) return;
    await window.electronAPI.documentSync.gcAssets({
      orgId: this.config.orgId,
      documentId: this.config.documentId,
      removedUris,
    });
  }
}
