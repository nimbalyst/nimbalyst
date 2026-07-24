/**
 * CollabAssetUploader -- single encrypt + PUT path for collab-asset uploads.
 *
 * Factored out of `document-sync:upload-asset` so the new
 * `document-sync:migrate-local-assets` handler can reuse the exact same
 * encryption / metadata / header / wire format. Keeping one writer of the
 * collab-asset PUT route avoids accidental drift in the headers the
 * `collab-asset://` protocol handler expects on read.
 */
import { net } from "electron";
import { randomUUID } from "crypto";
import { logger } from "../utils/logger";
import { getOrgKey, getOrgKeyFingerprint } from "./OrgKeyService";
import { getOrgScopedJwt } from "./TeamService";

export interface EncryptAndUploadParams {
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

export type EncryptAndUploadResult =
  | { success: true; assetId: string; uri: string }
  | { success: false; error: string; errorCode: string; statusCode?: number };

/**
 * Encrypt body + metadata under the org key and PUT to the collab worker.
 * Returns the new asset's `collab-asset://` URI on success.
 *
 * Callers are responsible for:
 *   - authorization (`isCollabAssetDocumentRegisteredForSender` in the IPC layer)
 *   - the sender / payload validation pass
 *   - shaping the response for IPC (this helper returns a structured result
 *     and never throws across normal failure modes)
 */
export async function encryptAndUploadCollabAsset(
  params: EncryptAndUploadParams
): Promise<EncryptAndUploadResult> {
  try {
    const orgKey = await getOrgKey(params.orgId);
    if (!orgKey) {
      return {
        success: false,
        error: "No org encryption key cached",
        errorCode: "key_unavailable",
      };
    }

    const orgJwt = await getOrgScopedJwt(
      params.orgId,
      undefined,
      params.forceRefreshJwt
    );
    const assetId = params.assetId ?? randomUUID();

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      orgKey,
      params.fileBytes
    );

    const metaIv = crypto.getRandomValues(new Uint8Array(12));
    const metaPlain = new TextEncoder().encode(
      JSON.stringify({ name: params.fileName })
    );
    const metaCipher = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: metaIv },
      orgKey,
      metaPlain as BufferSource
    );

    const fingerprint = getOrgKeyFingerprint(params.orgId);

    const url =
      `${params.syncHttpUrl}/api/collab/docs/${encodeURIComponent(
        params.documentId
      )}` + `/assets/${encodeURIComponent(assetId)}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${orgJwt}`,
      "X-Collab-Asset-Iv": Buffer.from(iv).toString("base64"),
      "X-Collab-Asset-Metadata": Buffer.from(metaCipher).toString("base64"),
      "X-Collab-Asset-Metadata-Iv": Buffer.from(metaIv).toString("base64"),
      "X-Collab-Asset-Mime-Type": params.mimeType || "application/octet-stream",
      "X-Collab-Asset-Plaintext-Size": String(params.fileBytes.byteLength),
    };
    if (fingerprint) {
      headers["X-Collab-Asset-Key-Fingerprint"] = fingerprint;
    }

    const resp = await net.fetch(url, {
      method: "PUT",
      headers,
      body: ciphertext,
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      logger.main.warn(
        "[CollabAssetUploader] PUT failed",
        resp.status,
        errText
      );
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
