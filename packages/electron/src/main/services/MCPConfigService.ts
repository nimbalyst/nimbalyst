import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { watch, FSWatcher } from 'fs';
import { MCPConfig, MCPServerConfig, MCPServerEnv } from '@nimbalyst/runtime/types/MCPServerConfig';
import { logger } from '../utils/logger';
import { getEnhancedPath } from './CLIManager';
import {
  buildMcpRemoteArgs,
  checkMcpRemoteAuthStatus,
  discoverMcpRemoteOAuthRequirement,
  extractMcpRemoteConfig,
  usesNativeRemoteOAuth,
} from './MCPRemoteOAuth';

/**
 * Service for managing MCP server configurations.
 *
 * Supports two scopes:
 * - User scope: Global MCP servers stored in ~/.claude.json (Claude Code CLI standard)
 * - Workspace scope: Project-specific MCP servers in .mcp.json
 *
 * This service reads/writes Claude Code's native config files for full compatibility.
 *
 * Migration: Automatically migrates from legacy ~/.config/claude/mcp.json to ~/.claude.json
 */
export interface TestProgressCallback {
  (status: 'downloading' | 'connecting' | 'testing' | 'done', message: string): void;
}

/**
 * Structure of ~/.claude.json file (contains both user settings and MCP servers)
 */
interface ClaudeConfig {
  mcpServers?: Record<string, MCPServerConfig>;
  [key: string]: any; // Other Claude Code settings
}

/**
 * Get helpful error message and install URL for command not found errors.
 * Exported for use by other modules (e.g., OAuth handlers).
 */
export function getCommandNotFoundHelp(command: string): { message: string; helpUrl?: string } {
  // Map commands to their install instructions
  const commandHelp: Record<string, { message: string; helpUrl: string }> = {
    npx: {
      message: `Command 'npx' not found. Node.js needs to be installed to use this MCP server.`,
      helpUrl: 'https://nodejs.org/en/download'
    },
    node: {
      message: `Command 'node' not found. Node.js needs to be installed to use this MCP server.`,
      helpUrl: 'https://nodejs.org/en/download'
    },
    npm: {
      message: `Command 'npm' not found. Node.js needs to be installed to use this MCP server.`,
      helpUrl: 'https://nodejs.org/en/download'
    },
    uvx: {
      message: `Command 'uvx' not found. Please install uv to use this MCP server.`,
      helpUrl: 'https://docs.astral.sh/uv/getting-started/installation/'
    },
    uv: {
      message: `Command 'uv' not found. Please install uv to use this MCP server.`,
      helpUrl: 'https://docs.astral.sh/uv/getting-started/installation/'
    },
    python: {
      message: `Command 'python' not found. Python needs to be installed to use this MCP server.`,
      helpUrl: 'https://www.python.org/downloads/'
    },
    python3: {
      message: `Command 'python3' not found. Python needs to be installed to use this MCP server.`,
      helpUrl: 'https://www.python.org/downloads/'
    },
    docker: {
      message: `Command 'docker' not found. Docker Desktop needs to be installed to use this MCP server.`,
      helpUrl: 'https://www.docker.com/products/docker-desktop/'
    },
    bunx: {
      message: `Command 'bunx' not found. Bun needs to be installed to use this MCP server.`,
      helpUrl: 'https://bun.sh/docs/installation'
    },
    bun: {
      message: `Command 'bun' not found. Bun needs to be installed to use this MCP server.`,
      helpUrl: 'https://bun.sh/docs/installation'
    },
    deno: {
      message: `Command 'deno' not found. Deno needs to be installed to use this MCP server.`,
      helpUrl: 'https://docs.deno.com/runtime/getting_started/installation/'
    },
    pipx: {
      message: `Command 'pipx' not found. pipx needs to be installed to use this MCP server.`,
      helpUrl: 'https://pipx.pypa.io/stable/installation/'
    }
  };

  // Strip Windows .cmd/.exe suffixes for lookup (e.g., npx.cmd -> npx, node.exe -> node)
  const normalizedCommand = command.replace(/\.(cmd|exe)$/i, '');

  const help = commandHelp[normalizedCommand];
  if (help) {
    return help;
  }

  // Default message for unknown commands
  return {
    message: `Command '${command}' not found. Please ensure it is installed and available in your PATH.`
  };
}

export class MCPConfigService {
  private userConfigPath: string;
  private legacyConfigPath: string;
  private userConfigWatcher: FSWatcher | null = null;
  private workspaceWatchers = new Map<string, FSWatcher>();
  private workspaceDirWatchers = new Map<string, FSWatcher>(); // For detecting new .mcp.json files
  private changeCallbacks: Array<(scope: 'user' | 'workspace', workspacePath?: string) => void> = [];
  private debounceTimers = new Map<string, NodeJS.Timeout>();

  // Track recent writes to suppress file watcher events for our own changes
  // Maps file path to timestamp of last write by this service
  private recentWrites = new Map<string, number>();
  private WRITE_SUPPRESSION_MS = 2000; // Suppress events for 2s after our own writes

  private CONNECTION_TIMEOUT_MS = 30000; // Base timeout
  private DOWNLOAD_TIMEOUT_MS = 120000; // Extended timeout when downloading packages
  private DEBOUNCE_MS = 500; // Debounce file watcher events

  constructor() {
    // Primary location: ~/.claude.json (used by Claude Code CLI)
    this.userConfigPath = path.join(os.homedir(), '.claude.json');

    // Legacy location: ~/.config/claude/mcp.json (Linux/macOS) or %APPDATA%/claude/mcp.json (Windows)
    const legacyConfigDir = process.platform === 'win32'
      ? path.join(process.env.APPDATA || os.homedir(), 'claude')
      : path.join(os.homedir(), '.config', 'claude');
    this.legacyConfigPath = path.join(legacyConfigDir, 'mcp.json');
  }

