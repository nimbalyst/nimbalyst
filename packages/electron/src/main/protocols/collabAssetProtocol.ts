/**
 * `collab-asset://` custom protocol — E2E-encrypted document attachment bridge.
 *
 * Mirrors the `nim-asset://` pattern (see `nimAssetProtocol.ts`). The renderer
 * loads `<img src="collab-asset://doc/{documentId}/asset/{assetId}">` and
 * Chromium routes the request to this handler in main, where we:
 *   1. Translate `documentId` → `orgId` via the per-window registry.
 *   2. Fetch the encrypted asset from `sync.nimbalyst.com` with the org-scoped JWT.
 *   3. Decrypt the body + metadata using the cached org key.
 *   4. Hand the plaintext bytes back to the renderer with the right Content-Type.
 *
 * Why a custom protocol: the production worker only allows CORS from
 * `https://app.nimbalyst.com`, `https://nimbalyst.com`, `capacitor://localhost`.
 * The renderer at `http://localhost:5273` (dev) / `file://` (packaged) is
 * disallowed. Routing through main same-origins the request from Chromium's
 * perspective and lets us keep `webSecurity: true`.
 *
 * Auth gate: a renderer cannot probe assets for a doc the user has not
 * opened. The registry is populated by `document-sync:open` and torn down
 * by `document-sync:close-doc` from the tab unmount.
 */
import { protocol, net } from "electron";

export const COLLAB_ASSET_SCHEME = "collab-asset";
export const COLLAB_ASSET_HOST = "doc";

const HEADER_IV = "X-Collab-Asset-Iv";
const HEADER_METADATA = "X-Collab-Asset-Metadata";
const HEADER_METADATA_IV = "X-Collab-Asset-Metadata-Iv";
const HEADER_MIME = "X-Collab-Asset-Mime-Type";
const HEADER_PLAINTEXT_SIZE = "X-Collab-Asset-Plaintext-Size";

export interface ParsedCollabAssetUrl {
  documentId: string;
  assetId: string;
}

interface RegistryEntry {
  orgId: string;
  refCount: number;
}

/**
 * Per-WebContents registry of opened documents. Keyed by webContents.id
 * so the IPC handlers (upload-asset, gc-assets, close-doc) can authorize
 * by sender -- a malicious renderer in window A cannot upload or
 * garbage-collect assets in a doc that only window B has opened.
 *
 * Note: the `protocol.handle` callback in current Electron does not
 * receive the requesting WebContents (see electron/electron#41472), so
 * the protocol-level authorization (`isCollabAssetDocumentRegistered`)
 * uses the union of all senders. This matches the existing `nim-asset://`
 * pattern (process-global allowlist) and is acceptable for our trust
 * model: all renderers are bundled by us. The IPC layer is where we can
 * enforce per-window scoping, and we do.
 */
const senderRegistry = new Map<number, Map<string, RegistryEntry>>();

/**
 * Sentinel sender ID for legacy callers that don't have a webContents
 * context (currently none). Kept separate from real webContents IDs so a
 * future WebContents whose ID happens to match doesn't gain a free pass.
 */
const ANONYMOUS_SENDER = -1;

/**
 * Pure-function URL parser. Exposed for unit tests and reused by the handler.
 *
 * Returns null if the input is not a well-formed
 * `collab-asset://doc/{documentId}/asset/{assetId}` URL.
 */
