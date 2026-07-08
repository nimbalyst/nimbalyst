/**
 * Document seeding orchestrator (renderer).
 *
 * ONE module owns the strategy order for writing a shared document's initial
 * content into its collab room. It replaces the branches that were scattered
 * across CollabLocalOriginService (main), CommonFileActions, and the hook.
 *
 *   C  renderer-headless -- the renderer already has every extension's pure
 *      `CollabCodec` loaded. When one is registered for the document type we
 *      seed the room here (no editor window): open a throwaway
 *      `DocumentSyncProvider`, run `codec.seedFromFile` inside a
 *      COLLAB_INIT_ORIGIN transaction, and flush WITH a server-persisted ack
 *      (Phase 0) before tearing the provider down. This is also the path that
 *      makes EXTERNAL, STRUCTURED editors (mindmap) work: they can supply a
 *      renderer codec but never a main-process adapter.
 *   A  main-process adapter -- the legacy path, kept as an optional fallback
 *      for in-repo / text-descriptor editors whose adapter is registered in
 *      the main registry. Never required: its absence degrades to C, never a
 *      hard error.
 *
 * Strategy B ("seed through the already-open editor's live provider") is a
 * natural special case of C: seeding is deterministic (content-derived stable
 * ids), so a fresh headless provider's update merges with an open editor's via
 * CRDT without duplication. When no editor is open, C is the ONLY renderer
 * path; when one is, both converge on the same shared shape.
 *
 * The offscreen harness (strategy D, for imperative component-only editors
 * whose collab shape can't be produced by a pure function) is not needed by
 * any editor that ships today -- every current collab editor has a pure codec.
 * See the plan for its (deferred) design.
 */

import { DocumentSyncProvider } from '@nimbalyst/runtime/sync';
import { COLLAB_INIT_ORIGIN } from '@nimbalyst/runtime';
import { getCollabContentAdapter } from '@nimbalyst/collab-adapters';
import { resolveCollabConfigForUri } from './collabDocumentOpener';
import { logger } from './logger';

export type SeedStrategy =
  | 'C-renderer-headless'
  | 'A-main-adapter'
  | 'none';

export interface SeedResult {
  ok: boolean;
  /** Which path actually ran (or 'none' when nothing could seed). */
  strategy: SeedStrategy;
  /** True when a renderer codec exists for this document type (the editor can
   *  therefore seed the room itself on first open, even if this pass failed). */
  hasRendererCodec: boolean;
  error?: string;
}

export type ReuploadSharedDocumentResult = SeedResult;

export interface SharedDocumentExportResult extends SeedResult {
  content?: string;
}

interface SeedParams {
  workspacePath: string;
  documentId: string;
  documentType: string;
  title?: string;
  content: string | Uint8Array;
}

const CONNECT_TIMEOUT_MS = 8_000;
const FLUSH_TIMEOUT_MS = 8_000;

/**
 * Seed a shared document's initial content into its collab room, trying the
 * renderer-headless codec path (C) first and falling back to the main-process
 * adapter (A). Every path that writes flushes with a server-persisted ack
 * before teardown, so a teammate opening the freshly-announced doc sees the
 * content rather than a blank room.
 */
export async function seedSharedDocument(params: SeedParams): Promise<SeedResult> {
  const codec = getCollabContentAdapter(params.documentType);
  const hasRendererCodec = !!codec;
  logger.ui.info('[seedOrchestrator] start', {
    documentType: params.documentType,
    documentId: params.documentId,
    hasRendererCodec,
    contentLen: typeof params.content === 'string' ? params.content.length : params.content.byteLength,
  });

  if (codec) {
    const viaRenderer = await seedViaRendererHeadless(params);
    logger.ui.info('[seedOrchestrator] renderer-headless result', viaRenderer);
    if (viaRenderer.ok) return viaRenderer;

    // Codec seed didn't confirm -- try the main adapter as a backstop if one
    // exists, otherwise report the renderer failure. Either way the editor's
    // own first-open seed (also flush-with-ack) remains a durable backstop.
    const viaMain = await seedViaMainAdapter(params);
    if (viaMain.ok) return { ...viaMain, hasRendererCodec };
    return { ...viaRenderer, hasRendererCodec };
  }

  // No renderer codec: the only headless option is a main-process adapter
  // (in-repo statics + text descriptors). If that's absent too, nothing here
  // can seed -- 'none'.
  const viaMain = await seedViaMainAdapter(params);
  return { ...viaMain, hasRendererCodec };
}

