/**
 * Bootstrap the unified tracker plugin on the electron renderer. Loads
 * tracker schemas from the main process (or local YAML in non-electron
 * fallback) and publishes the tracker Lexical extension, slash-picker
 * entries, and React UI component into the runtime extension stores.
 */

import {
  TRACKER_ITEM_TRANSFORMERS,
  TRACKER_USER_COMMANDS,
  TrackerLexicalExtension,
  TrackerPlugin,
  globalRegistry,
  loadBuiltinTrackers,
  parseTrackerYAML,
  registerExtensionEditorComponent,
  setExtensionContributions,
  setExtensionLexicalExtension,
} from '@nimbalyst/runtime';
import type { ComponentType } from 'react';
import * as path from 'path';
import { getDocumentService } from '../services/RendererDocumentService';
import { applySchemasToRegistry } from './trackerSchemaRegistryUtils';

const SOURCE = 'tracker';

export async function registerTrackerPlugin(workspacePath?: string | null): Promise<void> {
  // Try to fetch schemas from main-process TrackerSchemaService (authoritative source).
  // Falls back to local loading if the IPC API is not available.
  const api = (window as { electronAPI?: { trackerSchema?: {
    getAll?: () => Promise<unknown[]>;
    onChanged?: (cb: (schemas: unknown[]) => void) => void;
  } } }).electronAPI;

  if (api?.trackerSchema?.getAll) {
    try {
      const schemas = await api.trackerSchema.getAll();
      applySchemasToRegistry(schemas ?? []);
      api.trackerSchema.onChanged?.((updatedSchemas) => {
        applySchemasToRegistry(updatedSchemas ?? []);
      });
    } catch {
      loadBuiltinTrackers();
    }
  } else {
    loadBuiltinTrackers();

    if (workspacePath && window.electronAPI?.readFileContent) {
      try {
        const trackersDir = `${workspacePath}/.nimbalyst/trackers`;
        const files = await window.electronAPI.getFolderContents(trackersDir);
        const yamlFiles = files.filter(
          (f) => f.type === 'file' && (f.name.endsWith('.yaml') || f.name.endsWith('.yml')),
        );
        for (const file of yamlFiles) {
          try {
            const filePath = path.join(trackersDir, file.name);
            const result = await window.electronAPI.readFileContent(filePath);
            if (result && result.success) {
              const model = parseTrackerYAML(result.content);
              globalRegistry.register(model);
            }
          } catch (error) {
            console.error(`[TrackerPlugin] Failed to load ${file.name}:`, error);
          }
        }
      } catch (error) {
        console.error('[TrackerPlugin] Failed to load custom trackers:', error);
      }
    }
  }

  // Publish the Lexical extension (registers `TrackerItemNode`),
  // markdown transformers, slash-picker entries, and React UI plugin.
  setExtensionLexicalExtension(SOURCE, TrackerLexicalExtension);
  setExtensionContributions(SOURCE, {
    markdownTransformers: TRACKER_ITEM_TRANSFORMERS,
    userCommands: TRACKER_USER_COMMANDS,
  });
  registerExtensionEditorComponent({
    name: SOURCE,
    Component: TrackerPlugin as ComponentType<unknown>,
  });

  // Expose tracker registry and document service on window for
  // cross-component access. Matches the prior shape so consumers
  // (TrackerBottomPanel, ad-hoc renderer code) keep working.
  (window as { __trackerRegistry?: typeof globalRegistry }).__trackerRegistry = globalRegistry;

  const documentService = getDocumentService();
  if (documentService) {
    (window as { documentService?: typeof documentService }).documentService = documentService;
  }
}
