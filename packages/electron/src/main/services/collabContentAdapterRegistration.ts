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
import { registerCollabContentAdapter } from '@nimbalyst/collab-adapters';
import { MarkdownCollabContentAdapter } from '@nimbalyst/runtime/sync';
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
    logger.main.info('[CollabContentAdapters] Registered built-in adapters: markdown, csv, excalidraw, datamodel, mockup-html, mockup-project');
  } catch (error) {
    logger.main.error('[CollabContentAdapters] Failed to register built-in adapters:', error);
  }
}
