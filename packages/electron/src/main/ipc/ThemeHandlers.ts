/**
 * Theme IPC Handlers
 *
 * Handles theme discovery, installation, validation, and management.
 */

import { ThemeLoader } from '@nimbalyst/runtime/themes/ThemeLoader';
import type {
  Theme,
  ThemeManifest,
  ThemeValidationResult,
} from '@nimbalyst/extension-sdk';
import { BrowserWindow, shell } from 'electron';
import { safeHandle, safeOn } from '../utils/ipcRegistry';
import path from 'path';
import fs from 'fs/promises';
import { app } from 'electron';
import {
  getTheme,
  setTheme,
  getThemeIsDark,
  getPendingThemeFallback,
  setPendingThemeFallback,
  clearPendingThemeFallback,
} from '../utils/store';
import { updateNativeTheme, updateWindowTitleBars } from '../theme/ThemeManager';

/**
 * Platform service implementation for Electron.
 */
class ElectronThemePlatformService {
  async readFile(filePath: string): Promise<string> {
    return await fs.readFile(filePath, 'utf-8');
  }

  async exists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async isDirectory(filePath: string): Promise<boolean> {
    try {
      const stats = await fs.stat(filePath);
      return stats.isDirectory();
    } catch {
      return false;
    }
  }

  async readDirectory(dirPath: string): Promise<string[]> {
    return await fs.readdir(dirPath);
  }

  async getFileSize(filePath: string): Promise<number> {
    const stats = await fs.stat(filePath);
    return stats.size;
  }

  joinPath(...segments: string[]): string {
    return path.join(...segments);
  }

  getExtension(filePath: string): string {
    return path.extname(filePath);
  }

  getBaseName(filePath: string): string {
    return path.basename(filePath);
  }
}

// Initialize theme loader
const platformService = new ElectronThemePlatformService();
const themeLoader = new ThemeLoader(platformService);

/**
 * Renderer-driven cache of themes contributed by enabled extensions.
 * Pushed via the `theme:extension-themes-changed` IPC channel from the
 * ExtensionThemeBridge. The renderer is the source of truth -- this is just
 * a mirror for `theme:list` merging and `reconcileActiveTheme`.
 */
interface CachedExtensionTheme {
  id: string;
  name: string;
  isDark: boolean;
  contributedBy: string;
}
let extensionThemesCache: CachedExtensionTheme[] = [];

/** True once the extension load pass has completed at least once in the renderer. */
let extensionsHydrated = false;

// Track the user themes dir once it's resolved -- used to decide origin.
let cachedUserThemesDir: string | null = null;

// Track if handlers are registered
let handlersRegistered = false;

/**
 * Get the user themes directory path.
 * Creates the directory if it doesn't exist.
 */
async function getUserThemesDir(): Promise<string> {
  const userDataPath = app.getPath('userData');
  const themesDir = path.join(userDataPath, 'themes');

  // Ensure directory exists
  try {
    await fs.mkdir(themesDir, { recursive: true });
  } catch (err) {
    console.error('Failed to create themes directory:', err);
  }

  return themesDir;
}

/**
 * Get the built-in themes directory path.
 */
function getBuiltInThemesDir(): string {
  // Built-in themes are in the runtime package
  // In development: packages/runtime/src/themes/builtin
  // In production: Resources/node_modules/@nimbalyst/runtime/dist/themes/builtin (extraResources)
  const isDev = !app.isPackaged;

  let themesDir: string;
  if (isDev) {
    const appPath = app.getAppPath();
    // Development: appPath is packages/electron, so go up one level to packages/
    // then into runtime/src/themes/builtin
    themesDir = path.join(appPath, '..', 'runtime', 'src', 'themes', 'builtin');
  } else {
    // Production: Themes are in extraResources (Resources/ not app.asar/)
    // process.resourcesPath points to app.asar/../ (the Resources directory)
    themesDir = path.join(process.resourcesPath, 'node_modules', '@nimbalyst', 'runtime', 'dist', 'themes', 'builtin');
  }

  // Log diagnostic info for debugging theme issues on different platforms
  console.log('[ThemeHandlers] Platform diagnostic:', {
    platform: process.platform,
    arch: process.arch,
    isDev,
    appPath: isDev ? app.getAppPath() : undefined,
    resourcesPath: !isDev ? process.resourcesPath : undefined,
    calculatedThemesDir: themesDir
  });

  return themesDir;
}