/**
 * Re-upload a linked local file into an EXISTING shared room using the
 * registered renderer codec (wipe-and-reseed via `applyFromFile`), flushing
 * with a server-persisted ack before dispose. This is the not-open fallback
 * for editors that have no main-process adapter (external structured editors
 * like mindmap): `reuploadFromLocalOrigin` in main returns 'unsupported' for
 * them and the caller routes here.
 */
export async function reuploadSharedDocument(params: SeedParams): Promise<ReuploadSharedDocumentResult> {
  const codec = getCollabContentAdapter(params.documentType);
  logger.ui.info('[seedOrchestrator] reupload start', {
    documentType: params.documentType,
    documentId: params.documentId,
    hasRendererCodec: !!codec,
  });
  if (!codec?.applyFromFile) {
    return {
      ok: false,
      strategy: 'none',
      hasRendererCodec: !!codec,
      error: `No renderer collab codec with applyFromFile for document type '${params.documentType}'.`,
    };
  }
  const result = await runHeadlessRoomWrite(params, (yDoc) => {
    codec.applyFromFile(yDoc, params.content);
  });
  logger.ui.info('[seedOrchestrator] reupload result', {
    ok: result.ok,
    strategy: result.strategy,
    error: result.error,
  });
  return result;
}

/**
 * Export the current shared-room content through the renderer codec without
 * modifying it. Renderer-only re-upload uses this before overwrite so it can
 * perform the same conflict/baseline check as the main-process adapter path.
 */
