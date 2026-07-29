/**
 * CollabAssetUploader -- the single PUT path for collab-asset uploads.
 *
 * Factored out of `document-sync:upload-asset` so the asset outbox drainer and
 * the `document-sync:migrate-local-assets` handler reuse the exact same
 * metadata / header / wire format. Keeping one writer of the collab-asset PUT
 * route avoids drift against what the `collab-asset://` protocol handler
 * expects on read.
 *
 * Custody model (NIM-2235): the client does NO crypto. Bytes go up as-is over
 * TLS; the collab server encrypts them at rest under the team DEK inside the
 * DocumentRoom Durable Object, the same protection tracker and document content
 * already get. The retired client-managed org key this path used to encrypt
 * under is gone and has no replacement on this side of the wire.
 */
import { net } from "electron";
import { randomUUID } from "crypto";
import { logger } from "../utils/logger";
import { getOrgScopedJwt } from "./TeamService";
import {
  COLLAB_ASSET_WIRE_FORMAT_PLAINTEXT,
  COLLAB_ASSET_HEADER_FILE_NAME,
  COLLAB_ASSET_HEADER_WIRE_FORMAT,
  COLLAB_ASSET_HEADER_MIME,
  COLLAB_ASSET_HEADER_PLAINTEXT_SIZE,
  MAX_COLLAB_ASSET_FILE_NAME_LENGTH,
} from "../../shared/collabAssetFormat";

export interface UploadCollabAssetParams {
  orgId: string;
  documentId: string;
  fileBytes: ArrayBuffer;
  mimeType: string;
  fileName: string;
  /** Base URL of the collab worker (https://sync.nimbalyst.com / http://localhost:8790). */
  syncHttpUrl: string;
  /** Stable ID supplied by the durable asset outbox. Omit for legacy direct uploads. */
  assetId?: string;
  /** Retry a rejected request with a freshly exchanged org-scoped JWT. */
  forceRefreshJwt?: boolean;
}

export type UploadCollabAssetResult =
  | { success: true; assetId: string; uri: string }
  | { success: false; error: string; errorCode: string; statusCode?: number };

/**
 * Truncate to what the server accepts rather than letting the PUT 400 on a
 * long name. The bytes are the point; the filename is decoration for download
 * flows, and losing its tail is better than losing the attachment.
 */
function boundedFileName(fileName: string, assetId: string): string {
  const candidate = fileName.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!candidate) return assetId;
  return candidate.slice(0, MAX_COLLAB_ASSET_FILE_NAME_LENGTH);
}

/**
 * PUT a shared-document attachment to the collab worker.
 *
 * Callers are responsible for:
 *   - authorization (`isCollabAssetDocumentRegisteredForSender` in the IPC layer)
 *   - the sender / payload validation pass
 *   - shaping the response for IPC (this helper returns a structured result
 *     and never throws across normal failure modes)
 */
export async function uploadCollabAsset(
  params: UploadCollabAssetParams
): Promise<UploadCollabAssetResult> {
  try {
    const orgJwt = await getOrgScopedJwt(
      params.orgId,
      undefined,
      params.forceRefreshJwt
    );
    const assetId = params.assetId ?? randomUUID();

    const url =
      `${params.syncHttpUrl}/api/collab/docs/${encodeURIComponent(
        params.documentId
      )}` + `/assets/${encodeURIComponent(assetId)}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${orgJwt}`,
      [COLLAB_ASSET_HEADER_WIRE_FORMAT]: COLLAB_ASSET_WIRE_FORMAT_PLAINTEXT,
      // Header values are latin-1 on the wire; percent-encode so a non-ASCII
      // filename survives the round trip.
      [COLLAB_ASSET_HEADER_FILE_NAME]: encodeURIComponent(
        boundedFileName(params.fileName, assetId)
      ),
      [COLLAB_ASSET_HEADER_MIME]:
        params.mimeType || "application/octet-stream",
      [COLLAB_ASSET_HEADER_PLAINTEXT_SIZE]: String(params.fileBytes.byteLength),
    };

    const resp = await net.fetch(url, {
      method: "PUT",
      headers,
      body: params.fileBytes,
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      logger.main.warn("[CollabAssetUploader] PUT failed", resp.status, errText);
      return {
        success: false,
        error: errText || `Upload failed (${resp.status})`,
        errorCode: `http_${resp.status}`,
        statusCode: resp.status,
      };
    }

    return {
      success: true,
      assetId,
      uri: `collab-asset://doc/${params.documentId}/asset/${assetId}`,
    };
  } catch (err) {
    logger.main.error("[CollabAssetUploader] threw", err);
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      errorCode: "transport_error",
    };
  }
}
