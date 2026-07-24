/**
 * Discovery of tracker-importer contributions from installed extensions.
 *
 * Walks the same extension directories as the rest of the extension system,
 * parses each manifest, and returns the importers it declares along with the
 * backend module that implements them. Backend modules are shape-validated
 * exactly like `ExtensionHandlers.validateAndScrubBackendModules`; whether the
 * native code may run is the user's first-use consent prompt, not a gate here.
 *
 * Results are cached briefly; call {@link clearImporterDiscoveryCache} after an
 * install/uninstall to force a re-scan.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { logger } from '../../utils/logger';
import { validateBackendModules } from '@nimbalyst/extension-sdk';
import type {
  BackendModuleContribution,
  TrackerImporterContribution,
} from '@nimbalyst/extension-sdk';
import { getAllExtensionDirectories } from '../../ipc/ExtensionHandlers';
import { getExtensionEnabled, getReleaseChannel } from '../../utils/store';

export interface ResolvedImporter {
  extensionId: string;
  extensionName: string;
  extensionPath: string;
  contribution: TrackerImporterContribution;
  /** The backend module that implements the importer's `importer.*` RPC methods. */
  module: BackendModuleContribution;
}

const CACHE_TTL_MS = 5_000;
let cache: { at: number; importers: ResolvedImporter[] } | null = null;

export function clearImporterDiscoveryCache(): void {
  cache = null;
}

/**
 * Enumerate every enabled extension's tracker importers. Skips importers whose
 * backend module is missing, invalid, or not allowlisted to ship native code.
 */
export async function discoverImporters(): Promise<ResolvedImporter[]> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) {
    return cache.importers;
  }

  const importers: ResolvedImporter[] = [];
  const seenExtensionIds = new Set<string>();
  const extensionDirs = await getAllExtensionDirectories();
  const channel = getReleaseChannel();

  for (const extensionsDir of extensionDirs) {
    let subdirs;
    try {
      subdirs = await fs.readdir(extensionsDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const subdir of subdirs) {
      const isSymlink = subdir.isSymbolicLink();
      let isDir = subdir.isDirectory();
      if (!isDir && isSymlink) {
        try {
          const stat = await fs.stat(path.join(extensionsDir, subdir.name));
          isDir = stat.isDirectory();
        } catch {
          continue;
        }
      }
      if (!isDir) continue;

      const extensionPath = path.join(extensionsDir, subdir.name);
      const manifestPath = path.join(extensionPath, 'manifest.json');
      let manifest: any;
      try {
        manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));
      } catch {
        continue;
      }

      const extensionId: string = manifest.id || subdir.name;
      if (seenExtensionIds.has(extensionId)) continue;
      seenExtensionIds.add(extensionId);

      const contributions = manifest.contributions as Record<string, unknown> | undefined;
      const trackerImporters = contributions?.trackerImporters as
        | TrackerImporterContribution[]
        | undefined;
      if (!Array.isArray(trackerImporters) || trackerImporters.length === 0) continue;

      // Channel gate (alpha-only extensions hidden on stable).
      const required = manifest.requiredReleaseChannel;
      if (required === 'alpha' && channel !== 'alpha') continue;

      // Importers are inert unless the extension is enabled.
      if (!getExtensionEnabled(extensionId)) continue;

      const backendModules = contributions?.backendModules as
        | BackendModuleContribution[]
        | undefined;
      if (!Array.isArray(backendModules) || backendModules.length === 0) {
        logger.main.warn(
          `[TrackerImporterDiscovery] ${extensionId} declares trackerImporters but no backendModules; skipping`
        );
        continue;
      }

      // Reject malformed backend modules (shape only). Native-code consent is
      // the user's first-use prompt, not a provenance gate.
      const moduleIssues = validateBackendModules(backendModules);
      if (moduleIssues.some((i) => i.severity !== 'warning')) {
        logger.main.error(
          `[TrackerImporterDiscovery] ${extensionId} has invalid backendModules; skipping importers`
        );
        continue;
      }

      for (const contribution of trackerImporters) {
        const module = backendModules.find((m) => m.id === contribution.backendModuleId);
        if (!module) {
          logger.main.warn(
            `[TrackerImporterDiscovery] ${extensionId} importer '${contribution.id}' references unknown backendModuleId '${contribution.backendModuleId}'`
          );
          continue;
        }
        importers.push({
          extensionId,
          extensionName: manifest.name || extensionId,
          extensionPath,
          contribution,
          module,
        });
      }
    }
  }

  cache = { at: now, importers };
  return importers;
}

/** Find one importer by its provider id (the contribution id). */
export async function findImporter(providerId: string): Promise<ResolvedImporter | null> {
  const all = await discoverImporters();
  return all.find((i) => i.contribution.id === providerId) ?? null;
}

/** Find the importer that owns a URN scheme (for routing by URN). */
export async function findImporterByUrnScheme(
  scheme: string
): Promise<ResolvedImporter | null> {
  const all = await discoverImporters();
  return all.find((i) => i.contribution.urnScheme === scheme) ?? null;
}