export async function exportSharedDocument(params: Omit<SeedParams, 'content'>): Promise<SharedDocumentExportResult> {
  const codec = getCollabContentAdapter(params.documentType);
  if (!codec?.exportToFile) {
    return {
      ok: false,
      strategy: 'none',
      hasRendererCodec: !!codec,
      error: `No renderer collab codec with exportToFile for document type '${params.documentType}'.`,
    };
  }

  const config = await resolveCollabConfigForUri(
    params.workspacePath,
    `collab://seed/${params.documentId}`,
    params.documentId,
    params.title,
    params.documentType,
  );
  if (!config) {
    return {
      ok: false,
      strategy: 'C-renderer-headless',
      hasRendererCodec: true,
      error: 'Could not resolve collab config for headless export (no team/org key?).',
    };
  }

  const provider = new DocumentSyncProvider({
    serverUrl: config.serverUrl,
    getJwt: config.getJwt,
    orgId: config.orgId,
    keyCustody: config.keyCustody,
    documentKey: config.documentKey,
    legacyDocumentKey: config.legacyDocumentKey,
    legacyDocumentKeys: config.legacyDocumentKeys,
    orgKeyFingerprint: config.orgKeyFingerprint,
    userId: config.userId,
    documentId: config.documentId,
    createWebSocket: config.createWebSocket,
    reviewGateEnabled: false,
  });

  try {
    await provider.connect();
    const connected = await waitForConnected(provider, CONNECT_TIMEOUT_MS);
    if (!connected) {
      return {
        ok: false,
        strategy: 'C-renderer-headless',
        hasRendererCodec: true,
        error: 'Timed out connecting to the shared room for headless export.',
      };
    }
    const content = codec.exportToFile(provider.getYDoc());
    if (typeof content !== 'string') {
      return {
        ok: false,
        strategy: 'C-renderer-headless',
        hasRendererCodec: true,
        error: 'Renderer codec exported binary content; re-upload conflict checks require text content.',
      };
    }
    return {
      ok: true,
      strategy: 'C-renderer-headless',
      hasRendererCodec: true,
      content,
    };
  } catch (err) {
    return {
      ok: false,
      strategy: 'C-renderer-headless',
      hasRendererCodec: true,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    try {
      provider.destroy();
    } catch {
      // Ignore teardown failures.
    }
  }
}

/**
 * Strategy C: seed in the renderer using the registered pure codec against a
 * throwaway `DocumentSyncProvider`, flushing with a server ack before dispose.
 */
async function seedViaRendererHeadless(params: SeedParams): Promise<SeedResult> {
  const codec = getCollabContentAdapter(params.documentType);
  if (!codec) {
    return { ok: false, strategy: 'C-renderer-headless', hasRendererCodec: false };
  }
  return runHeadlessRoomWrite(params, (yDoc) => {
    // Re-check emptiness: another client may already have seeded (the seed is
    // deterministic, so a double seed would still merge cleanly, but skipping
    // avoids a redundant write).
    if (codec.isEmpty(yDoc)) {
      yDoc.transact(() => {
        codec.seedFromFile(yDoc, params.content);
      }, COLLAB_INIT_ORIGIN);
    }
  });
}

/**
 * Shared harness for headless room writes: connect a throwaway provider, run
 * `write` against the synced Y.Doc, flush with a server-persisted ack, dispose.
 */
async function runHeadlessRoomWrite(
  params: SeedParams,
  write: (yDoc: import('yjs').Doc) => void | Record<string, unknown>,
): Promise<SeedResult & Record<string, unknown>> {

  const config = await resolveCollabConfigForUri(
    params.workspacePath,
    `collab://seed/${params.documentId}`,
    params.documentId,
    params.title,
    params.documentType,
  );
  if (!config) {
    return {
      ok: false,
      strategy: 'C-renderer-headless',
      hasRendererCodec: true,
      error: 'Could not resolve collab config for headless seed (no team/org key?).',
    };
  }

  const provider = new DocumentSyncProvider({
    serverUrl: config.serverUrl,
    getJwt: config.getJwt,
    orgId: config.orgId,
    keyCustody: config.keyCustody,
    documentKey: config.documentKey,
    legacyDocumentKey: config.legacyDocumentKey,
    legacyDocumentKeys: config.legacyDocumentKeys,
    orgKeyFingerprint: config.orgKeyFingerprint,
    userId: config.userId,
    documentId: config.documentId,
    createWebSocket: config.createWebSocket,
    reviewGateEnabled: false,
  });

  try {
    await provider.connect();
    const connected = await waitForConnected(provider, CONNECT_TIMEOUT_MS);
    if (!connected) {
      return {
        ok: false,
        strategy: 'C-renderer-headless',
        hasRendererCodec: true,
        error: 'Timed out connecting to the shared room for headless seed.',
      };
    }

    const extra = write(provider.getYDoc()) ?? {};

    const flushed = await provider.flushWithAck(FLUSH_TIMEOUT_MS);
    return {
      ok: flushed,
      strategy: 'C-renderer-headless',
      hasRendererCodec: true,
      error: flushed ? undefined : 'Seed flush was not confirmed by the server before timeout.',
      ...extra,
    };
  } catch (err) {
    return {
      ok: false,
      strategy: 'C-renderer-headless',
      hasRendererCodec: true,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    try {
      provider.destroy();
    } catch {
      // Ignore teardown failures.
    }
  }
}

/**
 * Strategy A: hand off to the main-process adapter path via IPC. Returns
 * `ok: false` (not throwing) when main has no adapter for the document type,
 * so the orchestrator can decide whether that's a genuine failure.
 */
async function seedViaMainAdapter(params: SeedParams): Promise<SeedResult> {
  const documentSync = window.electronAPI?.documentSync;
  if (!documentSync?.seedSharedDocument) {
    return { ok: false, strategy: 'none', hasRendererCodec: false };
  }
  if (typeof params.content !== 'string') {
    // The main-process adapter path (in-repo statics + text descriptors) is a
    // string channel; binary-shaped editors have renderer codecs and seed via
    // strategy C, never here.
    return {
      ok: false,
      strategy: 'none',
      hasRendererCodec: false,
      error: 'Binary seed content is not supported by the main-process adapter path.',
    };
  }
  try {
    const result = await documentSync.seedSharedDocument(
      params.workspacePath,
      params.documentId,
      params.documentType,
      params.content,
    );
    if (result?.success) {
      return { ok: true, strategy: 'A-main-adapter', hasRendererCodec: false };
    }
    // A missing main adapter is an expected, non-fatal outcome now -- it means
    // "main can't seed this type", which the renderer path already tried to
    // cover. Surface it as 'none' with the message for logging.
    return {
      ok: false,
      strategy: 'none',
      hasRendererCodec: false,
      error: result?.error,
    };
  } catch (err) {
    return {
      ok: false,
      strategy: 'none',
      hasRendererCodec: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Poll the provider until it reaches a connected/synced status or times out. */
async function waitForConnected(
  provider: DocumentSyncProvider,
  timeoutMs: number,
): Promise<boolean> {
  const start = Date.now();
  // 'connected' and 'replaying' both mean the initial sync landed.
  const isReady = () => {
    const s = provider.getStatus();
    return s === 'connected' || s === 'replaying';
  };
  while (!isReady()) {
    if (Date.now() - start > timeoutMs) {
      logger.ui.warn('[documentSeedOrchestrator] waitForConnected timed out', {
        status: provider.getStatus(),
      });
      return false;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return true;
}
