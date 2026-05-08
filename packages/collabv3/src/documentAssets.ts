import type { Env } from './types';
import type { AuthResult } from './auth';
import { createLogger } from './logger';

const log = createLogger('documentAssets');

const MAX_ASSET_SIZE_BYTES = 25 * 1024 * 1024;
const HEADER_IV = 'X-Collab-Asset-Iv';
const HEADER_METADATA = 'X-Collab-Asset-Metadata';
const HEADER_METADATA_IV = 'X-Collab-Asset-Metadata-Iv';
const HEADER_MIME = 'X-Collab-Asset-Mime-Type';
const HEADER_PLAINTEXT_SIZE = 'X-Collab-Asset-Plaintext-Size';
const HEADER_KEY_FINGERPRINT = 'X-Collab-Asset-Key-Fingerprint';
const HEADER_ROTATED_AT = 'X-Collab-Asset-Rotated-At';

interface StoredAssetMetadata {
  assetId: string;
  r2Key: string;
  ciphertextSize: number;
  plaintextSize: number | null;
  mimeType: string | null;
  encryptedMetadata: string | null;
  metadataIv: string | null;
  createdAt: number;
  updatedAt: number;
  keyFingerprint?: string | null;
  rotatedAt?: number | null;
}

function getDocumentRoomStub(env: Env, orgId: string, documentId: string): DurableObjectStub {
  const roomId = `org:${orgId}:doc:${documentId}`;
  const id = env.DOCUMENT_ROOM.idFromName(roomId);
  return env.DOCUMENT_ROOM.get(id);
}

function buildInternalUrl(request: Request, auth: AuthResult, documentId: string, suffix: string): string {
  const url = new URL(request.url);
  url.pathname = `/sync/org:${auth.orgId}:doc:${documentId}/internal/assets${suffix}`;
  url.searchParams.set('user_id', auth.userId);
  url.searchParams.set('org_id', auth.orgId);
  return url.toString();
}

function withJsonHeaders(corsHeaders: Record<string, string>): Record<string, string> {
  return {
    ...corsHeaders,
    'Content-Type': 'application/json',
  };
}

function withAssetHeaders(
  corsHeaders: Record<string, string>,
  metadata: StoredAssetMetadata
): Headers {
  const headers = new Headers(corsHeaders);
  headers.set('Content-Type', 'application/octet-stream');
  headers.set(
    'Access-Control-Expose-Headers',
    [
      HEADER_IV,
      HEADER_METADATA,
      HEADER_METADATA_IV,
      HEADER_MIME,
      HEADER_PLAINTEXT_SIZE,
      'Content-Type',
      'Content-Length',
    ].join(', ')
  );
  if (metadata.encryptedMetadata) {
    headers.set(HEADER_METADATA, metadata.encryptedMetadata);
  }
  if (metadata.metadataIv) {
    headers.set(HEADER_METADATA_IV, metadata.metadataIv);
  }
  if (metadata.mimeType) {
    headers.set(HEADER_MIME, metadata.mimeType);
  }
  if (metadata.plaintextSize !== null) {
    headers.set(HEADER_PLAINTEXT_SIZE, String(metadata.plaintextSize));
  }
  return headers;
}

function parsePositiveInt(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  return parsed;
}

async function getStoredAssetMetadata(
  request: Request,
  env: Env,
  auth: AuthResult,
  documentId: string,
  assetId: string
): Promise<StoredAssetMetadata | null> {
  const stub = getDocumentRoomStub(env, auth.orgId, documentId);
  const response = await stub.fetch(
    new Request(buildInternalUrl(request, auth, documentId, `/${assetId}`), {
      method: 'GET',
    })
  );

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`Failed to load asset metadata: ${response.status}`);
  }

  return await response.json() as StoredAssetMetadata;
}

/**
 * PUT /api/collab/docs/{documentId}/assets/{assetId}
 */
