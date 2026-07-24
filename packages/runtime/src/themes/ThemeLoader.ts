/**
 * Theme Loader
 *
 * Platform-agnostic theme loading system for Nimbalyst.
 * Handles discovery, validation, and lifecycle management of themes.
 *
 * Unlike extensions, themes are data-only and cannot contain executable code.
 * This loader provides a simpler, more secure system for loading color themes.
 */

import type {
  Theme,
  ThemeManifest,
  ThemeColors,
  ThemeValidationResult,
  ThemeSource,
  ThemeColorKey,
} from '@nimbalyst/extension-sdk';

const THEME_MANIFEST_FILENAME = 'theme.json';
const MAX_THEME_SIZE_BYTES = 5 * 1024 * 1024; // 5MB
const ALLOWED_FILE_EXTENSIONS = ['.json', '.png', '.jpg', '.jpeg', '.svg', '.webp', '.md', ''];
const ALLOWED_NO_EXTENSION_FILES = ['LICENSE', 'README', 'NOTICE'];

/**
 * Valid CSS color formats.
 */
const HEX_COLOR_PATTERN = /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/;
const RGB_COLOR_PATTERN = /^rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(,\s*[\d.]+\s*)?\)$/;
const HSL_COLOR_PATTERN = /^hsla?\(\s*\d+\s*,\s*\d+%\s*,\s*\d+%\s*(,\s*[\d.]+\s*)?\)$/;

/**
 * CSS named colors (subset of commonly used ones).
 * For simplicity, we primarily expect hex colors.
 */
const CSS_NAMED_COLORS = new Set([
  'black', 'white', 'red', 'green', 'blue', 'yellow', 'cyan', 'magenta',
  'gray', 'grey', 'transparent', 'currentColor',
]);

/**
 * Discovered theme metadata before full loading.
 */
export interface DiscoveredTheme {
  /** Theme ID */
  id: string;

  /** Absolute path to theme directory */
  path: string;

  /** Theme manifest */
  manifest: ThemeManifest;
}

/**
 * Result of loading a theme.
 */
export interface ThemeLoadResult {
  success: boolean;
  theme?: Theme;
  error?: string;
}

/**
 * Platform-specific file operations needed by ThemeLoader.
 */
export interface ThemePlatformService {
  /** Read file as text */
  readFile(path: string): Promise<string>;

  /** Check if path exists */
  exists(path: string): Promise<boolean>;

  /** Check if path is a directory */
  isDirectory(path: string): Promise<boolean>;

  /** List files in directory */
  readDirectory(path: string): Promise<string[]>;

  /** Get file size in bytes */
  getFileSize(path: string): Promise<number>;

  /** Join path segments */
  joinPath(...segments: string[]): string;

  /** Get file extension */
  getExtension(path: string): string;

  /** Get base name from path */
  getBaseName(path: string): string;
}

/**
 * Theme Loader class.
 * Discovers, validates, and loads themes from the file system.
 */
export class ThemeLoader {
  private platformService: ThemePlatformService;
  private loadedThemes = new Map<string, Theme>();
  private discoveredThemes = new Map<string, DiscoveredTheme>();

  constructor(platformService: ThemePlatformService) {
    this.platformService = platformService;
  }

