/**
 * Main-process client for the collab codec host.
 *
 * Main owns orchestration -- enumerating documents, the authenticated
 * WebSocket to each DocumentRoom, org-key unwrap, JWT handling -- but it
 * cannot load extension code, so it can never hold a complete codec registry.
 * A renderer can. This module lets main ask one to run the `Y.Doc <-> file
 * bytes` step and returns the result.
 *
 * The request/response shape lives in `@nimbalyst/collab-adapters`
 * (`conversionHost.ts`) and is deliberately free of Electron types: the web
 * console and the mobile WKWebView are the same contract over a different
 * transport. Only THIS file knows about IPC and BrowserWindows.
 *
 * Failure is loud by design. If no host answers, conversion fails, and any
 * data-safety gate built on it (the pre-migration backup sweep) blocks -- the
 * same outcome as today's missing-adapter case, never a silent success.
 *
 * See `nimbalyst-local/plans/collab-conversion-off-main.md`.
 */
import { BrowserWindow, ipcMain } from 'electron';
import { applyUpdate, encodeStateAsUpdate, type Doc } from 'yjs';
import {
  COLLAB_CONVERSION_ORIGIN,
  type CollabCodecMetadata,
  type CollabConversionRequestInput,
  type CollabConversionResponse,
} from '@nimbalyst/collab-adapters';

import { safeOn } from '../utils/ipcRegistry';
import { logger } from '../utils/logger';

export const COLLAB_CONVERSION_REQUEST_CHANNEL = 'collab-conversion:request';
const HOST_READY_CHANNEL = 'collab-conversion:host-ready';
const HOST_GONE_CHANNEL = 'collab-conversion:host-gone';

/**
 * Conversion runs a full headless editor over the document, so it is slower
 * than a typical IPC round trip. Long enough for a large tracker body, short
 * enough that a wedged renderer surfaces as a failure instead of hanging a
 * migration.
 */
const DEFAULT_TIMEOUT_MS = 15_000;

interface HostEntry {
  windowId: number;
  workspacePath: string | null;
  readyAt: number;
}

/** Windows that have announced a populated codec registry, newest last. */
const hosts = new Map<number, HostEntry>();
let nextRequestId = 1;
let registered = false;

/**
 * Wire the host-readiness channels. Called once during main-process IPC setup.
 */
export function registerCollabConversionClient(): void {
  if (registered) return;
  registered = true;

  safeOn(HOST_READY_CHANNEL, (event, payload: { workspacePath?: string | null } = {}) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return;
    const windowId = window.id;
    hosts.set(windowId, {
      windowId,
      workspacePath: payload?.workspacePath ?? null,
      readyAt: Date.now(),
    });
    // A reload re-announces readiness, so drop the entry when the contents go
    // away rather than trusting the renderer to say goodbye.
    event.sender.once('destroyed', () => { hosts.delete(windowId); });
    window.once('closed', () => { hosts.delete(windowId); });
    logger.main.info('[CollabConversion] Codec host ready', {
      windowId,
      workspacePath: payload?.workspacePath ?? null,
    });
  });

  safeOn(HOST_GONE_CHANNEL, (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window) hosts.delete(window.id);
  });
}

/** Test seam: forget every registered host. */
export function resetCollabConversionHostsForTests(): void {
  hosts.clear();
}

/**
 * Pick the window that answers. Prefer one already showing the workspace the
 * document belongs to (it has that workspace's extensions activated), then the
 * most recently ready window.
 */
function selectHost(workspacePath?: string | null): HostEntry | null {
  const live = Array.from(hosts.values()).filter((entry) => {
    const window = BrowserWindow.fromId(entry.windowId);
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
      hosts.delete(entry.windowId);
      return false;
    }
    return true;
  });
  if (live.length === 0) return null;
  if (workspacePath) {
    const match = live.find((entry) => entry.workspacePath === workspacePath);
    if (match) return match;
  }
  return live.reduce((newest, entry) => (entry.readyAt > newest.readyAt ? entry : newest));
}

export interface CollabConversionOptions {
  /** Prefer the window showing this workspace, when one is open. */
  workspacePath?: string | null;
  timeoutMs?: number;
}

/**
 * Send one conversion request to a codec host and await its response.
 *
 * Rejects when no host is available or the host does not answer in time --
 * callers must let that propagate rather than degrade to a partial result.
 */