export function parseCollabAssetUrl(url: string): ParsedCollabAssetUrl | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${COLLAB_ASSET_SCHEME}:`) return null;
  if (parsed.hostname !== COLLAB_ASSET_HOST) return null;

  const match = parsed.pathname.match(/^\/([^/]+)\/asset\/([^/]+)$/);
  if (!match) return null;

  try {
    return {
      documentId: decodeURIComponent(match[1]),
      assetId: decodeURIComponent(match[2]),
    };
  } catch {
    return null;
  }
}

/**
 * Register `(orgId, documentId)` for one sender (typically a renderer's
 * webContents.id). Refcounted per-sender so a single window opening the
 * same doc twice can decrement cleanly. Pass `ANONYMOUS_SENDER` for
 * non-IPC callers (currently none).
 */
export function registerCollabAssetDocument(
  orgId: string,
  documentId: string,
  senderId: number = ANONYMOUS_SENDER
): void {
  if (!orgId || !documentId) return;
  let docs = senderRegistry.get(senderId);
  if (!docs) {
    docs = new Map();
    senderRegistry.set(senderId, docs);
  }
  const existing = docs.get(documentId);
  if (existing) {
    if (existing.orgId !== orgId) {
      console.warn(
        "[collab-asset] documentId reused under a different orgId for the same sender; replacing entry",
        { senderId, documentId, oldOrgId: existing.orgId, newOrgId: orgId }
      );
      docs.set(documentId, { orgId, refCount: 1 });
      return;
    }
    existing.refCount += 1;
    return;
  }
  docs.set(documentId, { orgId, refCount: 1 });
}

/**
 * Decrement the per-sender refcount; remove the entry once it hits zero.
 * Idempotent past zero.
 */
export function unregisterCollabAssetDocument(
  documentId: string,
  senderId: number = ANONYMOUS_SENDER
): void {
  if (!documentId) return;
  const docs = senderRegistry.get(senderId);
  if (!docs) return;
  const existing = docs.get(documentId);
  if (!existing) return;
  existing.refCount -= 1;
  if (existing.refCount <= 0) {
    docs.delete(documentId);
    if (docs.size === 0) senderRegistry.delete(senderId);
  }
}

/**
 * Drop every entry for a sender. Call from the renderer's
 * `webContents.on('destroyed')` handler so a closed window's registrations
 * don't outlive the window.
 */
export function clearCollabAssetSender(senderId: number): void {
  senderRegistry.delete(senderId);
}

/**
 * Per-sender authorization check. Used by IPC handlers (upload-asset,
 * gc-assets) so a renderer in window A cannot operate on a doc only
 * window B has opened.
 */
export function isCollabAssetDocumentRegisteredForSender(
  senderId: number,
  orgId: string,
  documentId: string
): boolean {
  const docs = senderRegistry.get(senderId);
  if (!docs) return false;
  const entry = docs.get(documentId);
  return !!entry && entry.orgId === orgId;
}

/**
 * Process-wide authorization check. Used by `protocol.handle`, which
 * cannot determine the requesting webContents in current Electron (see
 * electron/electron#41472). Returns true if *any* sender has registered
 * (orgId, documentId). This intentionally trades strict per-window
 * isolation for being able to render `<img src="collab-asset://...">`
 * via the registered scheme at all -- and it matches the existing
 * `nim-asset://` pattern.
 */
export function isCollabAssetDocumentRegistered(
  orgId: string,
  documentId: string
): boolean {
  for (const docs of senderRegistry.values()) {
    const entry = docs.get(documentId);
    if (entry && entry.orgId === orgId) return true;
  }
  return false;
}

/**
 * Look up the orgId for a registered document, or null if not registered.
 * Process-wide (see `isCollabAssetDocumentRegistered`).
 */
export function getOrgIdForDocument(documentId: string): string | null {
  for (const docs of senderRegistry.values()) {
    const entry = docs.get(documentId);
    if (entry) return entry.orgId;
  }
  return null;
}

/**
 * For tests.
 */
export function clearCollabAssetRegistry(): void {
  senderRegistry.clear();
}

/**
 * Register the `collab-asset` scheme as standard/secure with Chromium. Must
 * be called BEFORE `app.whenReady` resolves -- per Electron docs, schemes
 * must be registered as privileged before the app is ready.
 */
export function registerCollabAssetSchemeAsPrivileged(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: COLLAB_ASSET_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        bypassCSP: false,
        corsEnabled: true,
      },
    },
  ]);
}

// ----------------------------------------------------------------------------
// Crypto helpers (mirror of CollabAssetService, but in main)
// ----------------------------------------------------------------------------

interface AssetMetadataPayload {
  name?: string;
}

