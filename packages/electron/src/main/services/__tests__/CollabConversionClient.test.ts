/**
 * Round-trip test for the main-process codec client.
 *
 * The IPC seam is mocked, but both real ends run: the client encodes state and
 * applies the returned delta, and a stand-in "renderer" runs the real
 * `handleCollabConversionRequest` against a real codec registry. What this
 * guards is the part the parity tests cannot see -- correlation, host
 * selection, and that a missing or silent host FAILS LOUDLY rather than
 * reporting a successful conversion. A data-safety gate is built on this.
 */
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

// `vi.mock` is hoisted above module scope, so the fakes it closes over have to
// be hoisted too.
const { ipcMain, windows } = vi.hoisted(() => {
  const emitter = new (require('node:events').EventEmitter)();
  emitter.setMaxListeners(0);
  return { ipcMain: emitter as EventEmitter, windows: new Map<number, any>() };
});

interface FakeWindow {
  id: number;
  isDestroyed: () => boolean;
  once: (event: string, listener: () => void) => void;
  webContents: {
    id: number;
    isDestroyed: () => boolean;
    once: (event: string, listener: () => void) => void;
    send: (channel: string, payload: unknown) => void;
  };
}

vi.mock('electron', () => ({
  ipcMain,
  BrowserWindow: {
    fromId: (id: number) => windows.get(id) ?? null,
    fromWebContents: (contents: { windowId: number }) => windows.get(contents.windowId) ?? null,
  },
}));

