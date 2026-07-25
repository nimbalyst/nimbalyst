/**
 * Portable codec-host contract.
 *
 * A *codec host* is any JS environment that can load extension bundles and
 * therefore holds an authoritative `CollabCodec` registry: the Electron
 * renderer, the web console page, the mobile WKWebView. A *codec client* is an
 * environment that cannot -- today that is the Electron main process -- and so
 * asks a host to run the conversion for it.
 *
 * A `Y.Doc` cannot cross a process boundary, so the seam is state-based: the
 * client sends `Y.encodeStateAsUpdate(liveDoc)` plus the file content, the host
 * rebuilds a working doc, runs the codec, and returns a minimal *delta* the
 * client applies to its live doc. That is CRDT-correct, so concurrent peer
 * edits during the round trip still merge.
 *
 * KEEP THIS FILE FREE OF HOST-SPECIFIC TYPES. Electron IPC is only the first
 * transport; the web console (postMessage/worker) and mobile (native bridge)
 * must be able to implement the same request/response shape without forking
 * it. If a migration step wants an Electron type in here, that is a design
 * smell to fix rather than fork.
 *
 * See `nimbalyst-local/plans/collab-conversion-off-main.md`.
 */
import { Doc, applyUpdate, encodeStateAsUpdate, encodeStateVector } from 'yjs';

import { getCollabContentAdapter } from './registry';

/**
 * Transaction origin for every write this module performs. Clients apply the
 * returned delta with the same origin so their own observers can tell a
 * conversion apart from a peer edit.
 */
export const COLLAB_CONVERSION_ORIGIN = 'collab-conversion';

/** Ops a codec client can ask a host to run on its behalf. */
export type CollabConversionOp =
  | 'seedFromFile'
  | 'applyFromFile'
  | 'exportToFile'
  | 'toPlainText'
  | 'describeCodec';

/**
 * The non-behavioural half of a codec: what a client needs to name a file or
 * pick a save dialog filter without holding the codec itself. Serializable by
 * construction -- no functions.
 */
export interface CollabCodecMetadata {
  documentType: string;
  fileExtensions: string[];
  mimeType?: string;
  layoutVersion: number;
}

/**
 * `isEmpty` is deliberately absent: it only reads `yDoc.share.keys()`, needs no
 * codec at all, and sits on a hot gating path. Clients keep answering it
 * locally.
 */
export interface CollabConversionRequestBase {
  /** Correlates the response. Unique per client, opaque to the host. */
  id: number;
  documentType: string;
  /** `Y.encodeStateAsUpdate(liveDoc)` -- empty for a fresh doc. */
  state: Uint8Array;
}

export type CollabConversionRequest =
  | (CollabConversionRequestBase & {
      op: 'seedFromFile';
      source: string | Uint8Array;
    })
  | (CollabConversionRequestBase & {
      op: 'applyFromFile';
      source: string | Uint8Array;
    })
  | (CollabConversionRequestBase & { op: 'exportToFile' })
  | (CollabConversionRequestBase & { op: 'toPlainText' })
  /** Metadata lookup: no document state involved. */
  | { id: number; op: 'describeCodec'; documentType: string; state?: undefined };

/**
 * A request before the client stamps its correlation id. Distributive, so each
 * union member keeps its own `source` / `state` fields -- a plain
 * `Omit<CollabConversionRequest, 'id'>` collapses the union to its common keys.
 */
export type CollabConversionRequestInput =
  CollabConversionRequest extends infer T
    ? T extends CollabConversionRequest ? Omit<T, 'id'> : never
    : never;

export type CollabConversionResponse =
  | {
      id: number;
      ok: true;
      op: 'seedFromFile' | 'applyFromFile';
      /** Minimal delta to apply to the live doc, not full state. */
      update: Uint8Array;
    }
  | { id: number; ok: true; op: 'toPlainText'; text: string }
  | { id: number; ok: true; op: 'exportToFile'; bytes: string | Uint8Array }
  | { id: number; ok: true; op: 'describeCodec'; codec: CollabCodecMetadata }
  | { id: number; ok: false; error: string };

/**
 * Error a client sees when no host has a codec for the requested type. Kept as
 * a constant so the client can distinguish "no codec anywhere" (a real
 * unsupported document type) from "no host answered" (a transport failure).
 */
export function noCodecError(documentType: string): string {
  return `No collab codec is registered for document type '${documentType}'`;
}

/**
 * Run one conversion request against THIS process's codec registry.
 *
 * Transport-agnostic on purpose: the caller owns receiving the request and
 * delivering the response. Never throws -- a codec that throws comes back as
 * `{ ok: false }` so the client can fail loudly with the reason instead of
 * losing it to a rejected promise on the far side of a bridge.
 */
export function handleCollabConversionRequest(
  request: CollabConversionRequest,
): CollabConversionResponse {
  const codec = getCollabContentAdapter(request.documentType);
  if (!codec) {
    return { id: request.id, ok: false, error: noCodecError(request.documentType) };
  }

  if (request.op === 'describeCodec') {
    return {
      id: request.id,
      ok: true,
      op: 'describeCodec',
      codec: {
        documentType: codec.documentType,
        fileExtensions: [...codec.fileExtensions],
        mimeType: codec.mimeType,
        layoutVersion: codec.layoutVersion,
      },
    };
  }

  const workDoc = new Doc();
  try {
    if (request.state.byteLength > 0) {
      applyUpdate(workDoc, request.state, COLLAB_CONVERSION_ORIGIN);
    }

    switch (request.op) {
      case 'toPlainText':
        return { id: request.id, ok: true, op: 'toPlainText', text: codec.toPlainText(workDoc) };

      case 'exportToFile':
        return { id: request.id, ok: true, op: 'exportToFile', bytes: codec.exportToFile(workDoc) };

      // seedFromFile | applyFromFile. `default` rather than two `case` labels
      // so the switch is provably exhaustive to the compiler.
      default: {
        // Snapshot BEFORE the write so the delta carries only what the codec
        // did. Deletions travel as tombstones, so wipe-and-reseed adapters
        // still replace rather than append on the client's live doc.
        const before = encodeStateVector(workDoc);
        if (request.op === 'seedFromFile') codec.seedFromFile(workDoc, request.source);
        else codec.applyFromFile(workDoc, request.source);
        return {
          id: request.id,
          ok: true,
          op: request.op,
          update: encodeStateAsUpdate(workDoc, before),
        };
      }
    }
  } catch (error) {
    return {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    try { workDoc.destroy(); } catch { /* ignore */ }
  }
}
