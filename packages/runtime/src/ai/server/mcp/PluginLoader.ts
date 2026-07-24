/**
 * Plugin loader for Claude Agent SDK
 *
 * Loads extension plugins from:
 * - Extension system (via injected loader)
 * - CLI-installed plugins from ~/.claude/plugins/
 *
 * Plugins are local TypeScript/JavaScript modules that extend the SDK
 * with custom functionality.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Plugin definition for SDK
 */
export interface Plugin {
  type: 'local';
  path: string;
}

/**
 * Configuration options for PluginLoader
 */
export interface PluginLoaderOptions {
  /**
   * Optional function to load extension plugins
   * Injected by the main process to provide access to extension system
   */
  extensionPluginsLoader?: (workspacePath?: string) => Promise<Plugin[]>;
}

/**
 * Loads plugins from multiple sources and merges them
 */
export class PluginLoader {
  private readonly extensionPluginsLoader?: (workspacePath?: string) => Promise<Plugin[]>;

  constructor(options: PluginLoaderOptions = {}) {
    this.extensionPluginsLoader = options.extensionPluginsLoader;
  }

  /**
   * Load all plugins for a workspace
   *
   * Merges plugins from:
   * 1. Extension system (if loader provided)
   * 2. CLI-installed plugins from ~/.claude/plugins/
   *
   * Duplicates are removed based on normalized paths.
   *
   * @param workspacePath - Optional workspace path for extension plugins
   * @returns Array of plugin definitions
   */
  async loadPlugins(workspacePath?: string): Promise<Plugin[]> {
    const plugins: Plugin[] = [];
    const seenPaths = new Set<string>();

    // Load extension plugins first (if available)
    if (this.extensionPluginsLoader) {
      try {
        const extensionPlugins = await this.extensionPluginsLoader(workspacePath);
        for (const plugin of extensionPlugins) {
          const normalizedPath = path.normalize(plugin.path);
          if (!seenPaths.has(normalizedPath)) {
            plugins.push(plugin);
            seenPaths.add(normalizedPath);
          }
        }
      } catch (error) {
        console.error('[PluginLoader] Failed to load extension plugins:', error);
      }
    }

    // Load CLI-installed plugins from ~/.claude/plugins/
    const cliPlugins = await this.loadCliPlugins();
    for (const plugin of cliPlugins) {
      const normalizedPath = path.normalize(plugin.path);
      if (!seenPaths.has(normalizedPath)) {
        plugins.push(plugin);
        seenPaths.add(normalizedPath);
      }
    }

    return plugins;
  }

  /**
   * Load plugins from ~/.claude/plugins/ directory
   *
   * CLI plugins are installed by the Claude CLI tool and stored in the
   * user's home directory.
   *
   * @returns Array of CLI plugin definitions
   */
  private async loadCliPlugins(): Promise<Plugin[]> {
    const plugins: Plugin[] = [];
    const pluginsDir = path.join(os.homedir(), '.claude', 'plugins');

    try {
      // Check if plugins directory exists
      const exists = await fs.promises.access(pluginsDir)
        .then(() => true)
        .catch(() => false);

      if (!exists) {
        return plugins;
      }

      // Read all entries in the plugins directory
      const entries = await fs.promises.readdir(pluginsDir, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.isDirectory()) {
          // Each plugin is a directory with a package.json
          const pluginPath = path.join(pluginsDir, entry.name);
          const packageJsonPath = path.join(pluginPath, 'package.json');

          try {
            // Verify package.json exists
            await fs.promises.access(packageJsonPath);

            // Add plugin to list
            plugins.push({
              type: 'local',
              path: pluginPath,
            });
          } catch {
            // Not a valid plugin directory, skip
            continue;
          }
        }
      }
    } catch (error) {
      // Directory doesn't exist or can't be read - not an error, just no CLI plugins
      return plugins;
    }

    return plugins;
  }
}