  /**
   * Read user-scope MCP configuration (global servers).
   * Reads from ~/.claude.json and migrates from legacy ~/.config/claude/mcp.json if needed.
   */
  async readUserMCPConfig(): Promise<MCPConfig> {
    try {
      // Try to read from primary location (~/.claude.json)
      const content = await fs.readFile(this.userConfigPath, 'utf8');
      const claudeConfig = JSON.parse(content) as ClaudeConfig;

      // Check if we need to migrate from legacy location.
      // IMPORTANT: Only migrate if mcpServers key doesn't exist at all.
      // An empty {} is a valid user state (all servers deleted) and should NOT trigger migration.
      if (claudeConfig.mcpServers === undefined) {
        const migratedConfig = await this.migrateLegacyConfig();
        if (migratedConfig && Object.keys(migratedConfig.mcpServers).length > 0) {
          return migratedConfig;
        }
      }

      return { mcpServers: this.normalizeServers(claudeConfig.mcpServers || {}) };
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        // Primary file doesn't exist - try to migrate from legacy
        const migratedConfig = await this.migrateLegacyConfig();
        if (migratedConfig) {
          return migratedConfig;
        }

        // No config exists anywhere - return empty config
        return { mcpServers: {} };
      }
      logger.mcp.error('Failed to read user MCP config:', error);
      throw error;
    }
  }

  /**
   * Migrate MCP servers from legacy ~/.config/claude/mcp.json to ~/.claude.json
   * Returns the migrated config if successful, null if no legacy config exists.
   *
   * NOTE: The legacy location was Nimbalyst-only (never used by Claude Code CLI).
   * After successful migration, we delete the legacy file to prevent it from
   * interfering with future reads (e.g., when user deletes all servers).
   */
  private async migrateLegacyConfig(): Promise<MCPConfig | null> {
    try {
      // Check if legacy config exists
      const legacyContent = await fs.readFile(this.legacyConfigPath, 'utf8');
      const legacyConfig = JSON.parse(legacyContent) as MCPConfig;

      if (!legacyConfig.mcpServers || Object.keys(legacyConfig.mcpServers).length === 0) {
        // Legacy file exists but has no servers - delete it to clean up
        await this.deleteLegacyConfig();
        return null;
      }

      logger.mcp.info('Migrating MCP servers from legacy location to ~/.claude.json');
      logger.mcp.info(`Found ${Object.keys(legacyConfig.mcpServers).length} servers to migrate`);

      // Read existing ~/.claude.json or create new one
      let claudeConfig: ClaudeConfig = {};
      try {
        const content = await fs.readFile(this.userConfigPath, 'utf8');
        claudeConfig = JSON.parse(content);
      } catch (error: any) {
        if (error.code !== 'ENOENT') {
          throw error;
        }
        // File doesn't exist, will create new one
      }

      // Merge legacy servers into ~/.claude.json
      claudeConfig.mcpServers = {
        ...(claudeConfig.mcpServers || {}),
        ...legacyConfig.mcpServers
      };

      // Write merged config
      await fs.writeFile(this.userConfigPath, JSON.stringify(claudeConfig, null, 2), 'utf8');

      // Delete the legacy file now that migration is complete
      await this.deleteLegacyConfig();

      logger.mcp.info('Migration completed successfully');

      return { mcpServers: claudeConfig.mcpServers };
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        // Legacy config doesn't exist - this is fine
        return null;
      }
      logger.mcp.error('Error during legacy config migration:', error);
      // Don't throw - just return null and continue with empty config
      return null;
    }
  }

  /**
   * Delete the legacy config file after successful migration.
   */
  private async deleteLegacyConfig(): Promise<void> {
    try {
      await fs.unlink(this.legacyConfigPath);
      logger.mcp.info('Deleted legacy config file:', this.legacyConfigPath);

      // Also try to remove the parent directory if it's empty
      const legacyDir = path.dirname(this.legacyConfigPath);
      try {
        await fs.rmdir(legacyDir);
        logger.mcp.info('Removed empty legacy config directory:', legacyDir);
      } catch {
        // Directory not empty or can't be removed - that's fine
      }
    } catch (error: any) {
      if (error.code !== 'ENOENT') {
        logger.mcp.warn('Failed to delete legacy config file:', error);
      }
    }
  }

  /**
   * Write user-scope MCP configuration.
   * Writes to ~/.claude.json (merging with existing Claude Code settings).
   */
  async writeUserMCPConfig(config: MCPConfig): Promise<void> {
    try {
      // Normalize server entries so every server has an explicit `type` field.
      // Claude Code 2.1.x rejects HTTP/SSE entries without `type` as an explicit discriminator.
      config = { mcpServers: this.normalizeServers(config.mcpServers || {}) };

      // Validate config before writing
      this.validateConfig(config);

      // Read existing ~/.claude.json to preserve other settings
      let claudeConfig: ClaudeConfig = {};
      try {
        const content = await fs.readFile(this.userConfigPath, 'utf8');
        claudeConfig = JSON.parse(content);
      } catch (error: any) {
        if (error.code !== 'ENOENT') {
          throw error;
        }
        // File doesn't exist, will create new one
      }

      // Update mcpServers while preserving other settings
      claudeConfig.mcpServers = config.mcpServers;

      // Write merged config
      const content = JSON.stringify(claudeConfig, null, 2);
      // Mark this write so we suppress the file watcher event for our own change
      this.markRecentWrite(this.userConfigPath);
      await fs.writeFile(this.userConfigPath, content, 'utf8');

      logger.mcp.info('User MCP config saved to ~/.claude.json');
    } catch (error) {
      logger.mcp.error('Failed to write user MCP config:', error);
      throw error;
    }
  }

  /**
   * Read workspace-scope MCP configuration (.mcp.json in project root).
   */
  async readWorkspaceMCPConfig(workspacePath: string): Promise<MCPConfig> {
    if (!workspacePath) {
      throw new Error('workspacePath is required');
    }

    // Try reading from two locations and merge them:
    // 1. ~/.claude.json projects section (Claude CLI standard)
    // 2. .mcp.json in workspace root (legacy/alternative location)

    let claudeJsonServers: Record<string, MCPServerConfig> = {};
    let mcpJsonServers: Record<string, MCPServerConfig> = {};

    // 1. Read from ~/.claude.json projects section
    try {
      const content = await fs.readFile(this.userConfigPath, 'utf8');
      const claudeConfig = JSON.parse(content) as ClaudeConfig & {
        projects?: Record<string, { mcpServers?: Record<string, MCPServerConfig> }>;
      };

      if (claudeConfig.projects && claudeConfig.projects[workspacePath]) {
        claudeJsonServers = claudeConfig.projects[workspacePath].mcpServers || {};
      }
    } catch (error: any) {
      if (error.code !== 'ENOENT') {
        logger.mcp.warn('Failed to read workspace config from ~/.claude.json:', error);
      }
    }

    // 2. Read from .mcp.json in workspace root
    const mcpJsonPath = path.join(workspacePath, '.mcp.json');
    try {
      const content = await fs.readFile(mcpJsonPath, 'utf8');
      const config = JSON.parse(content) as MCPConfig;
      mcpJsonServers = config.mcpServers || {};
    } catch (error: any) {
      if (error.code !== 'ENOENT') {
        logger.mcp.warn('Failed to read .mcp.json:', error);
      }
    }

    // Merge both sources: .mcp.json overrides ~/.claude.json projects
    return {
      mcpServers: this.normalizeServers({
        ...claudeJsonServers,
        ...mcpJsonServers
      })
    };
  }

  /**
   * Write workspace-scope MCP configuration (.mcp.json in project root).
   * Also updates ~/.claude.json projects section to keep both locations in sync.
   */
  async writeWorkspaceMCPConfig(workspacePath: string, config: MCPConfig): Promise<void> {
    if (!workspacePath) {
      throw new Error('workspacePath is required');
    }

    // Normalize server entries so every server has an explicit `type` field.
    // Claude Code 2.1.x rejects HTTP/SSE entries without `type` as an explicit discriminator.
    config = { mcpServers: this.normalizeServers(config.mcpServers || {}) };

    // Validate config before writing
    this.validateConfig(config);

    const mcpJsonPath = path.join(workspacePath, '.mcp.json');

    try {
      // 1. Write to .mcp.json in workspace root
      const content = JSON.stringify(config, null, 2);
      // Mark this write so we suppress the file watcher event for our own change
      this.markRecentWrite(mcpJsonPath);
      await fs.writeFile(mcpJsonPath, content, 'utf8');
      logger.mcp.info('Workspace MCP config saved:', mcpJsonPath);

      // 2. Also update ~/.claude.json projects section to keep in sync
      // This ensures deletes/updates work correctly since readWorkspaceMCPConfig merges both
      try {
        let claudeConfig: ClaudeConfig & {
          projects?: Record<string, { mcpServers?: Record<string, MCPServerConfig>; [key: string]: any }>;
        } = {};

        try {
          const existingContent = await fs.readFile(this.userConfigPath, 'utf8');
          claudeConfig = JSON.parse(existingContent);
        } catch (error: any) {
          if (error.code !== 'ENOENT') {
            throw error;
          }
          // File doesn't exist, will create new one
        }

        // Initialize projects section if it doesn't exist
        if (!claudeConfig.projects) {
          claudeConfig.projects = {};
        }

        // Initialize this project's entry if it doesn't exist
        if (!claudeConfig.projects[workspacePath]) {
          claudeConfig.projects[workspacePath] = {};
        }

        // Update the mcpServers for this project
        claudeConfig.projects[workspacePath].mcpServers = config.mcpServers;

        // Write back to ~/.claude.json
        const claudeContent = JSON.stringify(claudeConfig, null, 2);
        // Mark this write so we suppress the file watcher event for our own change
        this.markRecentWrite(this.userConfigPath);
        await fs.writeFile(this.userConfigPath, claudeContent, 'utf8');
        logger.mcp.info('Updated workspace MCP config in ~/.claude.json projects section');
      } catch (error) {
        // Log but don't fail the whole operation if ~/.claude.json update fails
        logger.mcp.warn('Failed to update ~/.claude.json projects section:', error);
      }
    } catch (error) {
      logger.mcp.error('Failed to write workspace MCP config:', error);
      throw error;
    }
  }

  /**
   * Get merged MCP configuration (User + Workspace).
   * Workspace servers override User servers with the same name.
   */
  async getMergedConfig(workspacePath?: string): Promise<MCPConfig> {
    const userConfig = await this.readUserMCPConfig();

    if (!workspacePath) {
      return userConfig;
    }

    const workspaceConfig = await this.readWorkspaceMCPConfig(workspacePath);

    // Merge: workspace overrides user
    return {
      mcpServers: {
        ...userConfig.mcpServers,
        ...workspaceConfig.mcpServers
      }
    };
  }

  /**
   * Start watching the user-level MCP config file for changes.
   * Call this once during app initialization.
   */
  startWatchingUserConfig(): void {
    if (this.userConfigWatcher) {
      logger.mcp.warn('User config watcher already started');
      return;
    }

    try {
      this.userConfigWatcher = watch(this.userConfigPath, (eventType) => {
        if (eventType === 'change') {
          this.debouncedNotify('user-config', () => {
            // Check if this change was caused by our own write
            if (this.shouldSuppressChangeEvent(this.userConfigPath)) {
              return;
            }

            logger.mcp.info('[MCPConfigService] User config file changed (external)');

            // Notify about user-level config change
            this.notifyChange('user');

            // Also notify any active workspaces, since ~/.claude.json contains project-specific
            // MCP servers in the "projects" section
            for (const workspacePath of this.workspaceWatchers.keys()) {
              this.notifyChange('workspace', workspacePath);
            }
          });
        }
      });

      this.userConfigWatcher.on('error', (error) => {
        logger.mcp.error('[MCPConfigService] User config watcher error:', error);
      });

      logger.mcp.info('[MCPConfigService] Started watching user config:', this.userConfigPath);
    } catch (error) {
      logger.mcp.error('[MCPConfigService] Failed to start user config watcher:', error);
    }
  }

  /**
   * Start watching a workspace-level MCP config file (.mcp.json) for changes.
   * Call this when a workspace is opened.
   *
   * This uses a two-watcher approach:
   * 1. Watch the .mcp.json file directly if it exists
   * 2. Watch the workspace directory to detect when .mcp.json is created
   */
  startWatchingWorkspaceConfig(workspacePath: string): void {
    if (!workspacePath) {
      throw new Error('workspacePath is required');
    }

    if (this.workspaceWatchers.has(workspacePath)) {
      logger.mcp.debug('[MCPConfigService] Already watching workspace:', workspacePath);
      return;
    }

    const mcpJsonPath = path.join(workspacePath, '.mcp.json');

    // Try to watch the .mcp.json file directly
    try {
      const fileWatcher = watch(mcpJsonPath, (eventType) => {
        if (eventType === 'change') {
          this.debouncedNotify(`workspace-${workspacePath}`, () => {
            // Check if this change was caused by our own write
            if (this.shouldSuppressChangeEvent(mcpJsonPath)) {
              return;
            }

            logger.mcp.info('[MCPConfigService] Workspace config changed (external):', workspacePath);
            this.notifyChange('workspace', workspacePath);
          });
        }
      });

      fileWatcher.on('error', (error) => {
        // Don't log missing file errors - workspace might not have .mcp.json
        if ((error as any).code !== 'ENOENT') {
          logger.mcp.error('[MCPConfigService] Workspace config watcher error:', error);
        }
      });

      this.workspaceWatchers.set(workspacePath, fileWatcher);
      logger.mcp.info('[MCPConfigService] Started watching workspace config:', mcpJsonPath);
    } catch (error) {
      // File doesn't exist yet - that's fine, we'll watch the directory instead
      logger.mcp.debug('[MCPConfigService] .mcp.json does not exist yet, watching directory');
    }

    // Also watch the workspace directory to detect when .mcp.json is created
    try {
      const dirWatcher = watch(workspacePath, (eventType, filename) => {
        if (filename === '.mcp.json' && (eventType === 'rename' || eventType === 'change')) {
          this.debouncedNotify(`workspace-dir-${workspacePath}`, () => {
            // Check if this change was caused by our own write
            if (this.shouldSuppressChangeEvent(mcpJsonPath)) {
              return;
            }

            logger.mcp.info('[MCPConfigService] Workspace .mcp.json created/changed (external):', workspacePath);

            // If we weren't watching the file yet, start watching it now
            if (!this.workspaceWatchers.has(workspacePath)) {
              this.startWatchingWorkspaceConfig(workspacePath);
            }

            this.notifyChange('workspace', workspacePath);
          });
        }
      });

      dirWatcher.on('error', (error) => {
        logger.mcp.error('[MCPConfigService] Workspace directory watcher error:', error);
      });

      this.workspaceDirWatchers.set(workspacePath, dirWatcher);
      logger.mcp.info('[MCPConfigService] Started watching workspace directory:', workspacePath);
    } catch (error) {
      logger.mcp.error('[MCPConfigService] Failed to start workspace directory watcher:', error);
    }
  }

  /**
   * Stop watching a workspace-level MCP config file.
   * Call this when a workspace is closed.
   */
  stopWatchingWorkspaceConfig(workspacePath: string): void {
    // Stop watching the .mcp.json file
    const watcher = this.workspaceWatchers.get(workspacePath);
    if (watcher) {
      watcher.close();
      this.workspaceWatchers.delete(workspacePath);
      logger.mcp.info('[MCPConfigService] Stopped watching workspace config:', workspacePath);
    }

    // Stop watching the workspace directory
    const dirWatcher = this.workspaceDirWatchers.get(workspacePath);
    if (dirWatcher) {
      dirWatcher.close();
      this.workspaceDirWatchers.delete(workspacePath);
      logger.mcp.info('[MCPConfigService] Stopped watching workspace directory:', workspacePath);
    }

    // Clean up any pending debounce timers for this workspace
    const fileTimerKey = `workspace-${workspacePath}`;
    const dirTimerKey = `workspace-dir-${workspacePath}`;
    if (this.debounceTimers.has(fileTimerKey)) {
      clearTimeout(this.debounceTimers.get(fileTimerKey)!);
      this.debounceTimers.delete(fileTimerKey);
    }
    if (this.debounceTimers.has(dirTimerKey)) {
      clearTimeout(this.debounceTimers.get(dirTimerKey)!);
      this.debounceTimers.delete(dirTimerKey);
    }
  }

  /**
   * Register a callback to be called when MCP config files change.
   * @param callback Function called with scope ('user' or 'workspace') and optional workspacePath
   */
  onChange(callback: (scope: 'user' | 'workspace', workspacePath?: string) => void): void {
    this.changeCallbacks.push(callback);
  }

  /**
   * Notify all registered callbacks of a config change.
   */
  private notifyChange(scope: 'user' | 'workspace', workspacePath?: string): void {
    this.changeCallbacks.forEach(callback => {
      try {
        callback(scope, workspacePath);
      } catch (error) {
        logger.mcp.error('[MCPConfigService] Error in change callback:', error);
      }
    });
  }

  /**
   * Mark that we just wrote to a config file.
   * This allows us to suppress file watcher events for our own writes.
   */
  private markRecentWrite(filePath: string): void {
    this.recentWrites.set(filePath, Date.now());
    // Clean up old entries after suppression period
    setTimeout(() => {
      this.recentWrites.delete(filePath);
    }, this.WRITE_SUPPRESSION_MS + 100);
  }

  /**
   * Check if a file change event should be suppressed because we recently wrote to it.
   */
  private shouldSuppressChangeEvent(filePath: string): boolean {
    const lastWrite = this.recentWrites.get(filePath);
    if (!lastWrite) {
      return false;
    }
    const elapsed = Date.now() - lastWrite;
    const shouldSuppress = elapsed < this.WRITE_SUPPRESSION_MS;
    if (shouldSuppress) {
      logger.mcp.debug(`[MCPConfigService] Suppressing change event for ${filePath} (our own write ${elapsed}ms ago)`);
    }
    return shouldSuppress;
  }

  /**
   * Debounce file watcher notifications to avoid multiple toasts for single save.
   * Editors often write temp files which trigger multiple fs.watch events.
   */
  private debouncedNotify(key: string, callback: () => void): void {
    // Clear existing timer for this key
    if (this.debounceTimers.has(key)) {
      clearTimeout(this.debounceTimers.get(key)!);
    }

    // Set new timer
    const timer = setTimeout(() => {
      this.debounceTimers.delete(key);
      callback();
    }, this.DEBOUNCE_MS);

    this.debounceTimers.set(key, timer);
  }

  /**
   * Cleanup all file watchers.
   * Call this during app shutdown.
   */
  cleanup(): void {
    // Stop user config watcher
    if (this.userConfigWatcher) {
      this.userConfigWatcher.close();
      this.userConfigWatcher = null;
      logger.mcp.info('[MCPConfigService] Stopped watching user config');
    }

    // Stop all workspace file watchers
    this.workspaceWatchers.forEach((watcher, workspacePath) => {
      watcher.close();
      logger.mcp.info('[MCPConfigService] Stopped watching workspace config:', workspacePath);
    });
    this.workspaceWatchers.clear();

    // Stop all workspace directory watchers
    this.workspaceDirWatchers.forEach((watcher, workspacePath) => {
      watcher.close();
      logger.mcp.info('[MCPConfigService] Stopped watching workspace directory:', workspacePath);
    });
    this.workspaceDirWatchers.clear();

    // Clear all pending debounce timers
    this.debounceTimers.forEach((timer) => {
      clearTimeout(timer);
    });
    this.debounceTimers.clear();

    // Clear callbacks
    this.changeCallbacks = [];
  }

  /**
   * Convert HTTP transport to stdio with mcp-remote wrapper.
   * This allows users to configure HTTP servers in the UI while we transparently
   * use mcp-remote for OAuth and connection management.
   *
   * Headers are passed as --header arguments to mcp-remote.
   */
  private convertHttpToStdio(serverConfig: MCPServerConfig): MCPServerConfig {
    const remoteConfig = extractMcpRemoteConfig(serverConfig);
    if (serverConfig.type !== 'http' || !remoteConfig) {
      return serverConfig;
    }

    const args = buildMcpRemoteArgs(remoteConfig);

    // Convert HTTP config to stdio with mcp-remote
    // Using bundled mcp-remote from node_modules (managed as a package.json dependency)
    return {
      type: 'stdio',
      command: 'npx',
      args,
      env: serverConfig.env,
      disabled: serverConfig.disabled
    };
  }

  isOAuthServer(serverConfig: MCPServerConfig): boolean {
    if (usesNativeRemoteOAuth(serverConfig)) {
      return true;
    }
    const remoteConfig = extractMcpRemoteConfig(serverConfig);
    return remoteConfig?.requiresOAuth === true;
  }

  async isOAuthAuthorized(
    serverConfig: MCPServerConfig,
    options: { useMcpRemoteForNativeOAuth?: boolean } = {}
  ): Promise<boolean> {
    if (usesNativeRemoteOAuth(serverConfig) && !options.useMcpRemoteForNativeOAuth) {
      return true;
    }
    const remoteConfig = extractMcpRemoteConfig(serverConfig, options);
    if (!remoteConfig || !(await discoverMcpRemoteOAuthRequirement(remoteConfig))) {
      return true;
    }
    const status = await checkMcpRemoteAuthStatus(serverConfig, options);
    return status.authorized;
  }

  /**
   * Ensure every server entry has an explicit `type` field.
   *
   * Claude Code 2.1.x requires `type` as an explicit discriminator and rejects
   * entries that omit it (e.g. `{ "url": "..." }` without `"type": "http"`).
   * Older Nimbalyst versions and manually-authored configs may be missing it.
   *
   * Inference rules (only applied when `type` is missing):
   * - Entry has `url` -> `http` (the modern remote transport)
   * - Entry has `command` -> `stdio`
   * - Otherwise: leave unchanged and let validation surface the issue
   */
  private normalizeServers(
    mcpServers: Record<string, MCPServerConfig>
  ): Record<string, MCPServerConfig> {
    const result: Record<string, MCPServerConfig> = {};
    for (const [name, serverConfig] of Object.entries(mcpServers)) {
      if (!serverConfig || typeof serverConfig !== 'object') {
        result[name] = serverConfig;
        continue;
      }
      if (serverConfig.type) {
        result[name] = serverConfig;
        continue;
      }
      if (typeof serverConfig.url === 'string' && serverConfig.url) {
        result[name] = { ...serverConfig, type: 'http' };
      } else if (typeof serverConfig.command === 'string' && serverConfig.command) {
        result[name] = { ...serverConfig, type: 'stdio' };
      } else {
        result[name] = serverConfig;
      }
    }
    return result;
  }

  /**
   * Drop fields that do not belong to the selected transport.
   * This keeps stale values from edited/manual configs from leaking into
   * downstream agent config generation.
   */
  private normalizeTransportFields(serverConfig: MCPServerConfig): MCPServerConfig {
    const transportType = serverConfig.type === 'sse' || serverConfig.type === 'http'
      ? serverConfig.type
      : 'stdio';

    if (transportType === 'stdio') {
      const { url: _url, headers: _headers, oauth: _oauth, ...rest } = serverConfig;
      return {
        ...rest,
        type: transportType,
      };
    }

    const { command: _command, args: _args, ...rest } = serverConfig;
    return {
      ...rest,
      type: transportType,
    };
  }

  /**
   * Process a server config for runtime use.
   * On Windows, converts npm/npx/etc commands to their .cmd equivalents.
   * Transparently wraps HTTP transport with mcp-remote.
   * Routes bare `node` commands through Electron's bundled Node runtime so
   * MCP servers do not require a system-wide Node install (see #197).
   */
  processServerConfigForRuntime(serverConfig: MCPServerConfig): MCPServerConfig {
    // First, convert HTTP to stdio with mcp-remote wrapper
    let config = this.normalizeTransportFields(this.convertHttpToStdio(serverConfig));

    // Only process stdio servers with a command
    if (config.type === 'sse' || !config.command) {
      return config;
    }

    // Substitute bundled Electron Node runtime for bare `node` commands.
    // Electron itself is a Node binary; setting `ELECTRON_RUN_AS_NODE=1`
    // and pointing `command` at `process.execPath` makes the spawn behave
    // exactly like invoking `node`. Costs zero extra installer size
    // (Electron is already shipped) and unblocks fresh Windows / macOS /
    // Linux installs that don't have Node.js on PATH. See #197.
    //
    // Substitution rules:
    //   - Only triggers when running inside Electron (`process.versions.electron`).
    //     Outside Electron (vitest, CI, mobile builds), behaviour is unchanged.
    //   - Only matches the bare token `node` (or `node.exe` on Windows).
    //     A user who specifies an absolute path (`/usr/local/bin/node`,
    //     `/Users/me/.nvm/versions/node/...`) keeps their original choice.
    //   - Does NOT touch `npx`, `npm`, `bun`, `deno`, etc. Those are separate
    //     tools that the bundled Node runtime cannot stand in for.
    if (
      MCPConfigService.isBareNodeCommand(config.command) &&
      typeof process !== 'undefined' &&
      typeof process.versions === 'object' &&
      typeof process.versions.electron === 'string' &&
      process.versions.electron.length > 0
    ) {
      return {
        ...config,
        command: process.execPath,
        env: {
          ...(config.env || {}),
          ELECTRON_RUN_AS_NODE: '1',
        },
      };
    }

    // Resolve command for current platform
    const resolvedCommand = this.resolveCommandForPlatform(config.command);

    // Return a new config with the resolved command
    return {
      ...config,
      command: resolvedCommand
    };
  }

  /**
   * Whether `command` is a bare reference to the Node.js binary (i.e. relies
   * on PATH lookup), as opposed to an absolute path or a different runtime.
   * Static + exported for unit testing without instantiating the service.
   *
   * Matches `node`, `node.exe` (case-insensitive) - exactly what a user
   * writes in `mcp.json` when they expect the system Node on PATH.
   */
  static isBareNodeCommand(command: string | undefined): boolean {
    if (!command || typeof command !== 'string') return false;
    const normalized = command.trim().toLowerCase();
    return normalized === 'node' || normalized === 'node.exe';
  }

  /**
   * Validate MCP configuration against Claude Code schema.
   * Throws error if invalid.
   */
  validateConfig(config: MCPConfig): void {
    if (!config || typeof config !== 'object') {
      throw new Error('Invalid MCP config: must be an object');
    }

    if (!config.mcpServers || typeof config.mcpServers !== 'object') {
      throw new Error('Invalid MCP config: mcpServers must be an object');
    }

    // Validate each server
    for (const [serverName, serverConfig] of Object.entries(config.mcpServers)) {
      if (!serverName || typeof serverName !== 'string') {
        throw new Error('Invalid MCP config: server name must be a non-empty string');
      }

      if (!serverConfig || typeof serverConfig !== 'object') {
        throw new Error(`Invalid MCP config for server "${serverName}": must be an object`);
      }

      // Determine transport type (default to stdio for backward compatibility)
      const transportType = serverConfig.type || 'stdio';

      if (transportType === 'stdio') {
        // stdio transport requires command
        if (!serverConfig.command || typeof serverConfig.command !== 'string') {
          throw new Error(`Invalid MCP config for server "${serverName}": command is required for stdio transport`);
        }

        if (serverConfig.args && !Array.isArray(serverConfig.args)) {
          throw new Error(`Invalid MCP config for server "${serverName}": args must be an array`);
        }
      } else if (transportType === 'sse' || transportType === 'http') {
        // SSE/HTTP transports require url
        const transportLabel = transportType === 'sse' ? 'SSE' : 'HTTP';
        if (!serverConfig.url || typeof serverConfig.url !== 'string') {
          throw new Error(`Invalid MCP config for server "${serverName}": url is required for ${transportLabel} transport`);
        }

        // Validate URL format
        try {
          new URL(serverConfig.url);
        } catch {
          throw new Error(`Invalid MCP config for server "${serverName}": url must be a valid URL`);
        }

        // Validate headers (HTTP only)
        if (serverConfig.headers) {
          if (transportType !== 'http') {
            throw new Error(`Invalid MCP config for server "${serverName}": headers are only supported for HTTP transport`);
          }
          if (typeof serverConfig.headers !== 'object') {
            throw new Error(`Invalid MCP config for server "${serverName}": headers must be an object`);
          }
          // Validate header values are strings
          for (const [headerName, headerValue] of Object.entries(serverConfig.headers)) {
            if (typeof headerValue !== 'string') {
              throw new Error(`Invalid MCP config for server "${serverName}": header "${headerName}" value must be a string`);
            }
          }
        }
      } else {
        throw new Error(`Invalid MCP config for server "${serverName}": unsupported transport type "${transportType}"`);
      }

      if (serverConfig.env && typeof serverConfig.env !== 'object') {
        throw new Error(`Invalid MCP config for server "${serverName}": env must be an object`);
      }

      if (serverConfig.oauth !== undefined) {
        if (!serverConfig.oauth || typeof serverConfig.oauth !== 'object' || Array.isArray(serverConfig.oauth)) {
          throw new Error(`Invalid MCP config for server "${serverName}": oauth must be an object`);
        }

        if (serverConfig.oauth.callbackPort !== undefined) {
          if (!Number.isInteger(serverConfig.oauth.callbackPort) || serverConfig.oauth.callbackPort <= 0) {
            throw new Error(`Invalid MCP config for server "${serverName}": oauth.callbackPort must be a positive integer`);
          }
        }

        if (serverConfig.oauth.host !== undefined && typeof serverConfig.oauth.host !== 'string') {
          throw new Error(`Invalid MCP config for server "${serverName}": oauth.host must be a string`);
        }

        if (serverConfig.oauth.resource !== undefined && typeof serverConfig.oauth.resource !== 'string') {
          throw new Error(`Invalid MCP config for server "${serverName}": oauth.resource must be a string`);
        }

        if (serverConfig.oauth.authTimeoutSeconds !== undefined) {
          if (!Number.isInteger(serverConfig.oauth.authTimeoutSeconds) || serverConfig.oauth.authTimeoutSeconds <= 0) {
            throw new Error(`Invalid MCP config for server "${serverName}": oauth.authTimeoutSeconds must be a positive integer`);
          }
        }

        if (
          serverConfig.oauth.transportStrategy !== undefined &&
          !['http-first', 'sse-first', 'http-only', 'sse-only'].includes(serverConfig.oauth.transportStrategy)
        ) {
          throw new Error(`Invalid MCP config for server "${serverName}": oauth.transportStrategy must be one of http-first, sse-first, http-only, or sse-only`);
        }

        if (
          serverConfig.oauth.staticClientInfo !== undefined &&
          (typeof serverConfig.oauth.staticClientInfo !== 'object' ||
            Array.isArray(serverConfig.oauth.staticClientInfo))
        ) {
          throw new Error(`Invalid MCP config for server "${serverName}": oauth.staticClientInfo must be an object`);
        }

        if (serverConfig.oauth.clientId !== undefined && typeof serverConfig.oauth.clientId !== 'string') {
          throw new Error(`Invalid MCP config for server "${serverName}": oauth.clientId must be a string`);
        }

        if (serverConfig.oauth.clientSecret !== undefined && typeof serverConfig.oauth.clientSecret !== 'string') {
          throw new Error(`Invalid MCP config for server "${serverName}": oauth.clientSecret must be a string`);
        }

        if (
          serverConfig.oauth.staticClientMetadata !== undefined &&
          (typeof serverConfig.oauth.staticClientMetadata !== 'object' ||
            Array.isArray(serverConfig.oauth.staticClientMetadata))
        ) {
          throw new Error(`Invalid MCP config for server "${serverName}": oauth.staticClientMetadata must be an object`);
        }
      }

      if (serverConfig.enabledForProviders !== undefined) {
        if (!Array.isArray(serverConfig.enabledForProviders)) {
          throw new Error(`Invalid MCP config for server "${serverName}": enabledForProviders must be an array`);
        }
        for (const provider of serverConfig.enabledForProviders) {
          if (typeof provider !== 'string') {
            throw new Error(`Invalid MCP config for server "${serverName}": enabledForProviders must contain only strings`);
          }
        }
      }
    }
  }

  /**
   * Get the path to the user-level MCP config file.
   */
  getUserConfigPath(): string {
    return this.userConfigPath;
  }

  /**
   * Get the path to the legacy user-level MCP config file.
   */
  getLegacyConfigPath(): string {
    return this.legacyConfigPath;
  }

  /**
   * Get the path to the workspace-level MCP config file.
   */
  getWorkspaceConfigPath(workspacePath: string): string {
    if (!workspacePath) {
      throw new Error('workspacePath is required');
    }
    return path.join(workspacePath, '.mcp.json');
  }

  /**
   * Test an MCP server connection.
   * For stdio: attempts to spawn and communicate with the process.
   * For SSE: attempts to connect to the URL endpoint.
   * For HTTP: converts to mcp-remote wrapper and tests stdio (since HTTP uses OAuth via mcp-remote).
   */
  async testServerConnection(
    config: MCPServerConfig,
    onProgress?: TestProgressCallback
  ): Promise<{ success: boolean; error?: string; helpUrl?: string }> {
    try {
      // Validate config first
      const tempConfig: MCPConfig = {
        mcpServers: { test: config }
      };
      this.validateConfig(tempConfig);

      const remoteConfig = extractMcpRemoteConfig(config);
      if (
        !usesNativeRemoteOAuth(config)
        && remoteConfig
        && await discoverMcpRemoteOAuthRequirement(remoteConfig)
        && !(await this.isOAuthAuthorized(config))
      ) {
        return {
          success: false,
          error: 'OAuth authorization required. Use the Authorize button before testing this server.'
        };
      }

      const transportType = config.type || 'stdio';

      if (usesNativeRemoteOAuth(config)) {
        return await this.testHTTPConnection(config, transportType === 'sse' ? 'sse' : 'http');
      }

      // For HTTP transport, convert to mcp-remote wrapper and test as stdio
      // This ensures we test with OAuth tokens managed by mcp-remote
      if (transportType === 'http') {
        const wrappedConfig = this.convertHttpToStdio(config);
        return await this.testStdioConnection(wrappedConfig, onProgress);
      } else if (transportType === 'sse') {
        return await this.testHTTPConnection(config, transportType);
      } else {
        return await this.testStdioConnection(config, onProgress);
      }
    } catch (error: any) {
      logger.mcp.error('MCP server test error:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Test HTTP/SSE server connection by attempting to fetch from the endpoint.
   * For HTTP transport: Uses Streamable HTTP protocol (recommended)
   * For SSE transport: Uses legacy Server-Sent Events protocol
   * Note: This is a basic connectivity test. Full MCP protocol validation
   * happens when the server is actually used by Claude Code.
   */
  private async testHTTPConnection(
    config: MCPServerConfig,
    transportType: 'http' | 'sse'
  ): Promise<{ success: boolean; error?: string }> {
    if (!config.url) {
      const transportLabel = transportType === 'sse' ? 'SSE' : 'HTTP';
      return { success: false, error: `URL is required for ${transportLabel} transport` };
    }

    try {
      const headers = this.getHeadersFromEnv(config.env);
      const transportLabel = transportType === 'sse' ? 'SSE' : 'HTTP';

      logger.mcp.debug(`Testing ${transportLabel} connection to:`, config.url);
      logger.mcp.debug('Headers:', Object.keys(headers));

      // For HTTP transport, use GET to establish connection (Streamable HTTP spec)
      // For SSE transport, also use GET with Accept: text/event-stream (legacy)
      const response = await fetch(config.url, {
        method: 'GET',
        headers: {
          'Accept': transportType === 'sse' ? 'text/event-stream' : 'application/json, text/event-stream',
          'Cache-Control': 'no-cache',
          ...headers
        },
        signal: AbortSignal.timeout(this.CONNECTION_TIMEOUT_MS)
      });

      // Check for authentication errors (401/403) - these indicate auth issues
      if (response.status === 401 || response.status === 403) {
        const errorText = await response.text().catch(() => response.statusText);
        logger.mcp.error(`${transportLabel} authentication failed: ${response.status} ${errorText}`);
        if (usesNativeRemoteOAuth(config)) {
          return {
            success: false,
            error: `Authentication required (${response.status}). This server uses native MCP OAuth, so authorize it from a Claude or Codex session instead of this test.`
          };
        }
        return {
          success: false,
          error: `Authentication failed (${response.status}). Check your API key.`
        };
      }

      // Only consider 2xx responses as success
      if (response.ok) {
        logger.mcp.info(`${transportLabel} endpoint reachable and responding successfully.`);
        return { success: true };
      }

      // Any non-2xx response (that wasn't already caught as 401/403) is a failure
      const errorText = await response.text().catch(() => response.statusText);
      logger.mcp.error(`${transportLabel} endpoint returned error: ${response.status} ${errorText}`);
      return {
        success: false,
        error: `Server returned HTTP ${response.status}. Check your configuration and API key.`
      };
    } catch (error: any) {
      if (error.name === 'TimeoutError' || error.name === 'AbortError') {
        return { success: false, error: 'Connection timeout (30s)' };
      }
      const transportLabel = transportType === 'sse' ? 'SSE' : 'HTTP';
      logger.mcp.error(`${transportLabel} connection error:`, error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Test stdio server connection by spawning the process.
   * Detects npx package downloads and reports progress.
   */
  private async testStdioConnection(
    config: MCPServerConfig,
    onProgress?: TestProgressCallback
  ): Promise<{ success: boolean; error?: string; helpUrl?: string }> {
    const { spawn } = await import('child_process');

    if (!config.command) {
      return { success: false, error: 'Command is required for stdio transport' };
    }

    return new Promise((resolve) => {
      try {
        // Expand environment variables and use enhanced PATH for GUI apps
        // (GUI apps on macOS don't inherit shell PATH, so npx/uvx/etc. may not be found)
        const enhancedPath = getEnhancedPath();
        const env: NodeJS.ProcessEnv = { ...process.env, PATH: enhancedPath };
        if (config.env) {
          for (const [key, value] of Object.entries(config.env)) {
            env[key] = this.expandEnvVar(value, env);
          }
        }

        // On Windows, use .cmd versions of npm/npx to avoid PowerShell execution policy issues
        const command = this.resolveCommandForPlatform(config.command!);

        // Expand environment variables in args as well (e.g., ${FILESYSTEM_ALLOWED_DIR})
        let expandedArgs = (config.args || []).map(arg => this.expandEnvVar(arg, env));

        // On Windows with shell:true, we need to manually quote args containing spaces
        // because windowsVerbatimArguments is automatically set to true with cmd.exe,
        // meaning no automatic escaping is done. Without quoting, cmd.exe treats
        // spaces as argument separators, breaking args like "Authorization:Bearer token"
        if (process.platform === 'win32') {
          expandedArgs = expandedArgs.map(arg => {
            // If arg contains spaces or special cmd characters, wrap in double quotes
            // Also escape any internal double quotes by doubling them
            if (arg.includes(' ') || arg.includes('&') || arg.includes('|') || arg.includes('^')) {
              return `"${arg.replace(/"/g, '""')}"`;
            }
            return arg;
          });
        }

        logger.mcp.info('[MCP Test] Starting stdio connection test');
        logger.mcp.info(`[MCP Test] Command: ${command} (original: ${config.command})`);
        logger.mcp.info(`[MCP Test] Args: ${JSON.stringify(expandedArgs)} (original: ${JSON.stringify(config.args)})`);
        logger.mcp.info(`[MCP Test] Env keys: ${Object.keys(config.env || {}).join(', ')}`);
        logger.mcp.info(`[MCP Test] Enhanced PATH (first 300 chars): ${enhancedPath.substring(0, 300)}...`);

        onProgress?.('connecting', 'Starting server...');

        // Spawn the process (command is validated above)
        // On Windows, .cmd files need shell:true to execute properly
        const child = spawn(command, expandedArgs, {
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: process.platform === 'win32'
        });

        logger.mcp.info(`[MCP Test] Process spawned with PID: ${child.pid}`);

        let output = '';
        let errorOutput = '';
        let hasExtendedTimeout = false;
        let hasSentInitialize = false;
        let resolved = false;
        let timeoutId: NodeJS.Timeout;
        let currentTimeoutMs = this.CONNECTION_TIMEOUT_MS;

        const resolveOnce = (result: { success: boolean; error?: string; helpUrl?: string }) => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timeoutId);
            child.kill();
            onProgress?.('done', '');
            resolve(result);
          }
        };

        const resetTimeout = (newTimeoutMs: number) => {
          clearTimeout(timeoutId);
          currentTimeoutMs = newTimeoutMs;
          timeoutId = setTimeout(() => {
            if (!resolved) {
              const timeoutSec = Math.round(currentTimeoutMs / 1000);
              logger.mcp.warn(`[MCP Test] Connection timeout reached (${timeoutSec}s)`);
              logger.mcp.info(`[MCP Test] stdout so far: ${output.slice(0, 500)}`);
              logger.mcp.info(`[MCP Test] stderr so far: ${errorOutput.slice(0, 1000)}`);
              resolveOnce({ success: false, error: `Connection timeout (${timeoutSec}s)` });
            }
          }, newTimeoutMs);
        };

        // Send initialize request to test JSON-RPC communication
        const sendInitializeRequest = () => {
          if (resolved || hasSentInitialize || !child.stdin) return;

          hasSentInitialize = true;
          const initRequest = {
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2024-11-05",
              capabilities: {},
              clientInfo: {
                name: "nimbalyst-test",
                version: "1.0.0"
              }
            }
          };

          try {
            logger.mcp.info('[MCP Test] Sending initialize request');
            onProgress?.('testing', 'Testing server connection...');
            child.stdin.write(JSON.stringify(initRequest) + '\n');
          } catch (error: any) {
            logger.mcp.error('[MCP Test] Failed to send initialize request:', error);
          }
        };

        // Start with base timeout
        resetTimeout(this.CONNECTION_TIMEOUT_MS);

        child.stdout?.on('data', (data) => {
          const chunk = data.toString();
          output += chunk;
          logger.mcp.debug(`[MCP Test] stdout: ${chunk.slice(0, 200)}`);

          // Try to parse JSON-RPC responses
          // MCP servers may send multiple JSON objects separated by newlines
          const lines = output.split('\n');
          for (let i = 0; i < lines.length - 1; i++) {
            const line = lines[i].trim();
            if (!line) continue;

            try {
              const msg = JSON.parse(line);

              // Check if this is a valid JSON-RPC response to our initialize request
              if (msg.jsonrpc === '2.0' && msg.id === 1) {
                if (msg.result) {
                  logger.mcp.info('[MCP Test] Received valid initialize response');
                  logger.mcp.debug(`[MCP Test] Response: ${JSON.stringify(msg.result).slice(0, 200)}`);
                  resolveOnce({ success: true });
                  return;
                } else if (msg.error) {
                  logger.mcp.error(`[MCP Test] Initialize failed: ${JSON.stringify(msg.error)}`);
                  resolveOnce({ success: false, error: msg.error.message || 'Initialize failed' });
                  return;
                }
              }

              // If we see any valid JSON-RPC on stdout, the server is responding
              // Send initialize request if we haven't already
              if (msg.jsonrpc === '2.0' && !hasSentInitialize) {
                logger.mcp.info('[MCP Test] Detected JSON-RPC output, sending initialize');
                sendInitializeRequest();
              }
            } catch (e) {
              // Not valid JSON, keep accumulating
            }
          }
        });

        child.stderr?.on('data', (data) => {
          const chunk = data.toString();
          errorOutput += chunk;
          logger.mcp.info(`[MCP Test] stderr: ${chunk.slice(0, 500)}`);

          // Detect npx/npm/uvx download progress patterns
          // Only extend timeout once to avoid race conditions
          if (!hasExtendedTimeout &&
              (chunk.includes('npm warn') || chunk.includes('npm notice') ||
              chunk.includes('added') || chunk.includes('packages in') ||
              chunk.includes('reify:') || chunk.includes('timing') ||
              chunk.includes('Resolved') || chunk.includes('Prepared') ||
              chunk.includes('Installed') || chunk.includes('Building') ||
              chunk.includes('Cloning') || chunk.includes('Fetching'))) {
            hasExtendedTimeout = true;
            logger.mcp.info('[MCP Test] Detected package download, extending timeout to 120s');
            onProgress?.('downloading', 'Downloading packages...');
            resetTimeout(this.DOWNLOAD_TIMEOUT_MS);
          }

          // After packages are downloaded or server starts logging, try to communicate
          // Look for common server startup patterns to know when to send initialize
          if (!hasSentInitialize &&
              (chunk.includes('MCP server') ||
              chunk.includes('server_lifespan') ||
              chunk.includes('Starting') ||
              chunk.includes('Listening') ||
              chunk.includes('Ready'))) {
            logger.mcp.info('[MCP Test] Server startup detected, will send initialize request');
            // Wait a moment for server to fully initialize, then send request
            setTimeout(() => {
              sendInitializeRequest();
            }, 1000);
          }

          if (chunk.includes('Connection error') || chunk.includes('Fatal error')) {
            logger.mcp.error(`[MCP Test] Connection error detected: ${chunk}`);
          }
        });

        child.on('error', (error: NodeJS.ErrnoException) => {
          logger.mcp.error('[MCP Test] Spawn error:', error);

          // Provide helpful error message for command not found
          if (error.code === 'ENOENT') {
            const commandHelp = this.getCommandNotFoundHelp(config.command || '');
            logger.mcp.error(`[MCP Test] Command not found in PATH: ${config.command}`);
            logger.mcp.error(`[MCP Test] Enhanced PATH used: ${enhancedPath.substring(0, 500)}...`);
            resolveOnce({ success: false, error: commandHelp.message, helpUrl: commandHelp.helpUrl });
          } else {
            resolveOnce({ success: false, error: error.message });
          }
        });

        child.on('exit', (code, signal) => {
          logger.mcp.info(`[MCP Test] Process exited with code: ${code}, signal: ${signal}`);
          logger.mcp.info(`[MCP Test] Final stdout length: ${output.length}`);
          logger.mcp.info(`[MCP Test] Final stderr: ${errorOutput.slice(0, 500)}`);

          if (!resolved) {
            // Process exited before we got a valid JSON-RPC response
            if (code === 0) {
              // Clean exit but no response - might be a one-shot command
              logger.mcp.info('[MCP Test] Process exited cleanly but no JSON-RPC response');
              resolveOnce({ success: false, error: 'Server exited without responding to initialize request' });
            } else {
              // Check if this is a "command not found" error from the shell
              // Windows: "'xyz' is not recognized as an internal or external command"
              // Unix: "command not found" or "not found"
              const notFoundMatch = errorOutput.match(/'([^']+)' is not recognized|(\S+): (?:command )?not found/i);
              if (notFoundMatch) {
                const cmdName = notFoundMatch[1] || notFoundMatch[2];
                const commandHelp = this.getCommandNotFoundHelp(cmdName);
                logger.mcp.warn(`[MCP Test] Command not found: ${cmdName}`);
                resolveOnce({ success: false, error: commandHelp.message, helpUrl: commandHelp.helpUrl });
              } else {
                logger.mcp.warn(`[MCP Test] Test failed: ${errorOutput || `exit code ${code}`}`);
                resolveOnce({
                  success: false,
                  error: errorOutput || `Process exited with code ${code}`
                });
              }
            }
          }
        });

        // If we haven't detected server startup patterns after a few seconds, try sending initialize anyway
        // Some servers might be ready but just not logging anything to stderr
        setTimeout(() => {
          if (!hasSentInitialize && !resolved) {
            logger.mcp.info('[MCP Test] No startup patterns detected, attempting initialize anyway');
            sendInitializeRequest();
          }
        }, 3000);

      } catch (error: any) {
        logger.mcp.error('[MCP Test] Unexpected error:', error);
        resolve({ success: false, error: error.message });
      }
    });
  }

  /**
   * Extract headers from environment variables (for SSE authentication).
   * Sends API keys as Authorization Bearer tokens.
   */
  private getHeadersFromEnv(env?: MCPServerEnv): Record<string, string> {
    const headers: Record<string, string> = {};

    if (env) {
      // Expand environment variables from the config
      const processEnv: Record<string, string | undefined> = { ...process.env };

      for (const [key, value] of Object.entries(env) as [string, string][]) {
        const expandedValue = this.expandEnvVar(value, processEnv);

        // Send API keys as Authorization Bearer tokens
        if (key.endsWith('_API_KEY') && expandedValue) {
          // Don't add Bearer prefix if value already has it or if it's empty
          if (!expandedValue.startsWith('Bearer ') && expandedValue !== `\${${key}}`) {
            headers['Authorization'] = `Bearer ${expandedValue}`;
            logger.mcp.debug(`Added Authorization header from ${key}`);
          }
        }
      }
    }

    return headers;
  }

  /**
   * Expand environment variable syntax: ${VAR} and ${VAR:-default}
   */
  private expandEnvVar(value: string, env: Record<string, string | undefined>): string {
    return value.replace(/\$\{([^}:]+)(:-([^}]+))?\}/g, (_, varName, __, defaultValue) => {
      const envValue = env[varName];
      if (envValue !== undefined) {
        return envValue;
      }
      if (defaultValue !== undefined) {
        return defaultValue;
      }
      // Variable not set and no default - return original
      return `\${${varName}}`;
    });
  }

  /**
   * Resolve command for the current platform.
   * On Windows, npm/npx need to use .cmd extension to avoid PowerShell execution policy issues.
   */
  private resolveCommandForPlatform(command: string): string {
    if (process.platform !== 'win32') {
      return command;
    }

    // On Windows, use .cmd versions to bypass PowerShell execution policy
    // PowerShell tries to run .ps1 scripts which may be blocked by security policy
    const windowsCommands: Record<string, string> = {
      'npx': 'npx.cmd',
      'npm': 'npm.cmd',
      'node': 'node.exe',
      'pnpm': 'pnpm.cmd',
      'yarn': 'yarn.cmd',
      'bun': 'bun.exe'
    };

    return windowsCommands[command] || command;
  }

  /**
   * Get helpful error message and install URL for command not found errors.
   * Delegates to the exported standalone function.
   */
  private getCommandNotFoundHelp(command: string): { message: string; helpUrl?: string } {
    return getCommandNotFoundHelp(command);
  }
}
