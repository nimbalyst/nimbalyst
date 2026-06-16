/**
 * IPC handlers for tracker external-source importers.
 *
 * The renderer drives the "Import from..." flow through these channels; the
 * privileged work (network, gh) runs in the importer's backend module, invoked
 * by the registry. All channels are workspace-scoped — workspacePath is a
 * required argument (no module-level "current workspace" fallback).
 */

import { shell } from 'electron';
import { safeHandle } from '../utils/ipcRegistry';
import { logger } from '../utils/logger';
import type { ImporterBinding, ImporterListFilter } from '@nimbalyst/extension-sdk';
import { getTrackerImporterRegistry } from '../services/tracker/TrackerImporterRegistry';
import { getTrackerImportService } from '../services/tracker/TrackerImportService';

function requireWorkspace(workspacePath: string | undefined): string {
  if (!workspacePath) {
    throw new Error('tracker:importer IPC requires a workspacePath');
  }
  return workspacePath;
}

export function registerTrackerImporterHandlers(): void {
  const registry = getTrackerImporterRegistry();

  safeHandle('tracker:importer:list', async (_event, workspacePath?: string) => {
    return registry.listImporters(requireWorkspace(workspacePath));
  });

  safeHandle(
    'tracker:importer:listBindings',
    async (_event, args: { workspacePath?: string; providerId: string }) => {
      return registry.listBindings(requireWorkspace(args.workspacePath), args.providerId);
    }
  );

  safeHandle(
    'tracker:importer:listItems',
    async (
      _event,
      args: {
        workspacePath?: string;
        providerId: string;
        binding: ImporterBinding;
        filters?: ImporterListFilter;
      }
    ) => {
      return registry.listItems(
        requireWorkspace(args.workspacePath),
        args.providerId,
        args.binding,
        args.filters ?? {}
      );
    }
  );

  safeHandle(
    'tracker:importer:import',
    async (
      _event,
      args: {
        workspacePath?: string;
        providerId: string;
        externalId: string;
        primaryType?: string;
      }
    ) => {
      return getTrackerImportService().runImport({
        workspacePath: requireWorkspace(args.workspacePath),
        providerId: args.providerId,
        externalId: args.externalId,
        primaryType: args.primaryType,
      });
    }
  );

  safeHandle(
    'tracker:importer:getByUrn',
    async (_event, args: { workspacePath?: string; urn: string }) => {
      const id = await registry.findLocalIdByUrn(requireWorkspace(args.workspacePath), args.urn);
      return { id };
    }
  );

  safeHandle(
    'tracker:importer:resnapshot',
    async (_event, args: { workspacePath?: string; urn: string }) => {
      return getTrackerImportService().resnapshot({
        workspacePath: requireWorkspace(args.workspacePath),
        urn: args.urn,
      });
    }
  );

  safeHandle(
    'tracker:importer:applyBody',
    async (_event, args: { workspacePath?: string; urn: string }) => {
      return getTrackerImportService().applyUpstreamBody({
        workspacePath: requireWorkspace(args.workspacePath),
        urn: args.urn,
      });
    }
  );

  safeHandle(
    'tracker:importer:dismissBody',
    async (_event, args: { workspacePath?: string; urn: string }) => {
      return getTrackerImportService().dismissUpstreamBodyChange({
        workspacePath: requireWorkspace(args.workspacePath),
        urn: args.urn,
      });
    }
  );

  // Open the upstream item. The snapshot URL is the common case and opening it
  // must never spin up the importer backend (and its consent prompt); only fall
  // back to the importer's own opener when we have no URL.
  safeHandle(
    'tracker:importer:openExternal',
    async (
      _event,
      args: { workspacePath?: string; providerId: string; externalId: string; url?: string }
    ) => {
      if (args.url) {
        await shell.openExternal(args.url);
        return { ok: true };
      }
      await registry.openExternal(
        requireWorkspace(args.workspacePath),
        args.providerId,
        args.externalId
      );
      return { ok: true };
    }
  );

  logger.main.info('[TrackerImporterHandlers] Handlers registered');
}