export async function requestCollabConversion(
  request: CollabConversionRequestInput,
  options: CollabConversionOptions = {},
): Promise<CollabConversionResponse> {
  const host = selectHost(options.workspacePath);
  if (!host) {
    throw new Error(
      'No collab codec host is available (no open window can run document conversion)',
    );
  }
  const window = BrowserWindow.fromId(host.windowId);
  if (!window || window.isDestroyed()) {
    hosts.delete(host.windowId);
    throw new Error('The collab codec host window closed before conversion could start');
  }

  const id = nextRequestId++;
  const responseChannel = `collab-conversion:response:${id}`;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<CollabConversionResponse>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      ipcMain.removeListener(responseChannel, onResponse);
    };
    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onResponse = (
      event: Electron.IpcMainEvent,
      response: CollabConversionResponse,
    ) => {
      if (settled) return;
      if (event.sender?.id !== window.webContents.id) {
        logger.main.warn('[CollabConversion] Ignoring response from an unexpected renderer', {
          requestId: id,
          expectedWebContentsId: window.webContents.id,
          actualWebContentsId: event.sender?.id,
        });
        return;
      }
      if (!response || response.id !== id) {
        logger.main.warn('[CollabConversion] Ignoring response with the wrong correlation id', {
          requestId: id,
          responseId: response?.id,
        });
        return;
      }
      if (response.ok && response.op !== request.op) {
        rejectOnce(new Error(
          `Unexpected conversion response '${response.op}' for ${request.op}`,
        ));
        return;
      }
      settled = true;
      cleanup();
      resolve(response);
    };
    const timer = setTimeout(() => {
      rejectOnce(new Error(
        `Collab conversion '${request.op}' for '${request.documentType}' timed out after ${timeoutMs}ms`,
      ));
    }, timeoutMs);

    ipcMain.on(responseChannel, onResponse);

    try {
      window.webContents.send(COLLAB_CONVERSION_REQUEST_CHANNEL, {
        ...request,
        id,
        responseChannel,
      });
    } catch (error) {
      rejectOnce(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

type SuccessfulConversion = Extract<CollabConversionResponse, { ok: true }>;

function unwrap(response: CollabConversionResponse): SuccessfulConversion {
  if (!response.ok) throw new Error(response.error);
  return response;
}

/** Serialize a live Y.Doc to its on-disk file representation. */
export async function convertExportToFile(
  documentType: string,
  yDoc: Doc,
  options?: CollabConversionOptions,
): Promise<string | Uint8Array> {
  const response = unwrap(await requestCollabConversion(
    { op: 'exportToFile', documentType, state: encodeStateAsUpdate(yDoc) },
    options,
  ));
  if (response.op !== 'exportToFile') {
    throw new Error(`Unexpected conversion response '${response.op}' for exportToFile`);
  }
  return response.bytes;
}

/** Plain-text projection of a live Y.Doc (search / AI / previews). */
export async function convertToPlainText(
  documentType: string,
  yDoc: Doc,
  options?: CollabConversionOptions,
): Promise<string> {
  const response = unwrap(await requestCollabConversion(
    { op: 'toPlainText', documentType, state: encodeStateAsUpdate(yDoc) },
    options,
  ));
  if (response.op !== 'toPlainText') {
    throw new Error(`Unexpected conversion response '${response.op}' for toPlainText`);
  }
  return response.text;
}

/**
 * Run `seedFromFile` / `applyFromFile` on a host and apply the resulting delta
 * to the live doc. Concurrent peer edits during the round trip still merge --
 * the host returns a delta, never full state.
 */
export async function convertFromFileIntoDoc(
  op: 'seedFromFile' | 'applyFromFile',
  documentType: string,
  yDoc: Doc,
  source: string | Uint8Array,
  options?: CollabConversionOptions,
): Promise<void> {
  const response = unwrap(await requestCollabConversion(
    { op, documentType, state: encodeStateAsUpdate(yDoc), source },
    options,
  ));
  if (response.op !== 'seedFromFile' && response.op !== 'applyFromFile') {
    throw new Error(`Unexpected conversion response '${response.op}' for ${op}`);
  }
  applyUpdate(yDoc, response.update, COLLAB_CONVERSION_ORIGIN);
}

/**
 * Codec metadata (file extensions, MIME type) without holding the codec.
 * Main needs this to name backup files for document types it cannot load.
 */
export async function describeCollabCodec(
  documentType: string,
  options?: CollabConversionOptions,
): Promise<CollabCodecMetadata> {
  const response = unwrap(await requestCollabConversion(
    { op: 'describeCodec', documentType },
    options,
  ));
  if (response.op !== 'describeCodec') {
    throw new Error(`Unexpected conversion response '${response.op}' for describeCodec`);
  }
  return response.codec;
}

/**
 * Exact plaintext file representation for local recovery copies. Mirrors
 * `exportCollabRecoveryPlaintext`: a binary export is not plaintext, so the
 * caller can report an unsupported document type instead of writing garbage.
 */
export async function convertRecoveryPlaintext(
  documentType: string,
  yDoc: Doc,
  options?: CollabConversionOptions,
): Promise<string | null> {
  const bytes = await convertExportToFile(documentType, yDoc, options);
  if (typeof bytes === 'string') return bytes;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
