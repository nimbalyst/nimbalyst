/**
 * Built-in CollabContentAdapter registration.
 *
 * Runs once at main-process startup and populates the registry with
 * every adapter the host ships. The main process needs every adapter
 * available so `reuploadFromLocalOrigin` (and any future main-side
 * features like server-driven export) can dispatch by documentType
 * without bouncing through the renderer.
 *
 * Each extension exposes its adapter via a side-channel
 * `./collab-adapter` (or `./collab-adapters`) package export that
 * points at a source file with only Y.Doc, type, and pure-JS
 * dependencies. The extension's main bundle (which would drag in
 * React, CSS, Zustand, etc.) is NOT imported here.
 */
import {
  registerCollabContentAdapter,
  getCollabContentAdapter,
} from '@nimbalyst/collab-adapters';
import {
  MarkdownCollabContentAdapter,
} from '@nimbalyst/runtime/sync';
import {
  reconstructCollabContentAdapterFromDescriptor,
  type CollabAdapterDescriptor,
} from '@nimbalyst/runtime';
import { CsvCollabContentAdapter } from '@nimbalyst/extension-csv-spreadsheet/collab-adapter';
import { ExcalidrawCollabContentAdapter } from '@nimbalyst/excalidraw-extension/collab-adapter';
import { DataModelCollabContentAdapter } from '@nimbalyst/extension-datamodellm/collab-adapter';
import {
  MockupHtmlCollabContentAdapter,
  MockupProjectCollabContentAdapter,
} from '@nimbalyst/mockuplm/collab-adapters';
import { logger } from '../utils/logger';

let registered = false;

export function registerBuiltinCollabContentAdapters(): void {
  if (registered) return;
  registered = true;
  try {
    registerCollabContentAdapter(MarkdownCollabContentAdapter);
    registerCollabContentAdapter(CsvCollabContentAdapter);
    registerCollabContentAdapter(ExcalidrawCollabContentAdapter);
    registerCollabContentAdapter(DataModelCollabContentAdapter);
    registerCollabContentAdapter(MockupHtmlCollabContentAdapter);
    registerCollabContentAdapter(MockupProjectCollabContentAdapter);
    logger.main.info('[CollabContentAdapters] Registered built-in adapters: markdown, csv, excalidraw, datamodel, mockup.html, mockupproject');
  } catch (error) {
    logger.main.error('[CollabContentAdapters] Failed to register built-in adapters:', error);
  }
}

/**
 * Register a collab adapter in the MAIN-process registry from a serializable
 * descriptor forwarded by the renderer (where the extension's activate() ran).
 *
 * This is how MARKETPLACE editors (not statically bundled above, e.g.
 * calc-sheets) reach main-process parity: main rebuilds the adapter from the
 * SDK factory via the descriptor -- no extension code is loaded into main and
 * no dynamic import() is used. Currently only `text` adapters are serializable.
 * Idempotent: a documentType already covered by a built-in is left untouched.
 *
 * Returns true if an adapter is registered (or already present) for the
 * descriptor's documentType.
 */
export function registerCollabContentAdapterFromDescriptor(
  descriptor: CollabAdapterDescriptor,
): boolean {
  try {
    if (getCollabContentAdapter(descriptor.documentType)) return true;
    const adapter = reconstructCollabContentAdapterFromDescriptor(descriptor);
    if (!adapter) {
      logger.main.warn(
        `[CollabContentAdapters] Unknown descriptor kind for documentType '${descriptor.documentType}'; not registered`,
      );
      return false;
    }
    registerCollabContentAdapter(adapter);
    logger.main.info(
      `[CollabContentAdapters] Registered dynamic adapter from descriptor: ${descriptor.documentType}`,
    );
    return true;
  } catch (error) {
    logger.main.error('[CollabContentAdapters] Failed to register adapter from descriptor:', error);
    return false;
  }
}
