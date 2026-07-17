/**
 * Built-in extensions directory resolution.
 *
 * Extracted from ExtensionHandlers so modules deeper in the import graph
 * (notably PrivilegedExtensionHost, which ExtensionHandlers reaches via
 * backendModuleLifecycle) can ask "is this extension path built-in?" without
 * creating an import cycle back into the IPC layer.
 */
import { app } from 'electron';
import * as fs from 'fs/promises';
import * as path from 'path';
import { logger } from '../utils/logger';

/**
 * Get the path to the built-in extensions directory.
 * Returns null if the directory doesn't exist.
 */
export async function getBuiltinExtensionsDirectory(): Promise<string | null> {
  // In production, built-in extensions are in resources/extensions
  // In development, they're in packages/extensions relative to the electron package
  const possiblePaths = app.isPackaged
    ? [
        path.join(process.resourcesPath, 'extensions'),
        path.join(process.resourcesPath, 'app.asar.unpacked', 'extensions'),
      ]
    : [
        // Development: relative to __dirname (out/main/chunks in vite build)
        // Go up 4 levels to packages/, then into extensions/
        path.join(__dirname, '..', '..', '..', '..', 'extensions'),
        // Fallback: if __dirname is out/main (no chunks)
        path.join(__dirname, '..', '..', '..', 'extensions'),
        path.join(__dirname, '..', '..', 'resources', 'extensions'),
      ];

  for (const possiblePath of possiblePaths) {
    try {
      await fs.access(possiblePath);
      logger.main.debug('[ExtensionHandlers] Built-in extensions directory:', possiblePath);
      return possiblePath;
    } catch {
      // Path doesn't exist, try next
    }
  }

  logger.main.debug('[ExtensionHandlers] No built-in extensions directory found');
  return null;
}

/**
 * True when `extensionPath` points inside the built-in extensions directory.
 * Built-in extensions ship with the app bundle (or the in-repo
 * packages/extensions dir in dev) and are the same trust domain as the app
 * itself, which is why their backend modules are auto-granted and the consent
 * prompt is skipped for them.
 */
export async function isBuiltinExtensionPath(extensionPath: string): Promise<boolean> {
  const builtinDir = await getBuiltinExtensionsDirectory();
  if (!builtinDir) return false;
  const rel = path.relative(builtinDir, extensionPath);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}
