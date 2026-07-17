/**
 * IPC handlers for extension-related operations.
 *
 * Provides handlers for:
 * - Getting the extensions directory
 * - Reading extension files
 * - Loading extension modules
 * - Directory listing
 */

import { app } from 'electron';
import * as fs from 'fs/promises';
import * as path from 'path';
import { logger } from '../utils/logger';
import { safeHandle, safeOn } from '../utils/ipcRegistry';
import { SessionFileWatcher } from '../file/SessionFileWatcher';
import { minimatch } from 'minimatch';
import {
  getExtensionSettings,
  getExtensionEnabled,
  setExtensionEnabled,
  getClaudePluginEnabled,
  setClaudePluginEnabled,
  getAgentWorkflowsEnabled,
  setAgentWorkflowsEnabled,
  getExtensionConfiguration,
  setExtensionConfiguration,
  setExtensionConfigurationBulk,
  getWorkspaceExtensionConfiguration,
  setWorkspaceExtensionConfiguration,
  setWorkspaceExtensionConfigurationBulk,
  getReleaseChannel,
} from '../utils/store';
import { registerFileExtension, clearRegisteredExtensions } from '../extensions/RegisteredFileTypes';
import { getBuiltinExtensionsDirectory } from '../extensions/builtinExtensionsDirectory';
import {
  startExtensionBackendModules,
  stopExtensionBackendModules,
  getDefaultBackendModuleLifecycleDeps,
} from '../extensions/backendModuleLifecycle';
import { validateBackendModules } from '@nimbalyst/extension-sdk';
import { ModelIdentifier } from '@nimbalyst/runtime/ai/server/types';
import type { ReleaseChannel } from '../utils/store';
import { buildExtensionFindFilesPlan } from './extensionFindFilesPlan';
import { database } from '../database/PGLiteDatabaseWorker';
import { isAllowedToContributeBackendModules } from '../extensions/backendModuleAllowlist';
import { getAgentProviderRegistry } from '../extensions/AgentProviderRegistry';
import type {
  AiAgentProviderContribution,
  BackendModuleContribution,
  ExtensionManifest,
} from '@nimbalyst/extension-sdk';

/**
 * Validate the SHAPE of `contributions.backendModules` on a parsed manifest.
 * A malformed declaration is stripped so downstream code never sees it (the
 * rest of the extension's contributions still load). This is a correctness
 * check only -- any extension may ship a backend module; whether its native
 * code runs is decided by the user's first-use consent prompt, not here.
 *
 * Mutates the manifest in place. Returns true if backendModules survived;
 * false if it was stripped.
 */
function validateAndScrubBackendModules(
  manifest: Record<string, unknown>,
  extensionId: string,
  context: { isBuiltin: boolean; isSymlink: boolean }
): boolean {
  const contributions = manifest?.contributions as Record<string, unknown> | undefined;
  if (!contributions || contributions.backendModules === undefined) {
    return true;
  }

  // Step 1: shape validation. Warnings are non-fatal (legacy deprecated
  // permission ids are dropped silently by the SDK validator).
  const issues = validateBackendModules(contributions.backendModules);
  const errors = issues.filter((i) => i.severity !== 'warning');
  const warnings = issues.filter((i) => i.severity === 'warning');
  if (warnings.length > 0) {
    logger.main.warn(
      `[ExtensionHandlers] Extension ${extensionId} backendModules has warnings:`,
      warnings
    );
  }
  if (errors.length > 0) {
    logger.main.error(
      `[ExtensionHandlers] Extension ${extensionId} has invalid backendModules; ` +
        `stripping the field so it cannot load privileged capabilities. Issues:`,
      errors
    );
    delete contributions.backendModules;
    return false;
  }

  // Step 2: classify provenance for the audit log. This is not a gate -- any
  // extension may ship a backend module; the user's first-use consent prompt
  // is the control. Built-in modules are auto-granted downstream.
  const decision = isAllowedToContributeBackendModules({
    extensionId,
    isBuiltin: context.isBuiltin,
    isSymlink: context.isSymlink,
  });
  logger.main.info(
    `[ExtensionHandlers] Extension ${extensionId} ships backend modules (source: ${decision.reason}); ` +
      `native-code consent is gated by the first-use prompt.`
  );

  return true;
}

/**
 * Check if an extension should be visible for the current release channel.
 * Extensions with requiredReleaseChannel: 'alpha' are only visible to alpha users.
 * Extensions without this field or with 'stable' are visible to everyone.
 */
function isExtensionVisibleForChannel(
  manifest: { requiredReleaseChannel?: ReleaseChannel },
  currentChannel: ReleaseChannel
): boolean {
  const requiredChannel = manifest.requiredReleaseChannel;

  // No requirement or 'stable' requirement = visible to everyone
  if (!requiredChannel || requiredChannel === 'stable') {
    return true;
  }

  // 'alpha' requirement = only visible to alpha users
  if (requiredChannel === 'alpha') {
    return currentChannel === 'alpha';
  }

  // Unknown channel requirement = default to visible (fail open)
  return true;
}

/**
 * Initialize extension file type registry.
 * Should be called during app startup to ensure file types are registered
 * before any file operations occur.
 */
export async function initializeExtensionFileTypes(): Promise<void> {
  try {
    logger.main.info('[ExtensionHandlers] Initializing extension file types...');
    clearRegisteredExtensions();

    const extensionDirs = await getAllExtensionDirectories();
    const currentChannel = getReleaseChannel();

    for (let dirIndex = 0; dirIndex < extensionDirs.length; dirIndex++) {
      const extensionsDir = extensionDirs[dirIndex];
      // extensionDirs[0] is the user extensions dir; the rest are built-in.
      const isBuiltinDir = dirIndex > 0;
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
            const targetPath = path.join(extensionsDir, subdir.name);
            const stat = await fs.stat(targetPath);
            isDir = stat.isDirectory();
          } catch {
            continue;
          }
        }
        if (!isDir) continue;

        const extensionPath = path.join(extensionsDir, subdir.name);
        const manifestPath = path.join(extensionPath, 'manifest.json');

        try {
          const manifestContent = await fs.readFile(manifestPath, 'utf-8');
          const manifest = JSON.parse(manifestContent);

          // Skip extensions that require a different release channel
          if (!isExtensionVisibleForChannel(manifest, currentChannel)) {
            logger.main.debug(`[ExtensionHandlers] Skipping extension ${manifest.id} (requires ${manifest.requiredReleaseChannel} channel)`);
            continue;
          }

          // Register file patterns from customEditors
          if (manifest.contributions?.customEditors) {
            for (const editor of manifest.contributions.customEditors) {
              if (editor.filePatterns) {
                for (const pattern of editor.filePatterns) {
                  if (pattern.startsWith('*.')) {
                    const ext = pattern.substring(1);
                    registerFileExtension(ext);
                    logger.main.info(`[ExtensionHandlers] Registered file type: ${ext} (from ${manifest.id})`);
                  }
                }
              }
            }
          }

          // Catalog aiAgentProviders into the AgentProviderRegistry here too,
          // so the catalog is populated at boot and after every install /
          // uninstall (this function is the shared rescan hook), not only when
          // the renderer happens to invoke extensions:list-installed. Without
          // this an installed agent-provider extension stays invisible to the
          // model picker until a list-installed call lands. register() is
          // idempotent and preserves consent status, so re-running is safe.
          const agentExtensionId = manifest.id || subdir.name;
          validateAndScrubBackendModules(manifest, agentExtensionId, {
            isBuiltin: isBuiltinDir,
            isSymlink,
          });
          registerAgentProviderContributions(
            manifest as ExtensionManifest,
            agentExtensionId,
            extensionPath
          );
        } catch {
          // Skip directories without valid manifest
        }
      }
    }

    logger.main.info('[ExtensionHandlers] Extension file types initialized');
  } catch (error) {
    logger.main.error('[ExtensionHandlers] Failed to initialize extension file types:', error);
  }
}