  /**
   * Discover themes in a directory.
   * Each subdirectory containing theme.json is considered a theme.
   */
  async discoverThemes(themesDir: string): Promise<DiscoveredTheme[]> {
    const discovered: DiscoveredTheme[] = [];

    try {
      const exists = await this.platformService.exists(themesDir);
      if (!exists) {
        return [];
      }

      const entries = await this.platformService.readDirectory(themesDir);

      for (const entry of entries) {
        const themePath = this.platformService.joinPath(themesDir, entry);
        const isDir = await this.platformService.isDirectory(themePath);

        if (!isDir) continue;

        const manifestPath = this.platformService.joinPath(themePath, THEME_MANIFEST_FILENAME);
        const manifestExists = await this.platformService.exists(manifestPath);

        if (!manifestExists) continue;

        try {
          const manifestContent = await this.platformService.readFile(manifestPath);
          const manifest = JSON.parse(manifestContent) as ThemeManifest;

          // Basic validation
          if (!manifest.id || !manifest.name || !manifest.version) {
            console.warn(`Invalid theme manifest at ${manifestPath}: missing required fields`);
            continue;
          }

          const discoveredTheme: DiscoveredTheme = {
            id: manifest.id,
            path: themePath,
            manifest,
          };

          discovered.push(discoveredTheme);
          this.discoveredThemes.set(manifest.id, discoveredTheme);
        } catch (err) {
          console.warn(`Failed to parse theme manifest at ${manifestPath}:`, err);
        }
      }
    } catch (err) {
      console.error(`Failed to discover themes in ${themesDir}:`, err);
    }

    return discovered;
  }

  /**
   * Load a theme by ID.
   * Returns cached version if already loaded.
   */
  async loadTheme(themeId: string): Promise<ThemeLoadResult> {
    // Check cache
    const cached = this.loadedThemes.get(themeId);
    if (cached) {
      return { success: true, theme: cached };
    }

    // Find in discovered themes
    const discovered = this.discoveredThemes.get(themeId);
    if (!discovered) {
      return {
        success: false,
        error: `Theme '${themeId}' not found. Did you call discoverThemes()?`,
      };
    }

    // Validate theme
    const validation = await this.validateTheme(discovered.path, discovered.manifest);
    if (!validation.valid) {
      return {
        success: false,
        error: `Theme validation failed: ${validation.errors.join(', ')}`,
      };
    }

    // Build full theme object
    const theme: Theme = {
      id: discovered.manifest.id,
      name: discovered.manifest.name,
      version: discovered.manifest.version,
      author: discovered.manifest.author,
      description: discovered.manifest.description,
      isDark: discovered.manifest.isDark,
      colors: discovered.manifest.colors,
      tags: discovered.manifest.tags,
      source: { type: 'user', installPath: discovered.path },
    };

    // Resolve preview path if specified
    if (discovered.manifest.preview) {
      theme.previewPath = this.platformService.joinPath(
        discovered.path,
        discovered.manifest.preview
      );
    }

    // Cache and return
    this.loadedThemes.set(themeId, theme);
    return { success: true, theme };
  }

  /**
   * Validate a theme directory and manifest.
   */
  async validateTheme(themePath: string, manifest: ThemeManifest): Promise<ThemeValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Validate required fields
    if (!manifest.id) {
      errors.push('Missing required field: id');
    } else {
      // Validate ID format (alphanumeric, dash, underscore only)
      if (!/^[a-zA-Z0-9_-]+$/.test(manifest.id)) {
        errors.push(`Invalid id format: '${manifest.id}'. Use only letters, numbers, dash, and underscore.`);
      }
    }

    if (!manifest.name) {
      errors.push('Missing required field: name');
    }

    if (!manifest.version) {
      errors.push('Missing required field: version');
    } else {
      // Validate semver format
      if (!/^\d+\.\d+\.\d+(-[a-zA-Z0-9.-]+)?$/.test(manifest.version)) {
        errors.push(`Invalid version format: '${manifest.version}'. Use semantic versioning (e.g., 1.0.0)`);
      }
    }

    if (typeof manifest.isDark !== 'boolean') {
      errors.push('Missing or invalid required field: isDark (must be true or false)');
    }

    if (!manifest.colors || typeof manifest.colors !== 'object') {
      errors.push('Missing or invalid required field: colors');
    } else {
      // Validate color values
      for (const [key, value] of Object.entries(manifest.colors)) {
        if (!this.isValidColorKey(key)) {
          warnings.push(`Unknown color key: '${key}'. Will be ignored.`);
          continue;
        }

        if (!this.isValidColorValue(value as string)) {
          errors.push(`Invalid color value for '${key}': '${value}'. Use hex codes (e.g., #ff0000) or CSS color names.`);
        }
      }
    }

