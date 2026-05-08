/**
 * Collaborative document asset garbage collection.
 *
 * The renderer's AssetGCPlugin (debounced) emits the set of
 * `collab-asset://` URIs that have *disappeared* from the live Yjs doc
 * state since the previous scan. We delete exactly those R2 objects via
 * the worker's DELETE endpoint -- no diff against the server-side asset
 * list, no enumeration, no risk of deleting a still-live attachment that
 * a concurrent peer just inserted but our client hasn't received yet.
 *
 * Trade-off: assets uploaded but never referenced (e.g. pasted then
 * cut+removed inside the debounce window) leak. An out-of-band janitor
 * can sweep those later; the value of correctness here is much higher.
 */
import { net } from 'electron';
import { logger } from '../utils/logger';
import { parseCollabAssetUrl } from '../protocols/collabAssetProtocol';

/**
 * Delete a specific list of `collab-asset://` URIs for one document.
 *
 * @returns Counts: `{ requested, deleted, failed, skipped }`. `skipped`
 *   counts URIs that didn't parse or referenced a different document
 *   than `documentId` (defensive: never delete cross-doc).
 */
export async function deleteRemovedAssets(
  httpUrl: string,
  orgJwt: string,
  documentId: string,
  removedUris: string[]
): Promise<{ requested: number; deleted: number; failed: number; skipped: number }> {
  let deleted = 0;
  let failed = 0;
  let skipped = 0;

  for (const uri of removedUris) {
    const parsed = parseCollabAssetUrl(uri);
    if (!parsed || parsed.documentId !== documentId) {
      // Skip URIs that don't parse or that target a different document.
      // Defense in depth: a misbehaving client should never be able to
      // direct us to delete assets in another doc's bucket.
      skipped += 1;
      continue;
    }

    const deleteUrl =
      `${httpUrl}/api/collab/docs/${encodeURIComponent(documentId)}` +
      `/assets/${encodeURIComponent(parsed.assetId)}`;
    try {
      const resp = await net.fetch(deleteUrl, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${orgJwt}` },
      });
      if (!resp.ok) {
        failed += 1;
        const body = await resp.text().catch(() => '');
        logger.main.warn('[CollabAssetGC] Delete failed', { documentId, assetId: parsed.assetId, status: resp.status, body });
      } else {
        deleted += 1;
      }
    } catch (err) {
      failed += 1;
      logger.main.warn('[CollabAssetGC] Delete threw', { documentId, assetId: parsed.assetId, err });
    }
  }

  if (deleted > 0 || failed > 0 || skipped > 0) {
    logger.main.info('[CollabAssetGC] sweep', {
      documentId,
      requested: removedUris.length,
      deleted,
      failed,
      skipped,
    });
  }

  return { requested: removedUris.length, deleted, failed, skipped };
}