function base64ToUint8Array(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, "base64"));
}

async function decryptBytes(
  ciphertext: ArrayBuffer,
  ivBase64: string,
  key: CryptoKey
): Promise<Uint8Array> {
  const iv = base64ToUint8Array(ivBase64);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    ciphertext
  );
  return new Uint8Array(decrypted);
}

async function decryptMetadata(
  encryptedMetadata: string | null,
  metadataIv: string | null,
  key: CryptoKey
): Promise<AssetMetadataPayload | null> {
  if (!encryptedMetadata || !metadataIv) return null;
  const ciphertext = base64ToUint8Array(encryptedMetadata);
  const plaintext = await decryptBytes(
    ciphertext.buffer.slice(
      ciphertext.byteOffset,
      ciphertext.byteOffset + ciphertext.byteLength
    ) as ArrayBuffer,
    metadataIv,
    key
  );
  try {
    return JSON.parse(
      new TextDecoder().decode(plaintext)
    ) as AssetMetadataPayload;
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------------------
// Handler
// ----------------------------------------------------------------------------

interface AssetHandlerDeps {
  /** Returns the cached AES org key, or null if absent. */
  getOrgKey: (orgId: string) => Promise<CryptoKey | null>;
  /** Mints (or returns cached) org-scoped JWT for the given org. */
  getOrgScopedJwt: (orgId: string) => Promise<string>;
  /** Resolves the collab server HTTP base URL (e.g. https://sync.nimbalyst.com). */
  getCollabHttpUrl: () => string;
  /** Current unlocked local account. Cache access is refused without it. */
  getAccountId?: () => string | null;
  assetStore?: {
    loadAsset(identity: {
      accountId: string;
      orgId: string;
      documentId: string;
      assetId: string;
    }): Promise<{
      bytes: Uint8Array;
      mimeType: string;
      fileName: string;
    } | null>;
    cacheAsset(input: {
      identity: {
        accountId: string;
        orgId: string;
        documentId: string;
        assetId: string;
      };
      bytes: Uint8Array;
      mimeType: string;
      fileName: string;
    }): Promise<void>;
  };
}

function assetResponse(
  bytes: Uint8Array,
  mimeType: string,
  fileName: string,
  plaintextSize?: string | null
): Response {
  const headers = new Headers();
  headers.set("Content-Type", mimeType || "application/octet-stream");
  headers.set("Content-Length", String(bytes.byteLength));
  if (plaintextSize) headers.set("X-Plaintext-Size", plaintextSize);
  headers.set(
    "Content-Disposition",
    `inline; filename="${fileName.replace(/[\r\n"]/g, "")}"`
  );
  return new Response(bytes as BodyInit, { status: 200, headers });
}

/**
 * Wire up the actual handler. Dependencies are injected so tests can stub
 * fetch / key lookup. In production wiring see `registerCollabAssetProtocolHandler`.
 */
export function installCollabAssetProtocolHandler(
  deps: AssetHandlerDeps
): void {
  protocol.handle(COLLAB_ASSET_SCHEME, createCollabAssetRequestHandler(deps));
}

export function createCollabAssetRequestHandler(deps: AssetHandlerDeps) {
  return async (request: Request): Promise<Response> => {
    try {
      const parsed = parseCollabAssetUrl(request.url);
      if (!parsed) {
        return new Response("Bad request", { status: 400 });
      }

      const orgId = getOrgIdForDocument(parsed.documentId);
      if (!orgId) {
        // Not registered = renderer hasn't opened this doc in this session,
        // or the tab was already torn down. Treat as forbidden.
        return new Response("Forbidden", { status: 403 });
      }

      const accountId = deps.getAccountId?.() ?? null;
      const cacheIdentity = accountId
        ? {
            accountId,
            orgId,
            documentId: parsed.documentId,
            assetId: parsed.assetId,
          }
        : null;
      if (cacheIdentity && deps.assetStore) {
        // const cacheStartedAt = Date.now(); // used by the commented-out cache metric below
        try {
          const cached = await deps.assetStore.loadAsset(cacheIdentity);
          if (cached) {
            // console.info("[CollabOfflineMetric]", {
            //   metric: "asset_cache",
            //   hit: true,
            //   durationMs: Date.now() - cacheStartedAt,
            //   bytes: cached.bytes.byteLength,
            // });
            return assetResponse(
              cached.bytes,
              cached.mimeType,
              cached.fileName
            );
          }
          // console.info("[CollabOfflineMetric]", {
          //   metric: "asset_cache",
          //   hit: false,
          //   durationMs: Date.now() - cacheStartedAt,
          //   bytes: 0,
          // });
        } catch (error) {
          console.warn(
            "[collab-asset] Cached asset unreadable; falling back to server",
            error
          );
        }
      }

      const orgKey = await deps.getOrgKey(orgId);
      if (!orgKey) {
        console.warn("[collab-asset] No org key cached for", orgId);
        return new Response("Key unavailable", { status: 500 });
      }

      let jwt: string;
      try {
        jwt = await deps.getOrgScopedJwt(orgId);
      } catch (err) {
        console.warn("[collab-asset] Failed to mint org JWT:", err);
        return new Response("Auth failed", { status: 401 });
      }

      const assetUrl =
        `${deps.getCollabHttpUrl()}/api/collab/docs/` +
        `${encodeURIComponent(parsed.documentId)}/assets/${encodeURIComponent(
          parsed.assetId
        )}`;
      let upstream: Response;
      try {
        upstream = await net.fetch(assetUrl, {
          headers: { Authorization: `Bearer ${jwt}` },
        });
      } catch {
        // A terminal response lets the editor render its broken-asset
        // placeholder instead of leaving an image request spinning forever.
        return new Response("Attachment unavailable offline", { status: 503 });
      }

      if (upstream.status === 404) {
        return new Response("Not found", { status: 404 });
      }
      if (!upstream.ok) {
        const body = await upstream.text().catch(() => "");
        console.warn(
          "[collab-asset] Upstream fetch failed",
          upstream.status,
          body
        );
        return new Response("Upstream error", { status: 502 });
      }

      const iv = upstream.headers.get(HEADER_IV);
      if (!iv) {
        return new Response("Missing IV", { status: 502 });
      }

      const mimeType =
        upstream.headers.get(HEADER_MIME) || "application/octet-stream";
      const encryptedMetadata = upstream.headers.get(HEADER_METADATA);
      const metadataIv = upstream.headers.get(HEADER_METADATA_IV);
      const plaintextSize = upstream.headers.get(HEADER_PLAINTEXT_SIZE);

      const ciphertext = await upstream.arrayBuffer();
      let plaintext: Uint8Array;
      try {
        plaintext = await decryptBytes(ciphertext, iv, orgKey);
      } catch (err) {
        console.warn("[collab-asset] Decrypt failed", err);
        return new Response("Decrypt failed", { status: 500 });
      }

      // Decrypt metadata best-effort -- not load-bearing for `<img>` rendering,
      // but we expose it as `Content-Disposition` so download flows pick up
      // the original filename.
      let filename = `${parsed.assetId}.bin`;
      try {
        const meta = await decryptMetadata(
          encryptedMetadata,
          metadataIv,
          orgKey
        );
        if (meta?.name) filename = meta.name;
      } catch {
        // ignore -- decoration only
      }

      if (cacheIdentity && deps.assetStore) {
        try {
          await deps.assetStore.cacheAsset({
            identity: cacheIdentity,
            bytes: plaintext,
            mimeType,
            fileName: filename,
          });
        } catch (error) {
          // Serving a successfully fetched asset is more important than cache
          // admission; disk-full/retention failures are surfaced separately.
          console.warn("[collab-asset] Failed to cache viewed asset", error);
        }
      }
      return assetResponse(plaintext, mimeType, filename, plaintextSize);
    } catch (err) {
      console.error("[collab-asset] handler error:", err);
      return new Response("Internal error", { status: 500 });
    }
  };
}