vi.mock('../../utils/logger', () => ({
  logger: { main: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
}));

import {
  clearCollabContentAdapters,
  handleCollabConversionRequest,
  registerCollabContentAdapter,
  type CollabContentAdapter,
  type CollabConversionRequest,
} from '@nimbalyst/collab-adapters';

import {
  convertExportToFile,
  convertFromFileIntoDoc,
  describeCollabCodec,
  registerCollabConversionClient,
  requestCollabConversion,
  resetCollabConversionHostsForTests,
} from '../CollabConversionClient';

const textCodec: CollabContentAdapter = {
  documentType: 'text-fixture',
  fileExtensions: ['.txt', '.text'],
  mimeType: 'text/plain',
  layoutVersion: 3,
  isEmpty: (yDoc) => yDoc.share.size === 0,
  seedFromFile: (yDoc, source) => { yDoc.getText('body').insert(0, String(source)); },
  applyFromFile: (yDoc, source) => {
    yDoc.transact(() => {
      const text = yDoc.getText('body');
      text.delete(0, text.length);
      text.insert(0, String(source));
    });
  },
  exportToFile: (yDoc) => yDoc.getText('body').toString(),
  toPlainText: (yDoc) => yDoc.getText('body').toString(),
};

/**
 * Register a window that behaves like a real codec host: it answers requests
 * by running the shared handler. `silent: true` models a wedged renderer.
 */
function addHostWindow(id: number, options: { workspacePath?: string; silent?: boolean } = {}): void {
  const window: FakeWindow = {
    id,
    isDestroyed: () => false,
    once: () => {},
    webContents: {
      id: id + 1000,
      isDestroyed: () => false,
      once: () => {},
      send: (_channel, payload) => {
        if (options.silent) return;
        const request = payload as CollabConversionRequest & { responseChannel: string };
        const response = handleCollabConversionRequest(request);
        // Same tick is fine -- the main listener is already registered by the
        // time the client calls send().
        ipcMain.emit(request.responseChannel, { sender: window.webContents }, response);
      },
    },
  };
  windows.set(id, window);
  ipcMain.emit(
    'collab-conversion:host-ready',
    { sender: { windowId: id, once: () => {} } },
    { workspacePath: options.workspacePath ?? null },
  );
}

describe('CollabConversionClient', () => {
  beforeEach(() => {
    registerCollabConversionClient();
    registerCollabContentAdapter(textCodec);
  });

  afterEach(() => {
    resetCollabConversionHostsForTests();
    clearCollabContentAdapters();
    windows.clear();
    vi.useRealTimers();
  });

  it('throws when no codec host window is available', async () => {
    await expect(convertExportToFile('text-fixture', new Y.Doc()))
      .rejects.toThrow(/No collab codec host is available/);
  });

  it('exports a live doc through the host', async () => {
    addHostWindow(1);
    const live = new Y.Doc();
    textCodec.seedFromFile(live, 'hello from the host');

    await expect(convertExportToFile('text-fixture', live)).resolves.toBe('hello from the host');
  });

  it('applies the returned delta to the live doc', async () => {
    addHostWindow(1);
    const live = new Y.Doc();
    textCodec.seedFromFile(live, 'before');

    await convertFromFileIntoDoc('applyFromFile', 'text-fixture', live, 'after');

    expect(textCodec.exportToFile(live)).toBe('after');
  });

  it('surfaces an unregistered document type as an error, not a partial result', async () => {
    addHostWindow(1);

    await expect(convertExportToFile('unknown-type', new Y.Doc()))
      .rejects.toThrow(/No collab codec is registered for document type 'unknown-type'/);
  });

  it('returns codec metadata for naming exports', async () => {
    addHostWindow(1);

    await expect(describeCollabCodec('text-fixture')).resolves.toEqual({
      documentType: 'text-fixture',
      fileExtensions: ['.txt', '.text'],
      mimeType: 'text/plain',
      layoutVersion: 3,
    });
  });

  it('prefers the window already showing the document\'s workspace', async () => {
    const seen: number[] = [];
    addHostWindow(1, { workspacePath: '/repos/other' });
    addHostWindow(2, { workspacePath: '/repos/target' });
    for (const id of [1, 2]) {
      const window = windows.get(id)!;
      const send = window.webContents.send;
      window.webContents.send = (channel: string, payload: unknown) => {
        seen.push(id);
        send(channel, payload);
      };
    }

    await convertExportToFile('text-fixture', new Y.Doc(), { workspacePath: '/repos/target' });

    expect(seen).toEqual([2]);
  });

  it('ignores a response sent by a renderer other than the selected host', async () => {
    addHostWindow(1);
    const window = windows.get(1)!;
    const replyAsHost = window.webContents.send;
    window.webContents.send = (channel: string, payload: unknown) => {
      const request = payload as CollabConversionRequest & { responseChannel: string };
      ipcMain.emit(request.responseChannel, { sender: { id: 9999 } }, {
        id: request.id,
        ok: true,
        op: 'exportToFile',
        bytes: 'forged response',
      });
      replyAsHost(channel, payload);
    };
    const live = new Y.Doc();
    textCodec.seedFromFile(live, 'authoritative response');

    await expect(convertExportToFile('text-fixture', live))
      .resolves.toBe('authoritative response');
  });

  it('ignores a response with the wrong correlation id', async () => {
    addHostWindow(1);
    const window = windows.get(1)!;
    const replyAsHost = window.webContents.send;
    window.webContents.send = (channel: string, payload: unknown) => {
      const request = payload as CollabConversionRequest & { responseChannel: string };
      ipcMain.emit(request.responseChannel, { sender: window.webContents }, {
        id: request.id + 1,
        ok: true,
        op: 'exportToFile',
        bytes: 'mis-correlated response',
      });
      replyAsHost(channel, payload);
    };
    const live = new Y.Doc();
    textCodec.seedFromFile(live, 'matching response');

    await expect(convertExportToFile('text-fixture', live))
      .resolves.toBe('matching response');
  });

  it('fails loudly when the host never answers', async () => {
    addHostWindow(1, { silent: true });

    await expect(
      requestCollabConversion(
        { op: 'toPlainText', documentType: 'text-fixture', state: new Uint8Array() },
        { timeoutMs: 20 },
      ),
    ).rejects.toThrow(/timed out after 20ms/);
  });
});