/**
 * Build the merged list of theme manifests for `theme:list` -- filesystem
 * themes (with `origin` set) plus extension-contributed themes (synthesized
 * manifest entries with `origin: 'extension'` and `contributedBy`).
 */
function buildMergedThemeList(): ThemeManifest[] {
  const filesystem = themeLoader.getDiscoveredThemes().map(d => {
    const isUser = cachedUserThemesDir ? d.path.startsWith(cachedUserThemesDir) : false;
    return {
      ...d.manifest,
      origin: isUser ? 'user' : 'builtin',
    } as ThemeManifest;
  });

  const extension: ThemeManifest[] = extensionThemesCache.map(t => ({
    id: t.id,
    name: t.name,
    isDark: t.isDark,
    version: '0.0.0',
    colors: {},
    origin: 'extension' as const,
    contributedBy: t.contributedBy,
  }));

  return [...filesystem, ...extension];
}

/**
 * Whether a theme ID exists either as a filesystem theme or as an extension
 * theme currently registered.
 */
function themeExists(themeId: string): boolean {
  if (themeId === 'light' || themeId === 'dark' || themeId === 'system' || themeId === 'auto') {
    return true;
  }
  if (themeLoader.getDiscoveredThemes().some(d => d.manifest.id === themeId)) {
    return true;
  }
  if (extensionThemesCache.some(t => t.id === themeId)) {
    return true;
  }
  return false;
}

/**
 * If the persisted active theme is no longer available (extension uninstalled
 * or disabled, theme file removed), apply a sensible fallback (`dark` or
 * `light` depending on the missing theme's previously-known dark mode).
 *
 * Only runs after the extension load pass completes -- otherwise the
 * still-loading extension theme would be considered "missing" and trigger an
 * unnecessary fallback that gets immediately overwritten.
 */
function reconcileActiveTheme(): void {
  if (!extensionsHydrated) {
    return;
  }

  const activeId = getTheme();
  if (!activeId) return;
  if (themeExists(activeId)) {
    return;
  }

  const wasDark = getThemeIsDark() ?? activeId.includes('dark');
  const fallbackId = wasDark ? 'dark' : 'light';

  console.info(
    `[ThemeHandlers] Active theme '${activeId}' is no longer available, falling back to '${fallbackId}'`
  );

  setTheme(fallbackId, wasDark);
  setPendingThemeFallback({ missingId: activeId, appliedId: fallbackId });

  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send('theme-change', fallbackId);
    win.webContents.send('theme:fallback-applied', { missingId: activeId, appliedId: fallbackId });
  }

  updateNativeTheme();
  updateWindowTitleBars();
}

/** Broadcast that the theme list changed so panels can refresh. */
function broadcastThemeListChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send('theme:list-changed');
  }
}

