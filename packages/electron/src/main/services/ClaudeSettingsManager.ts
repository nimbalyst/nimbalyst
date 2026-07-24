/**
 * Claude Settings Manager
 *
 * Manages reading/writing Claude Code's native settings files:
 * - .claude/settings.json (project-level, shared with team)
 * - .claude/settings.local.json (project-level, personal)
 * - ~/.claude/settings.json (user-level)
 *
 * This allows Nimbalyst to be a UI layer on top of Claude Code's permission system,
 * ensuring permissions work consistently between Nimbalyst and the Claude CLI.
 *
 * WORKTREE SUPPORT: When a workspace is a git worktree, settings are read/written
 * from/to the parent project's .claude/ directory. This ensures worktrees share
 * the same permission patterns as their parent project.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { watch, FSWatcher } from 'fs';
import { logger } from '../utils/logger';
import { resolveWorkspacePathForPermissions } from './PermissionService';
import { resolveProjectPath } from '../utils/workspaceDetection';

const log = logger.main;

/**
 * Structure of Claude Code's settings.json permissions section
 */
export interface ClaudePermissions {
  /** Tool patterns that are always allowed */
  allow: string[];
  /** Tool patterns that are always denied */
  deny: string[];
  /** Tool patterns that should always prompt (not commonly used) */
  ask: string[];
  /** Additional directories the agent can access */
  additionalDirectories?: string[];
}

/**
 * Full structure of a Claude settings file
 */
export interface ClaudeSettings {
  permissions?: ClaudePermissions;
  enableAllProjectMcpServers?: boolean;
  enabledMcpjsonServers?: string[];
  [key: string]: unknown;
}

/**
 * Result of reading effective settings from all sources
 */
export interface EffectiveClaudeSettings {
  /** Merged permissions from all sources */
  permissions: ClaudePermissions;
  /** Which files contributed to the settings */
  sources: {
    projectShared: boolean;
    projectLocal: boolean;
    userLevel: boolean;
  };
  /** Raw settings from each source */
  raw: {
    projectShared?: ClaudeSettings;
    projectLocal?: ClaudeSettings;
    userLevel?: ClaudeSettings;
  };
}

/**
 * Manages reading and writing Claude Code settings files
 */
export class ClaudeSettingsManager {
  private static instance: ClaudeSettingsManager;
  private watchers: Map<string, FSWatcher> = new Map();

  private constructor() {}

  public static getInstance(): ClaudeSettingsManager {
    if (!ClaudeSettingsManager.instance) {
      ClaudeSettingsManager.instance = new ClaudeSettingsManager();
    }
    return ClaudeSettingsManager.instance;
  }

  /**
   * Get the path to the project-level shared settings file.
   * Resolves worktree paths to parent project so settings are inherited.
   */
  private getProjectSharedPath(workspacePath: string): string {
    const projectPath = resolveProjectPath(workspacePath);
    return path.join(projectPath, '.claude', 'settings.json');
  }

  /**
   * Get the path to the project-level local settings file.
   * Resolves worktree paths to parent project so settings are inherited.
   */
  private getProjectLocalPath(workspacePath: string): string {
    const projectPath = resolveProjectPath(workspacePath);
    return path.join(projectPath, '.claude', 'settings.local.json');
  }

  /**
   * Get the path to the user-level settings file
   */
  private getUserLevelPath(): string {
    // Use os.homedir() instead of process.env for packaged builds on Intel Macs
    // where HOME may not be set correctly
    return path.join(os.homedir(), '.claude', 'settings.json');
  }