    // Validate directory contents (no executable code)
    try {
      const files = await this.platformService.readDirectory(themePath);
      for (const file of files) {
        const ext = this.platformService.getExtension(file);
        const baseName = this.platformService.getBaseName(file);

        // Allow files with permitted extensions or specifically allowed files without extensions
        const hasAllowedExtension = ALLOWED_FILE_EXTENSIONS.includes(ext);
        const isAllowedNoExtFile = ext === '' && ALLOWED_NO_EXTENSION_FILES.includes(baseName);

        if (!hasAllowedExtension && !isAllowedNoExtFile) {
          errors.push(`Disallowed file type in theme directory: '${file}'. Themes can only contain image files, .json, .md, and LICENSE/README/NOTICE files.`);
        }
      }
    } catch (err) {
      errors.push(`Failed to read theme directory: ${err}`);
    }

    // Validate theme size
    try {
      let totalSize = 0;
      const files = await this.platformService.readDirectory(themePath);
      for (const file of files) {
        const filePath = this.platformService.joinPath(themePath, file);
        const size = await this.platformService.getFileSize(filePath);
        totalSize += size;
      }

      if (totalSize > MAX_THEME_SIZE_BYTES) {
        errors.push(`Theme size (${(totalSize / 1024 / 1024).toFixed(2)}MB) exceeds maximum allowed size (${MAX_THEME_SIZE_BYTES / 1024 / 1024}MB)`);
      }
    } catch (err) {
      warnings.push(`Could not calculate theme size: ${err}`);
    }

    // Validate preview file exists if specified
    if (manifest.preview) {
      const previewPath = this.platformService.joinPath(themePath, manifest.preview);
      const exists = await this.platformService.exists(previewPath);
      if (!exists) {
        warnings.push(`Preview file not found: ${manifest.preview}`);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Check if a color key is valid.
   */
  private isValidColorKey(key: string): boolean {
    const validKeys: ThemeColorKey[] = [
      'bg', 'bg-secondary', 'bg-tertiary', 'bg-hover', 'bg-selected', 'bg-active',
      'text', 'text-muted', 'text-faint', 'text-disabled',
      'border', 'border-focus',
      'primary', 'primary-hover',
      'link', 'link-hover',
      'success', 'warning', 'error', 'info',
    ];
    return validKeys.includes(key as ThemeColorKey);
  }

  /**
   * Check if a color value is valid.
   */
  private isValidColorValue(value: string): boolean {
    if (!value || typeof value !== 'string') {
      return false;
    }

    const trimmed = value.trim().toLowerCase();

    // Check hex format
    if (HEX_COLOR_PATTERN.test(trimmed)) {
      return true;
    }

    // Check rgb/rgba format
    if (RGB_COLOR_PATTERN.test(trimmed)) {
      return true;
    }

    // Check hsl/hsla format
    if (HSL_COLOR_PATTERN.test(trimmed)) {
      return true;
    }

    // Check CSS named colors
    if (CSS_NAMED_COLORS.has(trimmed)) {
      return true;
    }

    return false;
  }

  /**
   * Get all loaded themes.
   */
  getLoadedThemes(): Theme[] {
    return Array.from(this.loadedThemes.values());
  }

  /**
   * Get all discovered themes (not necessarily loaded).
   */
  getDiscoveredThemes(): DiscoveredTheme[] {
    return Array.from(this.discoveredThemes.values());
  }

  /**
   * Get a specific theme by ID (from cache).
   */
  getTheme(themeId: string): Theme | undefined {
    return this.loadedThemes.get(themeId);
  }

  /**
   * Clear the theme cache.
   */
  clearCache(): void {
    this.loadedThemes.clear();
  }

  /**
   * Reload themes (clear cache and rediscover).
   */
  async reload(themesDir: string): Promise<void> {
    this.clearCache();
    this.discoveredThemes.clear();
    await this.discoverThemes(themesDir);
  }
}