export async function registerThemeHandlers() {
  if (handlersRegistered) {
    console.log('[ThemeHandlers] Handlers already registered, skipping');
    return;
  }

  // Discover themes on startup
  const userThemesDir = await getUserThemesDir();
  cachedUserThemesDir = userThemesDir;
  const builtInThemesDir = getBuiltInThemesDir();

  console.log('[ThemeHandlers] User themes directory:', userThemesDir);
  console.log('[ThemeHandlers] Built-in themes directory:', builtInThemesDir);

  // Check if built-in themes directory exists before discovery
  const builtInExists = await platformService.exists(builtInThemesDir);
  console.log('[ThemeHandlers] Built-in themes directory exists:', builtInExists);

  const userThemes = await themeLoader.discoverThemes(userThemesDir);
  const builtInThemes = await themeLoader.discoverThemes(builtInThemesDir);

  console.log('[ThemeHandlers] Discovered', userThemes.length, 'user themes');
  console.log('[ThemeHandlers] Discovered', builtInThemes.length, 'built-in themes');

  // If no built-in themes found, log more details for debugging
  if (builtInThemes.length === 0 && builtInExists) {
    try {
      const entries = await fs.readdir(builtInThemesDir);
      console.log('[ThemeHandlers] Built-in themes directory contents:', entries);
    } catch (err) {
      console.error('[ThemeHandlers] Failed to read built-in themes directory:', err);
    }
  }

  // List all themes -- filesystem themes (with `origin` populated) plus
  // extension-contributed themes pushed from the renderer.
  safeHandle('theme:list', async () => {
    return buildMergedThemeList();
  });

  // Receive extension theme list updates from the renderer's theme bridge.
  // Cached for `theme:list` and used to drive `reconcileActiveTheme`.
  safeOn('theme:extension-themes-changed', (_event, themes: CachedExtensionTheme[]) => {
    if (!Array.isArray(themes)) {
      console.warn('[ThemeHandlers] Ignoring invalid extension-themes-changed payload');
      return;
    }
    extensionThemesCache = themes
      .filter(t => t && typeof t.id === 'string' && typeof t.contributedBy === 'string')
      .map(t => ({
        id: t.id,
        name: typeof t.name === 'string' ? t.name : t.id,
        isDark: t.isDark === true,
        contributedBy: t.contributedBy,
      }));
    extensionsHydrated = true;
    broadcastThemeListChanged();
    reconcileActiveTheme();
  });

  // Pending fallback notice — read by the Themes panel banner.
  safeHandle('theme:get-pending-fallback', async () => {
    return getPendingThemeFallback() ?? null;
  });

  safeOn('theme:dismiss-pending-fallback', () => {
    clearPendingThemeFallback();
  });

  // Get a specific theme by ID
  safeHandle('theme:get', async (event, themeId: string) => {
    const result = await themeLoader.loadTheme(themeId);
    if (!result.success) {
      throw new Error(result.error);
    }
    return result.theme;
  });

  // Validate a theme directory
  safeHandle('theme:validate', async (event, themePath: string) => {
    try {
      // Read manifest
      const manifestPath = path.join(themePath, 'theme.json');
      const manifestContent = await fs.readFile(manifestPath, 'utf-8');
      const manifest = JSON.parse(manifestContent) as ThemeManifest;

      // Validate
      return await themeLoader.validateTheme(themePath, manifest);
    } catch (err) {
      return {
        valid: false,
        errors: [`Failed to validate theme: ${err}`],
        warnings: [],
      } as ThemeValidationResult;
    }
  });

  // Install a theme from a directory or .nimtheme file
  safeHandle('theme:install', async (event, sourcePath: string, overwrite = false) => {
    const userThemesDir = await getUserThemesDir();

    try {
      // Check if source is a .nimtheme file (zip)
      const ext = path.extname(sourcePath);
      if (ext === '.nimtheme') {
        // TODO: Extract zip to temporary directory
        // For now, just throw an error
        throw new Error('.nimtheme installation not yet implemented');
      }

      // Source is a directory
      const manifestPath = path.join(sourcePath, 'theme.json');
      const manifestContent = await fs.readFile(manifestPath, 'utf-8');
      const manifest = JSON.parse(manifestContent) as ThemeManifest;

      // Validate theme
      const validation = await themeLoader.validateTheme(sourcePath, manifest);
      if (!validation.valid) {
        throw new Error(`Theme validation failed: ${validation.errors.join(', ')}`);
      }

      // Check if theme already exists
      const targetPath = path.join(userThemesDir, manifest.id);
      const exists = await platformService.exists(targetPath);
      if (exists && !overwrite) {
        throw new Error(`Theme '${manifest.id}' already exists. Use overwrite option to replace.`);
      }

      // Copy theme directory
      await fs.cp(sourcePath, targetPath, { recursive: true });

      // Reload themes
      await themeLoader.reload(userThemesDir);

      // Load the newly installed theme
      const result = await themeLoader.loadTheme(manifest.id);
      if (!result.success) {
        throw new Error(result.error);
      }

      return {
        success: true,
        theme: result.theme,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  // Uninstall a theme
  safeHandle('theme:uninstall', async (event, themeId: string) => {
    const userThemesDir = await getUserThemesDir();

    try {
      // Find theme
      const discovered = themeLoader.getDiscoveredThemes();
      const theme = discovered.find(t => t.id === themeId);

      if (!theme) {
        throw new Error(`Theme '${themeId}' not found`);
      }

      // Check if theme is in user directory (can't uninstall built-in themes)
      if (!theme.path.startsWith(userThemesDir)) {
        throw new Error(`Cannot uninstall built-in theme '${themeId}'`);
      }

      // Move theme directory to trash (recoverable)
      await shell.trashItem(theme.path);

      // Reload themes
      await themeLoader.reload(userThemesDir);

      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  // Reload themes (rescan directories)
  safeHandle('theme:reload', async () => {
    const userThemesDir = await getUserThemesDir();
    const builtInThemesDir = getBuiltInThemesDir();

    await themeLoader.reload(userThemesDir);
    await themeLoader.discoverThemes(builtInThemesDir);

    return { success: true };
  });

  handlersRegistered = true;
  console.log('[ThemeHandlers] Handlers registered successfully');
}