  /**
   * Read a settings file, returning undefined if it doesn't exist
   */
  private async readSettingsFile(filePath: string): Promise<ClaudeSettings | undefined> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(content) as ClaudeSettings;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      log.warn(`Failed to read settings file: ${filePath}`, error);
      return undefined;
    }
  }

  /**
   * Write a settings file, creating directories if needed
   */
  private async writeSettingsFile(filePath: string, settings: ClaudeSettings): Promise<void> {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(settings, null, 2), 'utf-8');
    log.info(`Wrote settings file: ${filePath}`);
  }

  /**
   * Merge permissions from multiple sources (later sources override earlier)
   */
  private mergePermissions(...sources: (ClaudePermissions | undefined)[]): ClaudePermissions {
    const merged: ClaudePermissions = {
      allow: [],
      deny: [],
      ask: [],
      additionalDirectories: [],
    };

    for (const source of sources) {
      if (!source) continue;

      // For allow/deny/ask, we merge arrays (dedupe)
      if (source.allow) {
        merged.allow = [...new Set([...merged.allow, ...source.allow])];
      }
      if (source.deny) {
        merged.deny = [...new Set([...merged.deny, ...source.deny])];
      }
      if (source.ask) {
        merged.ask = [...new Set([...merged.ask, ...source.ask])];
      }
      if (source.additionalDirectories) {
        merged.additionalDirectories = [
          ...new Set([...(merged.additionalDirectories || []), ...source.additionalDirectories]),
        ];
      }
    }

    return merged;
  }

  /**
   * Get effective settings merged from all sources
   * NOTE: Resolves worktree paths to parent project for settings lookup
   */
  async getEffectiveSettings(workspacePath: string): Promise<EffectiveClaudeSettings> {
    // Resolve worktree paths to parent project
    const resolvedPath = await resolveWorkspacePathForPermissions(workspacePath);

    const [projectShared, projectLocal, userLevel] = await Promise.all([
      this.readSettingsFile(this.getProjectSharedPath(resolvedPath)),
      this.readSettingsFile(this.getProjectLocalPath(resolvedPath)),
      this.readSettingsFile(this.getUserLevelPath()),
    ]);

    const permissions = this.mergePermissions(
      userLevel?.permissions,
      projectShared?.permissions,
      projectLocal?.permissions
    );

    return {
      permissions,
      sources: {
        projectShared: !!projectShared,
        projectLocal: !!projectLocal,
        userLevel: !!userLevel,
      },
      raw: {
        projectShared,
        projectLocal,
        userLevel,
      },
    };
  }

  /**
   * Add an allowed tool pattern to the project-local settings
   * (personal, not shared with team)
   * NOTE: Resolves worktree paths to parent project
   */
  async addAllowedTool(workspacePath: string, pattern: string): Promise<void> {
    // SECURITY: Never save compound command patterns - they must be approved each time
    // Compound patterns like "Bash:compound:1234567890" should never be persisted
    if (pattern.startsWith('Bash:compound:')) {
      log.warn(`Refusing to save compound command pattern (security): ${pattern}`);
      return;
    }

    // VALIDATION: Filter out garbage patterns that are clearly not valid tool patterns
    // These can occur when Claude's code output is incorrectly parsed as bash commands
    if (pattern.startsWith('Bash(')) {
      // Extract the command from Bash(command:*)
      const match = pattern.match(/^Bash\(([^:]+):\*\)$/);
      if (match) {
        const command = match[1];
        // Valid bash commands should start with a letter or be common commands
        // Reject patterns that look like code fragments (const, //, [], {}, etc.)
        const invalidPatterns = [
          /^[^a-zA-Z]/, // Doesn't start with a letter
          /^const$/i,
          /^let$/i,
          /^var$/i,
          /^if$/i,
          /^for$/i,
          /^while$/i,
          /^function$/i,
          /^return$/i,
          /^class$/i,
          /^import$/i,
          /^export$/i,
          /^\[.*\]$/,    // Array syntax
          /^\{.*\}$/,    // Object syntax
          /^\/\//,       // Comment
          /^```/,        // Code fence
          /^--$/,        // Double dash alone
          /^\)$/,        // Just closing paren
          /^\}$/,        // Just closing brace
          /^,$/,         // Just comma
        ];

        if (invalidPatterns.some(regex => regex.test(command))) {
          log.warn(`Refusing to save invalid bash pattern (looks like code): ${pattern}`);
          return;
        }
      }
    }

    // Resolve worktree paths to parent project
    const resolvedPath = await resolveWorkspacePathForPermissions(workspacePath);
    const filePath = this.getProjectLocalPath(resolvedPath);
    const settings = (await this.readSettingsFile(filePath)) || {};

    if (!settings.permissions) {
      settings.permissions = { allow: [], deny: [], ask: [] };
    }

    // Don't add duplicates
    if (!settings.permissions.allow.includes(pattern)) {
      settings.permissions.allow.push(pattern);
      await this.writeSettingsFile(filePath, settings);
      log.info(`Added allowed tool pattern: ${pattern}`);
    }
  }

  /**
   * Remove an allowed tool pattern from the project-local settings
   * NOTE: Resolves worktree paths to parent project
   */
  async removeAllowedTool(workspacePath: string, pattern: string): Promise<void> {
    // Resolve worktree paths to parent project
    const resolvedPath = await resolveWorkspacePathForPermissions(workspacePath);
    const filePath = this.getProjectLocalPath(resolvedPath);
    const settings = await this.readSettingsFile(filePath);

    if (settings?.permissions?.allow) {
      settings.permissions.allow = settings.permissions.allow.filter((p) => p !== pattern);
      await this.writeSettingsFile(filePath, settings);
      log.info(`Removed allowed tool pattern: ${pattern}`);
    }
  }

  /**
   * Add an additional directory to the project-local settings
   * NOTE: Resolves worktree paths to parent project
   */
  async addAdditionalDirectory(workspacePath: string, directory: string): Promise<void> {
    // Resolve worktree paths to parent project
    const resolvedPath = await resolveWorkspacePathForPermissions(workspacePath);
    const filePath = this.getProjectLocalPath(resolvedPath);
    const settings = (await this.readSettingsFile(filePath)) || {};

    if (!settings.permissions) {
      settings.permissions = { allow: [], deny: [], ask: [] };
    }
    if (!settings.permissions.additionalDirectories) {
      settings.permissions.additionalDirectories = [];
    }

    // Don't add duplicates
    if (!settings.permissions.additionalDirectories.includes(directory)) {
      settings.permissions.additionalDirectories.push(directory);
      await this.writeSettingsFile(filePath, settings);
      log.info(`Added additional directory: ${directory}`);
    }
  }

  /**
   * Remove an additional directory from the project-local settings
   * NOTE: Resolves worktree paths to parent project
   */
  async removeAdditionalDirectory(workspacePath: string, directory: string): Promise<void> {
    // Resolve worktree paths to parent project
    const resolvedPath = await resolveWorkspacePathForPermissions(workspacePath);
    const filePath = this.getProjectLocalPath(resolvedPath);
    const settings = await this.readSettingsFile(filePath);

    if (settings?.permissions?.additionalDirectories) {
      settings.permissions.additionalDirectories = settings.permissions.additionalDirectories.filter(
        (d) => d !== directory
      );
      await this.writeSettingsFile(filePath, settings);
      log.info(`Removed additional directory: ${directory}`);
    }
  }

  /**
   * Generate a tool pattern for the allowedTools list
   */
  generateToolPattern(toolName: string, input: Record<string, unknown>): string {
    switch (toolName) {
      case 'Bash': {
        // Extract the command prefix for pattern matching
        const command = (input.command as string) || '';
        const firstWord = command.split(/\s+/)[0];
        if (firstWord) {
          return `Bash(${firstWord}:*)`;
        }
        return 'Bash';
      }

      case 'WebFetch': {
        // Extract domain for pattern matching
        const url = (input.url as string) || '';
        try {
          const parsedUrl = new URL(url);
          return `WebFetch(domain:${parsedUrl.hostname})`;
        } catch {
          return 'WebFetch';
        }
      }

      case 'Read':
      case 'Write':
      case 'Edit':
      case 'MultiEdit': {
        // For file operations, just allow the tool
        // Could add path patterns if needed: Edit(src/**)
        return toolName;
      }

      case 'WebSearch':
      case 'Glob':
      case 'Grep':
      case 'LS':
      case 'TodoRead':
      case 'TodoWrite':
      case 'Task':
      case 'NotebookRead':
      case 'NotebookEdit':
      case 'ExitPlanMode':
        return toolName;

      default:
        // MCP tools: mcp__server__tool
        if (toolName.startsWith('mcp__')) {
          return toolName;
        }
        return toolName;
    }
  }

  /**
   * Watch settings files for external changes
   * Returns a cleanup function to stop watching
   */
  watchSettings(workspacePath: string, callback: () => void): () => void {
    const paths = [
      this.getProjectSharedPath(workspacePath),
      this.getProjectLocalPath(workspacePath),
      this.getUserLevelPath(),
    ];

    const watchers: FSWatcher[] = [];

    for (const filePath of paths) {
      try {
        // Watch the directory since the file might not exist yet
        const dir = path.dirname(filePath);
        const fileName = path.basename(filePath);

        const watcher = watch(dir, (eventType, changedFile) => {
          if (changedFile === fileName) {
            log.info(`Settings file changed: ${filePath}`);
            callback();
          }
        });

        watchers.push(watcher);
        this.watchers.set(filePath, watcher);
      } catch (error) {
        // Directory might not exist, that's okay
        log.debug(`Could not watch ${filePath}: ${error}`);
      }
    }

    return () => {
      for (const watcher of watchers) {
        watcher.close();
      }
      for (const filePath of paths) {
        this.watchers.delete(filePath);
      }
    };
  }

  /**
   * Get user-level environment variables from ~/.claude/settings.json
   */
  async getUserLevelEnv(): Promise<Record<string, string>> {
    const settings = await this.readSettingsFile(this.getUserLevelPath());
    return (settings?.env as Record<string, string>) || {};
  }

  /**
   * Set user-level environment variables in ~/.claude/settings.json
   * Preserves all other settings in the file
   */
  async setUserLevelEnv(env: Record<string, string>): Promise<void> {
    const filePath = this.getUserLevelPath();
    const settings = (await this.readSettingsFile(filePath)) || {};
    settings.env = env;
    await this.writeSettingsFile(filePath, settings);
  }

  /**
   * Check if a pattern is in the project-local allowed list
   * NOTE: Resolves worktree paths to parent project
   */
  async isPatternAllowedLocally(workspacePath: string, pattern: string): Promise<boolean> {
    // Resolve worktree paths to parent project
    const resolvedPath = await resolveWorkspacePathForPermissions(workspacePath);
    const settings = await this.readSettingsFile(this.getProjectLocalPath(resolvedPath));
    return settings?.permissions?.allow?.includes(pattern) ?? false;
  }

  /**
   * Get all patterns from project-local settings
   * NOTE: Resolves worktree paths to parent project
   */
  async getLocalPatterns(workspacePath: string): Promise<ClaudePermissions | undefined> {
    // Resolve worktree paths to parent project
    const resolvedPath = await resolveWorkspacePathForPermissions(workspacePath);
    const settings = await this.readSettingsFile(this.getProjectLocalPath(resolvedPath));
    return settings?.permissions;
  }

  /**
   * Get all patterns from project-shared settings
   * NOTE: Resolves worktree paths to parent project
   */
  async getSharedPatterns(workspacePath: string): Promise<ClaudePermissions | undefined> {
    // Resolve worktree paths to parent project
    const resolvedPath = await resolveWorkspacePathForPermissions(workspacePath);
    const settings = await this.readSettingsFile(this.getProjectSharedPath(resolvedPath));
    return settings?.permissions;
  }
}