export async function handleUploadDocumentAsset(
  request: Request,
  env: Env,
  auth: AuthResult,
  corsHeaders: Record<string, string>,
  documentId: string,
  assetId: string
): Promise<Response> {
  const jsonHeaders = withJsonHeaders(corsHeaders);

  const iv = request.headers.get(HEADER_IV);
  const encryptedMetadata = request.headers.get(HEADER_METADATA);
  const metadataIv = request.headers.get(HEADER_METADATA_IV);
  const mimeType = request.headers.get(HEADER_MIME);
  const plaintextSize = parsePositiveInt(request.headers.get(HEADER_PLAINTEXT_SIZE));
  const keyFingerprint = request.headers.get(HEADER_KEY_FINGERPRINT);
  const rotatedAt = parsePositiveInt(request.headers.get(HEADER_ROTATED_AT));

  if (!iv) {
    return new Response(JSON.stringify({ error: `Missing ${HEADER_IV}` }), { status: 400, headers: jsonHeaders });
  }

  const body = await request.arrayBuffer();
  if (body.byteLength === 0) {
    return new Response(JSON.stringify({ error: 'Empty body' }), { status: 400, headers: jsonHeaders });
  }

  if (body.byteLength > MAX_ASSET_SIZE_BYTES) {
    return new Response(JSON.stringify({ error: 'Asset too large' }), { status: 413, headers: jsonHeaders });
  }

  const r2Key = `document-assets/${auth.orgId}/${documentId}/${assetId}.bin`;

  try {
    await env.DOCUMENT_ASSETS.put(r2Key, body, {
      httpMetadata: {
        contentType: 'application/octet-stream',
      },
      customMetadata: {
        iv,
        mimeType: mimeType ?? '',
      },
    });

    const stub = getDocumentRoomStub(env, auth.orgId, documentId);
    const metadataResponse = await stub.fetch(
      new Request(buildInternalUrl(request, auth, documentId, `/${assetId}`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assetId,
          r2Key,
          ciphertextSize: body.byteLength,
          plaintextSize,
          mimeType,
          encryptedMetadata,
          metadataIv,
          keyFingerprint,
          rotatedAt,
        }),
      })
    );

    if (!metadataResponse.ok) {
      await env.DOCUMENT_ASSETS.delete(r2Key);
      const errorText = await metadataResponse.text();
      throw new Error(errorText || `Metadata write failed: ${metadataResponse.status}`);
    }

    return new Response(
      JSON.stringify({
        success: true,
        assetId,
        uri: `collab-asset://doc/${documentId}/asset/${assetId}`,
      }),
      { status: 200, headers: jsonHeaders }
    );
  } catch (err) {
    log.error('Upload failed for asset', assetId, err);
    return new Response(JSON.stringify({ error: 'Upload failed' }), {
      status: 500,
      headers: jsonHeaders,
    });
  }
}

/**
 * GET /api/collab/docs/{documentId}/assets/{assetId}
 */
export async function handleGetDocumentAsset(
  request: Request,
  env: Env,
  auth: AuthResult,
  corsHeaders: Record<string, string>,
  documentId: string,
  assetId: string
): Promise<Response> {
  try {
    const metadata = await getStoredAssetMetadata(request, env, auth, documentId, assetId);
    if (!metadata || !metadata.r2Key) {
      return new Response('Not found', { status: 404, headers: corsHeaders });
    }

    const object = await env.DOCUMENT_ASSETS.get(metadata.r2Key);
    if (!object) {
      return new Response('Not found', { status: 404, headers: corsHeaders });
    }

    const headers = withAssetHeaders(corsHeaders, metadata);
    const iv = object.customMetadata?.iv;
    if (iv) {
      headers.set(HEADER_IV, iv);
    }

    return new Response(object.body, {
      status: 200,
      headers,
    });
  } catch (err) {
    log.error('Asset fetch failed for', assetId, err);
    return new Response('Fetch failed', { status: 500, headers: corsHeaders });
  }
}

/**
 * DELETE /api/collab/docs/{documentId}/assets/{assetId}
 */
export async function handleDeleteDocumentAsset(
  request: Request,
  env: Env,
  auth: AuthResult,
  corsHeaders: Record<string, string>,
  documentId: string,
  assetId: string
): Promise<Response> {
  const jsonHeaders = withJsonHeaders(corsHeaders);

  try {
    const metadata = await getStoredAssetMetadata(request, env, auth, documentId, assetId);
    if (!metadata) {
      return new Response(JSON.stringify({ success: true }), { status: 200, headers: jsonHeaders });
    }

    if (metadata.r2Key) {
      await env.DOCUMENT_ASSETS.delete(metadata.r2Key);
    }

    const stub = getDocumentRoomStub(env, auth.orgId, documentId);
    const deleteResponse = await stub.fetch(
      new Request(buildInternalUrl(request, auth, documentId, `/${assetId}`), {
        method: 'DELETE',
      })
    );

    if (!deleteResponse.ok) {
      const errorText = await deleteResponse.text();
      throw new Error(errorText || `Delete failed: ${deleteResponse.status}`);
    }

    return new Response(JSON.stringify({ success: true }), { status: 200, headers: jsonHeaders });
  } catch (err) {
    log.error('Asset delete failed for', assetId, err);
    return new Response(JSON.stringify({ error: 'Delete failed' }), {
      status: 500,
      headers: jsonHeaders,
    });
  }
}