/**
 * Get the path to the user extensions directory.
 * Creates it if it doesn't exist.
 * In Playwright tests, uses a temp directory to avoid touching production extensions.
 */
export async function getUserExtensionsDirectory(): Promise<string> {
  // Use test-specific path for Playwright tests to avoid conflicts
  const userDataPath = process.env.PLAYWRIGHT === '1'
    ? path.join(app.getPath('temp'), 'nimbalyst-test-extensions')
    : app.getPath('userData');
  const extensionsPath = path.join(userDataPath, 'extensions');

  try {
    await fs.mkdir(extensionsPath, { recursive: true });
  } catch (error) {
    // Directory already exists or other error
    logger.main.debug('[ExtensionHandlers] User extensions directory:', extensionsPath);
  }

  return extensionsPath;
}

/**
 * Get all extension directories (both user and built-in).
 */
export async function getAllExtensionDirectories(): Promise<string[]> {
  const dirs: string[] = [];

  // Always include user extensions directory
  dirs.push(await getUserExtensionsDirectory());

  // Include built-in extensions if available
  const builtinDir = await getBuiltinExtensionsDirectory();
  if (builtinDir) {
    dirs.push(builtinDir);
  }

  return dirs;
}

/**
 * An extension's surviving (post validate + allowlist scrub) backend-module
 * declarations, plus the disk path the entry file resolves against. Returned
 * by the backend-module scan that the start-on-enable lifecycle consumes.
 */
export interface ResolvedExtensionBackendModules {
  extensionId: string;
  extensionName: string;
  extensionPath: string;
  modules: BackendModuleContribution[];
  /**
   * Module ids referenced by this extension's `aiAgentProviders` contributions
   * (each provider's `backendModuleId`). The backend-module lifecycle skips these
   * for eager auto-start — they start lazily via the extensionAgentBridge on
   * first use of the provider.
   */
  agentProviderModuleIds: string[];
}

/**
 * Scan every extension directory (user first, then built-in) and return, for
 * each extension that declares backend modules surviving the validate +
 * allowlist scrub and is visible for the current release channel, its resolved
 * path + module list. Does NOT consult enabled-state — the lifecycle caller
 * filters on `getExtensionEnabled`. Mirrors the `extensions:list-installed`
 * scan but only retains backend-module-bearing extensions.
 */
export async function listExtensionBackendModules(): Promise<ResolvedExtensionBackendModules[]> {
  const out: ResolvedExtensionBackendModules[] = [];
  const seenExtensionIds = new Set<string>();
  const currentChannel = getReleaseChannel();
  const extensionDirs = await getAllExtensionDirectories();

  for (let i = 0; i < extensionDirs.length; i++) {
    const extensionsDir = extensionDirs[i];
    const isBuiltinDir = i > 0; // First directory is user extensions
    let subdirs;
    try {
      subdirs = await fs.readdir(extensionsDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const subdir of subdirs) {
      let isDir = subdir.isDirectory();
      const isSymlink = subdir.isSymbolicLink();
      if (!isDir && isSymlink) {
        try {
          isDir = (await fs.stat(path.join(extensionsDir, subdir.name))).isDirectory();
        } catch {
          continue;
        }
      }
      if (!isDir) continue;

      const extensionPath = path.join(extensionsDir, subdir.name);
      try {
        const manifest = JSON.parse(
          await fs.readFile(path.join(extensionPath, 'manifest.json'), 'utf-8')
        ) as ExtensionManifest & { id?: string; name?: string };
        const extensionId = manifest.id || subdir.name;
        if (seenExtensionIds.has(extensionId)) continue;
        seenExtensionIds.add(extensionId);
        if (!isExtensionVisibleForChannel(manifest, currentChannel)) continue;

        // Strip invalid / disallowed backend modules in place, exactly as the
        // list-installed scan does, so we only start what is actually allowed.
        validateAndScrubBackendModules(manifest as unknown as Record<string, unknown>, extensionId, {
          isBuiltin: isBuiltinDir,
          isSymlink,
        });

        const modules = (manifest.contributions?.backendModules ?? []) as BackendModuleContribution[];
        if (modules.length === 0) continue;

        const agentProviderModuleIds = (
          (manifest.contributions?.aiAgentProviders ?? []) as Array<{ backendModuleId?: string }>
        )
          .map((p) => p.backendModuleId)
          .filter((id): id is string => typeof id === 'string' && id.length > 0);

        out.push({
          extensionId,
          extensionName: manifest.name || extensionId,
          extensionPath,
          modules,
          agentProviderModuleIds,
        });
      } catch {
        // Skip directories without a valid manifest
      }
    }
  }

  return out;
}

/**
 * Resolve the surviving backend modules for a single extension id, or null if
 * the extension is not installed / declares none.
 */
export async function resolveExtensionBackendModules(
  extensionId: string
): Promise<ResolvedExtensionBackendModules | null> {
  const all = await listExtensionBackendModules();
  return all.find((e) => e.extensionId === extensionId) ?? null;
}

/**
 * Return type for extension plugin commands
 */
export interface ExtensionPluginCommand {
  extensionId: string;
  extensionName: string;
  pluginName: string;
  pluginNamespace: string;
  commandName: string;
  description: string;
}

/**
 * Get Claude plugin commands from all enabled extensions.
 * Exported for use by SlashCommandHandlers.
 */
export async function getExtensionPluginCommands(): Promise<ExtensionPluginCommand[]> {
  try {
    const commands: ExtensionPluginCommand[] = [];
    const seenExtensionIds = new Set<string>();
    const currentChannel = getReleaseChannel();

    // Scan all extension directories
    const extensionDirs = await getAllExtensionDirectories();

    for (const extensionsDir of extensionDirs) {
      let subdirs;
      try {
        subdirs = await fs.readdir(extensionsDir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const subdir of subdirs) {
        let isDir = subdir.isDirectory();
        if (!isDir && subdir.isSymbolicLink()) {
          try {
            const targetPath = path.join(extensionsDir, subdir.name);
            const stat = await fs.stat(targetPath);
            isDir = stat.isDirectory();
          } catch {
            continue;
          }
        }
        if (!isDir) continue;

        const extensionPath = path.join(extensionsDir, subdir.name);
        const manifestPath = path.join(extensionPath, 'manifest.json');

        try {
          const manifestContent = await fs.readFile(manifestPath, 'utf-8');
          const manifest = JSON.parse(manifestContent);
          const extensionId = manifest.id || subdir.name;

          // Skip if we've already seen this extension
          if (seenExtensionIds.has(extensionId)) {
            continue;
          }
          seenExtensionIds.add(extensionId);

          // Skip extensions that require a different release channel
          if (!isExtensionVisibleForChannel(manifest, currentChannel)) {
            continue;
          }

          // Check if extension is enabled
          if (!getExtensionEnabled(extensionId)) {
            continue;
          }

          // Check if extension has a Claude plugin
          const claudePlugin = manifest.contributions?.claudePlugin;
          if (!claudePlugin) {
            continue;
          }

          // Check if the plugin is enabled
          const storedPluginEnabled = getClaudePluginEnabled(extensionId);
          const pluginEnabled = storedPluginEnabled ?? claudePlugin.enabledByDefault ?? true;
          if (!pluginEnabled) {
            continue;
          }

          // Try to read the plugin.json to get the actual plugin name for namespacing
          let pluginNamespace = extensionId; // Default to extension ID
          const pluginJsonPath = path.join(extensionPath, claudePlugin.path, '.claude-plugin', 'plugin.json');
          try {
            const pluginJsonContent = await fs.readFile(pluginJsonPath, 'utf-8');
            const pluginJson = JSON.parse(pluginJsonContent);
            if (pluginJson.name) {
              pluginNamespace = pluginJson.name;
            }
          } catch {
            // plugin.json not found or invalid, use extension ID
          }

          // Add commands from the plugin
          if (claudePlugin.commands && Array.isArray(claudePlugin.commands)) {
            for (const cmd of claudePlugin.commands) {
              commands.push({
                extensionId,
                extensionName: manifest.name || extensionId,
                pluginName: claudePlugin.displayName || 'Claude Plugin',
                pluginNamespace, // The namespace used in slash commands (e.g., "datamodellm" for "/datamodellm:datamodel")
                commandName: cmd.name,
                description: cmd.description || '',
              });
            }
          }
        } catch {
          // Skip directories without valid manifest
        }
      }
    }

    return commands;
  } catch (error) {
    logger.main.error('[ExtensionHandlers] Failed to get Claude plugin commands:', error);
    return [];
  }
}

/**
 * Scan a single extension directory for Claude plugins.
 */
async function scanDirectoryForClaudePlugins(
  extensionsDir: string,
  plugins: Array<{ type: 'local'; path: string }>,
  seenExtensionIds: Set<string>,
  currentChannel: ReleaseChannel
): Promise<void> {
  let subdirs;
  try {
    subdirs = await fs.readdir(extensionsDir, { withFileTypes: true });
  } catch {
    // Directory doesn't exist or can't be read
    return;
  }

  for (const subdir of subdirs) {
    // Handle both directories and symlinks to directories
    let isDir = subdir.isDirectory();
    if (!isDir && subdir.isSymbolicLink()) {
      try {
        const targetPath = path.join(extensionsDir, subdir.name);
        const stat = await fs.stat(targetPath);
        isDir = stat.isDirectory();
      } catch {
        // Symlink target doesn't exist
        continue;
      }
    }
    if (!isDir) continue;

    const extensionPath = path.join(extensionsDir, subdir.name);
    const manifestPath = path.join(extensionPath, 'manifest.json');

    try {
      const manifestContent = await fs.readFile(manifestPath, 'utf-8');
      const manifest = JSON.parse(manifestContent);

      // Check if extension is enabled
      const extensionId = manifest.id || subdir.name;

      // Skip if we've already seen this extension (user extensions take priority)
      if (seenExtensionIds.has(extensionId)) {
        continue;
      }
      seenExtensionIds.add(extensionId);

      // Skip extensions that require a different release channel
      if (!isExtensionVisibleForChannel(manifest, currentChannel)) {
        logger.main.debug(`[ExtensionHandlers] Skipping extension ${extensionId} (requires ${manifest.requiredReleaseChannel} channel)`);
        continue;
      }

      const isEnabled = getExtensionEnabled(extensionId);
      if (!isEnabled) {
        logger.main.debug(`[ExtensionHandlers] Skipping disabled extension: ${extensionId}`);
        continue;
      }

      // Check if extension has a Claude plugin contribution
      const claudePlugin = manifest.contributions?.claudePlugin;
      if (!claudePlugin?.path) {
        continue;
      }

      // Check if the plugin is enabled
      // Priority: stored setting > manifest enabledByDefault > true
      const storedPluginEnabled = getClaudePluginEnabled(extensionId);
      const pluginEnabled = storedPluginEnabled ?? claudePlugin.enabledByDefault ?? true;
      if (!pluginEnabled) {
        logger.main.debug(`[ExtensionHandlers] Skipping disabled Claude plugin from: ${extensionId}`);
        continue;
      }

      // Resolve the absolute path to the plugin directory
      const pluginPath = path.resolve(extensionPath, claudePlugin.path);

      // Verify the plugin path exists
      try {
        await fs.access(pluginPath);
      } catch {
        logger.main.warn(`[ExtensionHandlers] Claude plugin path not found: ${pluginPath}`);
        continue;
      }

      // Validate plugin.json against the Claude Code SDK's expected schema.
      // The SDK silently drops plugins with invalid plugin.json, so we catch
      // common issues here and log warnings to help extension developers.
      const pluginJsonPath = path.join(pluginPath, '.claude-plugin', 'plugin.json');
      try {
        const pluginJsonContent = await fs.readFile(pluginJsonPath, 'utf-8');
        const pluginJson = JSON.parse(pluginJsonContent);
        const issues: string[] = [];

        if (!pluginJson.name || typeof pluginJson.name !== 'string') {
          issues.push('"name" must be a non-empty string');
        } else if (pluginJson.name.includes(' ')) {
          issues.push('"name" cannot contain spaces (use kebab-case)');
        }

        if (pluginJson.author !== undefined && typeof pluginJson.author === 'string') {
          issues.push('"author" must be an object { name: string }, not a string. The SDK will silently reject this plugin.');
        }

        if (issues.length > 0) {
          logger.main.warn(`[ExtensionHandlers] Claude plugin ${extensionId} has plugin.json issues that may cause the SDK to reject it: ${issues.join('; ')}`);
        }
      } catch {
        // plugin.json missing or unreadable -- SDK will handle this
      }

      plugins.push({
        type: 'local' as const,
        path: pluginPath,
      });
      // logger.main.info(`[ExtensionHandlers] Found Claude plugin: ${extensionId} at ${pluginPath}`);
    } catch {
      // Skip directories without valid manifest
    }
  }
}

/**
 * Structure of the Claude Code CLI installed plugins file (~/.claude/plugins/installed_plugins.json)
 */
interface ClaudeCliInstalledPlugins {
  version: number;
  plugins: Record<string, Array<{
    scope: 'user' | 'project';
    projectPath?: string;  // Only present for project-scoped plugins
    installPath: string;
    version: string;
    installedAt: string;
    lastUpdated: string;
  }>>;
}

/**
 * Get Claude CLI plugins installed via the /plugin command.
 * Reads from ~/.claude/plugins/installed_plugins.json
 *
 * @param workspacePath - If provided, includes project-scoped plugins for this workspace
 */
async function getClaudeCliPluginPaths(workspacePath?: string): Promise<Array<{ type: 'local'; path: string }>> {
  const plugins: Array<{ type: 'local'; path: string }> = [];

  try {
    const os = await import('os');
    const installedPluginsPath = path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json');

    let content: string;
    try {
      content = await fs.readFile(installedPluginsPath, 'utf-8');
    } catch {
      // File doesn't exist - no CLI plugins installed
      return [];
    }

    let installedPlugins: ClaudeCliInstalledPlugins;
    try {
      installedPlugins = JSON.parse(content);
    } catch (parseError) {
      logger.main.error(`[ExtensionHandlers] Failed to parse CLI plugins JSON at ${installedPluginsPath}:`, parseError);
      return [];
    }

    // Normalize workspace path for comparison if provided
    const normalizedWorkspacePath = workspacePath ? path.resolve(workspacePath) : undefined;

    for (const [pluginKey, installations] of Object.entries(installedPlugins.plugins)) {
      for (const installation of installations) {
        // Include user-scoped plugins always
        if (installation.scope === 'user') {
          try {
            await fs.access(installation.installPath);
            plugins.push({
              type: 'local' as const,
              path: installation.installPath,
            });
            logger.main.debug(`[ExtensionHandlers] Found CLI plugin (user): ${pluginKey} at ${installation.installPath}`);
          } catch {
            logger.main.warn(`[ExtensionHandlers] CLI plugin path not found: ${installation.installPath}`);
          }
        }
        // Include project-scoped plugins only if workspace matches
        else if (installation.scope === 'project' && normalizedWorkspacePath && installation.projectPath) {
          const normalizedProjectPath = path.resolve(installation.projectPath);
          if (normalizedWorkspacePath === normalizedProjectPath || normalizedWorkspacePath.startsWith(normalizedProjectPath + path.sep)) {
            try {
              await fs.access(installation.installPath);
              plugins.push({
                type: 'local' as const,
                path: installation.installPath,
              });
              logger.main.debug(`[ExtensionHandlers] Found CLI plugin (project): ${pluginKey} at ${installation.installPath}`);
            } catch {
              logger.main.warn(`[ExtensionHandlers] CLI plugin path not found: ${installation.installPath}`);
            }
          }
        }
      }
    }
  } catch (error) {
    logger.main.error('[ExtensionHandlers] Failed to read CLI plugins:', error);
  }

  return plugins;
}

/**
 * Get Claude Agent SDK plugin paths from enabled extensions and CLI-installed plugins.
 * This is a main-process-native implementation that directly reads extension manifests
 * without requiring the renderer-process ExtensionLoader.
 *
 * Scans:
 * 1. User extensions directory
 * 2. Built-in extensions directory
 * 3. Claude CLI plugins (~/.claude/plugins/)
 *
 * User extensions take priority over built-in extensions with the same ID.
 *
 * @param workspacePath - If provided, includes project-scoped CLI plugins for this workspace
 * @returns Paths in the format expected by the Claude Agent SDK: { type: 'local', path: string }
 */
export async function getNativeClaudePluginPaths(workspacePath?: string): Promise<Array<{ type: 'local'; path: string }>> {
  try {
    const plugins: Array<{ type: 'local'; path: string }> = [];
    const seenExtensionIds = new Set<string>();
    const currentChannel = getReleaseChannel();

    // Scan all extension directories (user first, then built-in)
    const extensionDirs = await getAllExtensionDirectories();
    for (const extensionsDir of extensionDirs) {
      await scanDirectoryForClaudePlugins(extensionsDir, plugins, seenExtensionIds, currentChannel);
    }

    // Also scan CLI-installed plugins
    const cliPlugins = await getClaudeCliPluginPaths(workspacePath);
    plugins.push(...cliPlugins);

    // Deduplicate by resolved path (in case same plugin is both an extension and CLI-installed)
    const seenPaths = new Set<string>();
    const deduplicatedPlugins: Array<{ type: 'local'; path: string }> = [];
    for (const plugin of plugins) {
      const resolvedPath = path.resolve(plugin.path);
      if (!seenPaths.has(resolvedPath)) {
        seenPaths.add(resolvedPath);
        deduplicatedPlugins.push(plugin);
      } else {
        logger.main.debug(`[ExtensionHandlers] Skipping duplicate plugin: ${plugin.path}`);
      }
    }

    return deduplicatedPlugins;
  } catch (error) {
    logger.main.error('[ExtensionHandlers] Failed to get Claude plugin paths:', error);
    return [];
  }
}

export async function getClaudePluginPaths(workspacePath?: string): Promise<Array<{ type: 'local'; path: string }>> {
  return getNativeClaudePluginPaths(workspacePath);
}

/**
 * Register each `aiAgentProviders` contribution from a parsed manifest into
 * the AgentProviderRegistry. Skips contributions whose `backendModuleId`
 * doesn't point at a surviving `backendModules` entry -- a contribution that
 * lost its backing module (because validation stripped it, or it was never
 * declared) is dead weight; hiding it from the dropdown is correct.
 *
 * Called from the list-installed scan AFTER validateAndScrubBackendModules
 * has run so `manifest.contributions.backendModules` reflects what actually
 * survived.
 */
function registerAgentProviderContributions(
  manifest: ExtensionManifest,
  extensionId: string,
  extensionPath: string
): void {
  const contributions = manifest.contributions as
    | { backendModules?: BackendModuleContribution[]; aiAgentProviders?: AiAgentProviderContribution[] }
    | undefined;
  const providers = contributions?.aiAgentProviders;
  if (!providers || providers.length === 0) return;

  const surviving = new Set<string>(
    (contributions?.backendModules ?? []).map((m) => m.id)
  );
  const registry = getAgentProviderRegistry();
  for (const provider of providers) {
    if (!surviving.has(provider.backendModuleId)) {
      logger.main.warn(
        `[ExtensionHandlers] Extension ${extensionId} aiAgentProviders[${provider.id}] ` +
          `references backendModuleId "${provider.backendModuleId}" which is not a surviving ` +
          `backend module. Hiding the provider from the dropdown.`
      );
      continue;
    }
    registry.register({
      extensionId,
      contributionId: provider.id,
      manifest,
      contribution: provider,
      backendModuleId: provider.backendModuleId,
      extensionPath,
    });
    logger.main.info(
      `[ExtensionHandlers] Registered agent provider: ${provider.id} (from ${extensionId})`
    );
    // Teach ModelIdentifier this provider id so provider-from-model derivation
    // (sessions:create, sessionHistoryActions, etc.) resolves it instead of
    // falling back to claude-code.
    ModelIdentifier.registerExtensionProvider(provider.id);
  }
}

/**
 * Register IPC handlers for extension operations.
 */
export function registerExtensionHandlers(): void {
  // Get the user extensions directory path (for installing new extensions)
  safeHandle('extensions:get-directory', async () => {
    try {
      return await getUserExtensionsDirectory();
    } catch (error) {
      logger.main.error('[ExtensionHandlers] Failed to get extensions directory:', error);
      throw error;
    }
  });

  // Get all extension directories (user + built-in)
  // Used by the renderer's ExtensionLoader to discover all extensions
  safeHandle('extensions:get-all-directories', async () => {
    try {
      return await getAllExtensionDirectories();
    } catch (error) {
      logger.main.error('[ExtensionHandlers] Failed to get all extensions directories:', error);
      throw error;
    }
  });

  // List subdirectories in a directory
  // Note: This also follows symlinks to directories
  safeHandle('extensions:list-directories', async (_event, dirPath: string) => {
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      const directories: string[] = [];

      for (const entry of entries) {
        // Check if it's a directory or a symlink to a directory
        if (entry.isDirectory()) {
          directories.push(entry.name);
        } else if (entry.isSymbolicLink()) {
          // For symlinks, check if the target is a directory
          try {
            const targetPath = path.join(dirPath, entry.name);
            const stat = await fs.stat(targetPath); // stat follows symlinks
            if (stat.isDirectory()) {
              directories.push(entry.name);
            }
          } catch {
            // Symlink target doesn't exist, skip
          }
        }
      }

      logger.main.debug('[ExtensionHandlers] Found directories:', directories);
      return directories;
    } catch (error) {
      logger.main.debug('[ExtensionHandlers] Failed to list directories:', error);
      return [];
    }
  });

  // Read a file as text
  safeHandle('extensions:read-file', async (_event, filePath: string) => {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return content;
    } catch (error) {
      logger.main.error(`[ExtensionHandlers] Failed to read file ${filePath}:`, error);
      throw error;
    }
  });

  // Write content to a file
  safeHandle('extensions:write-file', async (_event, filePath: string, content: string) => {
    try {
      SessionFileWatcher.markEditorSave(filePath);
      const dir = path.dirname(filePath);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(filePath, content, 'utf-8');
    } catch (error) {
      logger.main.error(`[ExtensionHandlers] Failed to write file ${filePath}:`, error);
      throw error;
    }
  });

  // Write binary content to a file (base64 encoded)
  safeHandle('extensions:write-binary', async (_event, filePath: string, base64Content: string) => {
    try {
      const dir = path.dirname(filePath);
      await fs.mkdir(dir, { recursive: true });
      const buffer = Buffer.from(base64Content, 'base64');
      await fs.writeFile(filePath, buffer);
    } catch (error) {
      logger.main.error(`[ExtensionHandlers] Failed to write binary file ${filePath}:`, error);
      throw error;
    }
  });

  // Check if a file exists
  safeHandle('extensions:file-exists', async (_event, filePath: string) => {
    try {
      await fs.access(filePath);
      return true;
    } catch (error) {
      // Log the error details to help debug intermittent file access issues
      logger.main.debug(`[ExtensionHandlers] File not found: ${filePath}`, error);
      return false;
    }
  });

  // Check if an extension should be visible based on its required release channel
  safeHandle('extensions:is-visible-for-channel', (_event, requiredChannel: string | undefined) => {
    const currentChannel = getReleaseChannel();
    return isExtensionVisibleForChannel({ requiredReleaseChannel: requiredChannel as ReleaseChannel | undefined }, currentChannel);
  });

  // Find files matching a glob pattern
  safeHandle(
    'extensions:find-files',
    async (_event, dirPath: string, pattern: string) => {
      const matches: string[] = [];
      const rootPath = path.resolve(dirPath);
      // buildExtensionFindFilesPlan extracts the literal directory prefix from the glob
      // pattern to narrow the scan root, but normalizedPattern retains those prefix segments.
      // This works because relativePath is computed from rootPath (not scanRoot), so the
      // full pattern still matches correctly against the full relative path.
      const { normalizedPattern, scanRoot } = buildExtensionFindFilesPlan(rootPath, pattern);

      if (scanRoot !== rootPath && !scanRoot.startsWith(rootPath + path.sep)) {
        logger.main.warn('[ExtensionHandlers] Refusing to scan outside workspace root:', {
          dirPath: rootPath,
          pattern,
          scanRoot,
        });
        return matches;
      }

      try {
        const stat = await fs.stat(scanRoot);
        if (!stat.isDirectory()) {
          return matches;
        }
      } catch {
        return matches;
      }

      async function scanDirectory(dir: string): Promise<void> {
        try {
          const entries = await fs.readdir(dir, { withFileTypes: true });
          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            const relativePath = path.relative(rootPath, fullPath).split(path.sep).join('/');

            if (entry.isDirectory()) {
              // Skip hidden directories and node_modules
              if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
                await scanDirectory(fullPath);
              }
            } else {
              // Check if file matches the pattern
              if (minimatch(relativePath, normalizedPattern) || minimatch(entry.name, normalizedPattern)) {
                matches.push(fullPath);
              }
            }
          }
        } catch (error) {
          // Ignore permission errors
        }
      }

      try {
        await scanDirectory(scanRoot);
        return matches;
      } catch (error) {
        logger.main.error('[ExtensionHandlers] Failed to find files:', error);
        return [];
      }
    }
  );

  // Resolve a path relative to an extension
  safeHandle(
    'extensions:resolve-path',
    (_event, extensionPath: string, relativePath: string) => {
      return path.resolve(extensionPath, relativePath);
    }
  );

  // Get list of installed extensions (for settings UI)
  // Scans both user extensions and built-in extensions directories.
  // User extensions take priority over built-in extensions with the same ID.
  // Extensions with requiredReleaseChannel are filtered based on user's release channel.
  safeHandle('extensions:list-installed', async () => {
    try {
      const extensions: Array<{
        id: string;
        path: string;
        manifest: unknown;
        isBuiltin: boolean;
      }> = [];
      const seenExtensionIds = new Set<string>();
      const currentChannel = getReleaseChannel();

      // Clear previously registered file types
      clearRegisteredExtensions();

      // Scan all extension directories (user first, then built-in)
      const extensionDirs = await getAllExtensionDirectories();

      for (let i = 0; i < extensionDirs.length; i++) {
        const extensionsDir = extensionDirs[i];
        const isBuiltinDir = i > 0; // First directory is user extensions

        let subdirs;
        try {
          subdirs = await fs.readdir(extensionsDir, { withFileTypes: true });
        } catch {
          continue;
        }

        for (const subdir of subdirs) {
          // Handle both directories and symlinks to directories
          let isDir = subdir.isDirectory();
          const isSymlink = subdir.isSymbolicLink();
          if (!isDir && isSymlink) {
            try {
              const targetPath = path.join(extensionsDir, subdir.name);
              const stat = await fs.stat(targetPath);
              isDir = stat.isDirectory();
            } catch {
              continue;
            }
          }
          if (!isDir) continue;

          const extensionPath = path.join(extensionsDir, subdir.name);
          const manifestPath = path.join(extensionPath, 'manifest.json');

          try {
            const manifestContent = await fs.readFile(manifestPath, 'utf-8');
            const manifest = JSON.parse(manifestContent);
            const extensionId = manifest.id || subdir.name;

            // Skip if we've already seen this extension (user extensions take priority)
            if (seenExtensionIds.has(extensionId)) {
              continue;
            }
            seenExtensionIds.add(extensionId);

            // Skip extensions that require a different release channel
            if (!isExtensionVisibleForChannel(manifest, currentChannel)) {
              logger.main.debug(`[ExtensionHandlers] Skipping extension ${extensionId} from list (requires ${manifest.requiredReleaseChannel} channel)`);
              continue;
            }

            // Shape-validate backend-module contributions. Malformed
            // declarations are stripped so the rest of the extension still
            // loads; native-code consent is the user's first-use prompt.
            validateAndScrubBackendModules(manifest, extensionId, {
              isBuiltin: isBuiltinDir,
              isSymlink,
            });

            // Catalog any `aiAgentProviders` whose backing backend module
            // survived. The registry entry is metadata only; the host won't
            // spawn the runtime until a session targeting this provider
            // triggers the first-use consent flow.
            registerAgentProviderContributions(
              manifest as ExtensionManifest,
              extensionId,
              extensionPath
            );

            // Register file patterns from customEditors
            if (manifest.contributions?.customEditors) {
              for (const editor of manifest.contributions.customEditors) {
                if (editor.filePatterns) {
                  for (const pattern of editor.filePatterns) {
                    // Extract extension from pattern like "*.pdf"
                    if (pattern.startsWith('*.')) {
                      const ext = pattern.substring(1); // Remove the *
                      registerFileExtension(ext);
                      logger.main.debug(`[ExtensionHandlers] Registered file type: ${ext} (from ${extensionId})`);
                    }
                  }
                }
              }
            }

            extensions.push({
              id: extensionId,
              path: extensionPath,
              manifest,
              isBuiltin: isBuiltinDir,
            });
          } catch {
            // Skip directories without valid manifest
          }
        }
      }

      return extensions;
    } catch (error) {
      logger.main.error('[ExtensionHandlers] Failed to list installed extensions:', error);
      return [];
    }
  });

  // List registered extension-contributed AI agent providers for the renderer
  // (Settings AGENT PROVIDERS panel). Returns provider metadata from the
  // AgentProviderRegistry; denied entries are hidden. The model picker gets
  // models via ai:getModels; this is the provider-level listing.
  safeHandle('agent-providers:list', async () => {
    try {
      const data = getAgentProviderRegistry()
        .list()
        .filter((entry) => entry.status !== 'denied')
        .map((entry) => ({
          id: entry.contributionId,
          extensionId: entry.extensionId,
          name: entry.contribution.displayName || entry.contributionId,
          icon: entry.contribution.icon,
          status: entry.status,
          models: (entry.contribution.models ?? []).map((m) => ({ id: m.id, name: m.name })),
        }));
      return { success: true, data };
    } catch (error) {
      logger.main.error('[ExtensionHandlers] Failed to list agent providers:', error);
      return { success: false, error: String(error), data: [] };
    }
  });

  // Get Claude plugin commands from all enabled extensions
  // Used to populate slash command suggestions in the UI
  safeHandle('extensions:get-claude-plugin-commands', async () => {
    return await getExtensionPluginCommands();
  });

  // Get all extension settings
  safeHandle('extensions:get-all-settings', async () => {
    try {
      return getExtensionSettings();
    } catch (error) {
      logger.main.error('[ExtensionHandlers] Failed to get extension settings:', error);
      return {};
    }
  });

  // Get enabled state for a specific extension
  // defaultEnabled comes from the extension's manifest and is used for first-time discovery
  safeHandle('extensions:get-enabled', async (_event, extensionId: string, defaultEnabled?: boolean) => {
    try {
      return getExtensionEnabled(extensionId, defaultEnabled);
    } catch (error) {
      logger.main.error(`[ExtensionHandlers] Failed to get enabled state for ${extensionId}:`, error);
      return defaultEnabled !== false; // Respect manifest default on error
    }
  });

  // Set enabled state for a specific extension
  safeHandle('extensions:set-enabled', async (_event, extensionId: string, enabled: boolean) => {
    try {
      setExtensionEnabled(extensionId, enabled);
      logger.main.info(`[ExtensionHandlers] Extension ${extensionId} ${enabled ? 'enabled' : 'disabled'}`);

      // Start/stop any backend modules the extension declares. Fire-and-forget so
      // the toggle returns promptly (startModule awaits utility-process readiness,
      // up to 15s); errors are logged, not surfaced to the toggle.
      const lifecycleDeps = getDefaultBackendModuleLifecycleDeps();
      if (enabled) {
        void startExtensionBackendModules(extensionId, lifecycleDeps).catch((err) =>
          logger.main.error(`[ExtensionHandlers] backend-module start failed for ${extensionId}:`, err)
        );
      } else {
        void stopExtensionBackendModules(extensionId, lifecycleDeps).catch((err) =>
          logger.main.error(`[ExtensionHandlers] backend-module stop failed for ${extensionId}:`, err)
        );
      }

      return { success: true };
    } catch (error) {
      logger.main.error(`[ExtensionHandlers] Failed to set enabled state for ${extensionId}:`, error);
      return { success: false, error: String(error) };
    }
  });

  // Set Claude plugin enabled state for a specific extension
  safeHandle('extensions:set-claude-plugin-enabled', async (_event, extensionId: string, enabled: boolean) => {
    try {
      setClaudePluginEnabled(extensionId, enabled);
      logger.main.info(`[ExtensionHandlers] Claude plugin for ${extensionId} ${enabled ? 'enabled' : 'disabled'}`);
      return { success: true };
    } catch (error) {
      logger.main.error(`[ExtensionHandlers] Failed to set Claude plugin state for ${extensionId}:`, error);
      return { success: false, error: String(error) };
    }
  });

  safeHandle('extensions:set-agent-workflows-enabled', async (_event, extensionId: string, enabled: boolean) => {
    try {
      setAgentWorkflowsEnabled(extensionId, enabled);
      logger.main.info(`[ExtensionHandlers] Agent workflows for ${extensionId} ${enabled ? 'enabled' : 'disabled'}`);
      return { success: true };
    } catch (error) {
      logger.main.error(`[ExtensionHandlers] Failed to set agent workflow state for ${extensionId}:`, error);
      return { success: false, error: String(error) };
    }
  });

  // Get configuration for a specific extension (scope-aware)
  // scope: 'user' for global config, 'workspace' for project-specific config
  safeHandle('extensions:get-config', async (_event, extensionId: string, scope?: 'user' | 'workspace', workspacePath?: string) => {
    try {
      if (scope === 'workspace' && workspacePath) {
        return getWorkspaceExtensionConfiguration(workspacePath, extensionId);
      }
      return getExtensionConfiguration(extensionId);
    } catch (error) {
      logger.main.error(`[ExtensionHandlers] Failed to get config for ${extensionId}:`, error);
      return {};
    }
  });

  // Set a single configuration value for an extension (scope-aware)
  safeHandle('extensions:set-config', async (_event, extensionId: string, key: string, value: unknown, scope?: 'user' | 'workspace', workspacePath?: string) => {
    try {
      if (scope === 'workspace' && workspacePath) {
        setWorkspaceExtensionConfiguration(workspacePath, extensionId, key, value);
      } else {
        setExtensionConfiguration(extensionId, key, value);
      }
      logger.main.info(`[ExtensionHandlers] Set config ${key} for ${extensionId} (scope: ${scope ?? 'user'})`);
      return { success: true };
    } catch (error) {
      logger.main.error(`[ExtensionHandlers] Failed to set config for ${extensionId}:`, error);
      return { success: false, error: String(error) };
    }
  });

  // Set all configuration values for an extension (scope-aware)
  safeHandle('extensions:set-config-bulk', async (_event, extensionId: string, configuration: Record<string, unknown>, scope?: 'user' | 'workspace', workspacePath?: string) => {
    try {
      if (scope === 'workspace' && workspacePath) {
        setWorkspaceExtensionConfigurationBulk(workspacePath, extensionId, configuration);
      } else {
        setExtensionConfigurationBulk(extensionId, configuration);
      }
      logger.main.info(`[ExtensionHandlers] Set bulk config for ${extensionId} (scope: ${scope ?? 'user'})`);
      return { success: true };
    } catch (error) {
      logger.main.error(`[ExtensionHandlers] Failed to set bulk config for ${extensionId}:`, error);
      return { success: false, error: String(error) };
    }
  });

  // ============================================================================
  // Extension Development Kit (EDK) - Hot-loading handlers
  // ============================================================================

  // Install an extension from a specific path (for development)
  // This creates a symlink in the user extensions directory pointing to the dev extension
  safeHandle('extensions:dev-install', async (_event, extensionPath: string) => {
    try {
      const normalizedPath = path.resolve(extensionPath);
      const manifestPath = path.join(normalizedPath, 'manifest.json');

      // Verify manifest exists
      try {
        await fs.access(manifestPath);
      } catch {
        return { success: false, error: `No manifest.json found at ${normalizedPath}` };
      }

      // Read manifest to get extension ID
      const manifestContent = await fs.readFile(manifestPath, 'utf-8');
      const manifest = JSON.parse(manifestContent);
      const extensionId = manifest.id;

      if (!extensionId) {
        return { success: false, error: 'manifest.json missing required "id" field' };
      }

      // Create symlink in user extensions directory
      const userExtDir = await getUserExtensionsDirectory();
      const symlinkPath = path.join(userExtDir, path.basename(normalizedPath));

      // Remove existing symlink if present
      try {
        const stat = await fs.lstat(symlinkPath);
        if (stat.isSymbolicLink() || stat.isDirectory()) {
          await fs.rm(symlinkPath, { recursive: true, force: true });
        }
      } catch {
        // Doesn't exist, that's fine
      }

      // Create symlink
      await fs.symlink(normalizedPath, symlinkPath, 'junction');
      logger.main.info(`[ExtensionHandlers] Created dev extension symlink: ${symlinkPath} -> ${normalizedPath}`);

      return { success: true, extensionId, symlinkPath };
    } catch (error) {
      logger.main.error('[ExtensionHandlers] Failed to install dev extension:', error);
      return { success: false, error: String(error) };
    }
  });

  // Uninstall a dev extension (remove symlink and notify renderers)
  safeHandle('extensions:dev-uninstall', async (_event, extensionId: string) => {
    try {
      const userExtDir = await getUserExtensionsDirectory();

      // Find the extension directory (could be a symlink)
      const entries = await fs.readdir(userExtDir, { withFileTypes: true });

      for (const entry of entries) {
        const entryPath = path.join(userExtDir, entry.name);

        // Check if this entry matches the extension ID
        const manifestPath = path.join(entryPath, 'manifest.json');
        try {
          const manifestContent = await fs.readFile(manifestPath, 'utf-8');
          const manifest = JSON.parse(manifestContent);

          if (manifest.id === extensionId) {
            // Found it - remove the symlink/directory
            await fs.rm(entryPath, { recursive: true, force: true });
            // Evict any aiAgentProviders the extension had registered so
            // the dropdown stops listing them. The PrivilegedExtensionHost
            // handles its own teardown via handleExtensionUninstalled.
            getAgentProviderRegistry().clearAll(extensionId);
            logger.main.info(`[ExtensionHandlers] Removed dev extension: ${extensionId} at ${entryPath}`);
            return { success: true };
          }
        } catch {
          // Not a valid extension directory, skip
        }
      }

      return { success: false, error: `Extension ${extensionId} not found in user extensions` };
    } catch (error) {
      logger.main.error('[ExtensionHandlers] Failed to uninstall dev extension:', error);
      return { success: false, error: String(error) };
    }
  });

  // Notify all renderer processes to reload an extension
  // The renderers will unload the old version and load the new one
  safeHandle('extensions:dev-reload', async (_event, extensionId: string, extensionPath: string) => {
    try {
      const { BrowserWindow } = await import('electron');
      const windows = BrowserWindow.getAllWindows();

      logger.main.info(`[ExtensionHandlers] Broadcasting extension reload: ${extensionId} from ${extensionPath}`);

      // Broadcast reload message to all renderer windows
      for (const win of windows) {
        if (!win.isDestroyed()) {
          win.webContents.send('extension:dev-reload', { extensionId, extensionPath });
        }
      }

      return { success: true };
    } catch (error) {
      logger.main.error('[ExtensionHandlers] Failed to broadcast extension reload:', error);
      return { success: false, error: String(error) };
    }
  });

  // Notify all renderer processes to unload an extension
  safeHandle('extensions:dev-unload', async (_event, extensionId: string) => {
    try {
      const { BrowserWindow } = await import('electron');
      const windows = BrowserWindow.getAllWindows();

      logger.main.info(`[ExtensionHandlers] Broadcasting extension unload: ${extensionId}`);

      // Broadcast unload message to all renderer windows
      for (const win of windows) {
        if (!win.isDestroyed()) {
          win.webContents.send('extension:dev-unload', { extensionId });
        }
      }

      return { success: true };
    } catch (error) {
      logger.main.error('[ExtensionHandlers] Failed to broadcast extension unload:', error);
      return { success: false, error: String(error) };
    }
  });

  // Execute a shell command on behalf of an extension (requires filesystem permission)
  safeHandle('extension:exec', async (_event, params: {
    extensionId: string;
    command: string;
    cwd: string;
    timeout?: number;
    env?: Record<string, string>;
    maxBuffer?: number;
  }) => {
    const { extensionId, command, cwd, timeout = 60000, env, maxBuffer = 10 * 1024 * 1024 } = params;

    const manifest = await readExtensionManifest(extensionId);
    const hasFilesystemPermission = !!manifest?.permissions?.filesystem;

    if (!hasFilesystemPermission) {
      return { success: false, stdout: '', stderr: `Extension ${extensionId} not found or lacks filesystem permission`, exitCode: -1 };
    }

    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd,
        timeout,
        maxBuffer,
        env: env ? { ...process.env, ...env } : process.env,
      });
      return { success: true, stdout, stderr, exitCode: 0 };
    } catch (execError: unknown) {
      const err = execError as { stdout?: string; stderr?: string; code?: number; message?: string };
      return {
        success: false,
        stdout: err.stdout || '',
        stderr: err.stderr || err.message || '',
        exitCode: err.code || 1,
      };
    }
  });

  // ============================================================================
  // Extension File Storage (sandboxed file system for extensions)
  // ============================================================================

  // Get the base path for an extension's data directory
  safeHandle('extension:file-storage:get-base-path', async (_event, params: {
    extensionId: string;
    workspacePath: string;
    scope: 'workspace' | 'global';
  }) => {
    const basePath = await getExtensionDataPath(params.extensionId, params.workspacePath, params.scope);
    await fs.mkdir(basePath, { recursive: true });
    return basePath;
  });

  // Write a file (string or base64-encoded binary)
  safeHandle('extension:file-storage:write', async (_event, params: {
    extensionId: string;
    workspacePath: string;
    relativePath: string;
    data: string;
    encoding: 'utf-8' | 'base64';
  }) => {
    const basePath = await getExtensionDataPath(params.extensionId, params.workspacePath, 'workspace');
    const fullPath = resolveSandboxedPath(basePath, params.relativePath);

    // Check quota (default 500MB per extension)
    const usage = await getDirectorySize(path.join(getExtensionDataRoot(), params.extensionId));
    const limitBytes = 500 * 1024 * 1024;
    if (usage > limitBytes) {
      throw new Error(`Extension ${params.extensionId} has exceeded its storage quota (${Math.round(usage / 1024 / 1024)}MB / ${Math.round(limitBytes / 1024 / 1024)}MB)`);
    }

    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    if (params.encoding === 'base64') {
      await fs.writeFile(fullPath, Buffer.from(params.data, 'base64'));
    } else {
      await fs.writeFile(fullPath, params.data, 'utf-8');
    }
  });

  // Read a file as text
  safeHandle('extension:file-storage:read-text', async (_event, params: {
    extensionId: string;
    workspacePath: string;
    relativePath: string;
  }) => {
    const basePath = await getExtensionDataPath(params.extensionId, params.workspacePath, 'workspace');
    const fullPath = resolveSandboxedPath(basePath, params.relativePath);
    return await fs.readFile(fullPath, 'utf-8');
  });

  // Read a file as base64
  safeHandle('extension:file-storage:read', async (_event, params: {
    extensionId: string;
    workspacePath: string;
    relativePath: string;
  }) => {
    const basePath = await getExtensionDataPath(params.extensionId, params.workspacePath, 'workspace');
    const fullPath = resolveSandboxedPath(basePath, params.relativePath);
    const buffer = await fs.readFile(fullPath);
    return buffer.toString('base64');
  });

  // Check if a file exists
  safeHandle('extension:file-storage:exists', async (_event, params: {
    extensionId: string;
    workspacePath: string;
    relativePath: string;
  }) => {
    const basePath = await getExtensionDataPath(params.extensionId, params.workspacePath, 'workspace');
    const fullPath = resolveSandboxedPath(basePath, params.relativePath);
    try {
      await fs.access(fullPath);
      return true;
    } catch {
      return false;
    }
  });

  // Delete a file or directory
  safeHandle('extension:file-storage:delete', async (_event, params: {
    extensionId: string;
    workspacePath: string;
    relativePath: string;
  }) => {
    const basePath = await getExtensionDataPath(params.extensionId, params.workspacePath, 'workspace');
    const fullPath = resolveSandboxedPath(basePath, params.relativePath);
    await fs.rm(fullPath, { recursive: true, force: true });
  });

  // List files in a directory
  safeHandle('extension:file-storage:list', async (_event, params: {
    extensionId: string;
    workspacePath: string;
    relativePath?: string;
  }) => {
    const basePath = await getExtensionDataPath(params.extensionId, params.workspacePath, 'workspace');
    const fullPath = params.relativePath ? resolveSandboxedPath(basePath, params.relativePath) : basePath;
    await fs.mkdir(fullPath, { recursive: true });
    const entries = await fs.readdir(fullPath);
    return entries;
  });

  // Get storage usage
  safeHandle('extension:file-storage:usage', async (_event, params: {
    extensionId: string;
  }) => {
    const extRoot = path.join(getExtensionDataRoot(), params.extensionId);
    const usedBytes = await getDirectorySize(extRoot);
    const limitBytes = 500 * 1024 * 1024; // 500MB default
    return { usedBytes, limitBytes };
  });

  // ============================================================================
  // Extension Database Access (read-only PGLite query)
  // ============================================================================

  // Run a read-only SQL query against PGLite on behalf of an extension. The
  // query is wrapped in BEGIN; SET TRANSACTION READ ONLY; SET LOCAL
  // statement_timeout; <sql>; COMMIT -- DML/DDL is rejected by the planner.
  // Requires the extension to declare 'nimbalyst-database-read' in
  // manifest.permissions.catalog. Errors surface PG's native message so
  // extension authors can debug their SQL.
  safeHandle('extension:database:query', async (_event, params: {
    extensionId: string;
    sql: string;
    params?: unknown[];
  }) => {
    if (!params || typeof params.extensionId !== 'string' || params.extensionId.length === 0) {
      throw new Error('extension:database:query requires extensionId');
    }
    if (typeof params.sql !== 'string' || params.sql.length === 0) {
      throw new Error('extension:database:query requires non-empty sql');
    }

    const granted = await extensionHasCatalogPermission(
      params.extensionId,
      'nimbalyst-database-read'
    );
    if (!granted) {
      throw new Error(
        `Extension ${params.extensionId} is not authorized for database access. ` +
        `Declare "nimbalyst-database-read" in manifest.permissions.catalog.`
      );
    }

    const queryParams = Array.isArray(params.params) ? params.params : undefined;
    const result = await database.queryReadOnly(params.sql, queryParams as any[] | undefined);
    return { rows: result.rows };
  });

  logger.main.info('[ExtensionHandlers] Extension handlers registered');
}

/**
 * Shape of the bits of an extension manifest we read for permission gating.
 * `permissions.filesystem` / `network` / `ai` are the legacy boolean object;
 * `permissions.catalog` is the catalog ids the renderer-side surface uses.
 */
interface ManifestForGating {
  id?: string;
  permissions?: {
    filesystem?: boolean;
    ai?: boolean;
    network?: boolean;
    catalog?: string[];
  };
}

/**
 * Read the manifest for a given extension id by scanning user and built-in
 * extension directories (in that order). Returns the parsed manifest or null
 * if no matching extension is found. Used by permission-gated IPC handlers
 * to verify the caller declared the capability they're asking for.
 */
async function readExtensionManifest(
  extensionId: string
): Promise<ManifestForGating | null> {
  const extensionDirs = await getAllExtensionDirectories();
  for (const extDir of extensionDirs) {
    let subdirs;
    try {
      subdirs = await fs.readdir(extDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const subdir of subdirs) {
      let isDir = subdir.isDirectory();
      if (!isDir && subdir.isSymbolicLink()) {
        try {
          const stat = await fs.stat(path.join(extDir, subdir.name));
          isDir = stat.isDirectory();
        } catch { continue; }
      }
      if (!isDir) continue;
      const manifestPath = path.join(extDir, subdir.name, 'manifest.json');
      try {
        const manifestJson = await fs.readFile(manifestPath, 'utf-8');
        const manifest = JSON.parse(manifestJson) as ManifestForGating;
        if (manifest.id === extensionId) {
          return manifest;
        }
      } catch { continue; }
    }
  }
  return null;
}

/**
 * Check whether `extensionId` declares the given catalog permission in
 * `manifest.permissions.catalog`. Currently the manifest declaration IS the
 * gate for renderer-side catalog permissions -- there's no separate consent
 * prompt for panel extensions, since the user already had to install and
 * enable the extension. Backend-module permissions go through the consent
 * flow in PrivilegedExtensionHost.
 */
async function extensionHasCatalogPermission(
  extensionId: string,
  permissionId: string
): Promise<boolean> {
  const manifest = await readExtensionManifest(extensionId);
  const catalog = manifest?.permissions?.catalog;
  return Array.isArray(catalog) && catalog.includes(permissionId);
}

// ============================================================================
// Extension File Storage helpers
// ============================================================================

/** Get root directory for all extension data */
function getExtensionDataRoot(): string {
  return path.join(app.getPath('userData'), 'extension-data');
}

/** Compute the data directory path for an extension */
async function getExtensionDataPath(
  extensionId: string,
  workspacePath: string,
  scope: 'workspace' | 'global'
): Promise<string> {
  const root = getExtensionDataRoot();

  if (scope === 'global') {
    return path.join(root, extensionId, 'global');
  }

  // Hash the workspace path for a stable, filesystem-safe directory name
  const crypto = await import('crypto');
  const hash = crypto.createHash('sha256').update(workspacePath).digest('hex').substring(0, 16);
  return path.join(root, extensionId, 'workspaces', hash);
}

/**
 * Resolve a relative path within a sandbox directory.
 * Throws if the resolved path escapes the sandbox.
 */
function resolveSandboxedPath(basePath: string, relativePath: string): string {
  // Normalize and resolve
  const resolved = path.resolve(basePath, relativePath);
  const normalizedBase = path.resolve(basePath);

  // Ensure the resolved path is within the base directory
  if (!resolved.startsWith(normalizedBase + path.sep) && resolved !== normalizedBase) {
    throw new Error(`Path traversal blocked: ${relativePath} resolves outside sandbox`);
  }

  return resolved;
}

/** Calculate total size of a directory recursively */
async function getDirectorySize(dirPath: string): Promise<number> {
  let totalSize = 0;
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        totalSize += await getDirectorySize(entryPath);
      } else {
        const stat = await fs.stat(entryPath);
        totalSize += stat.size;
      }
    }
  } catch {
    // Directory doesn't exist yet
  }
  return totalSize;
}
