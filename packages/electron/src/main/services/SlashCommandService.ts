/**
 * Service for discovering workspace slash commands and skills for supported providers.
 */

import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import { parseCommandFile, parseSkillFile, SlashCommand, validateCommand } from './CommandFileParser';

// Re-export SlashCommand type for use by handlers
export type { SlashCommand };

export interface SlashCommandDiscoveryOptions {
  provider?: string | null;
  sdkCommands?: string[];
  sdkSkills?: string[];
  pluginPaths?: string[];
}

interface CachedSlashCommands {
  commands: SlashCommand[];
  cacheTime: number;
}

/**
 * Check if a directory entry is a directory, following symlinks.
 * `Dirent.isDirectory()` returns false for symlinks even when they point to
 * directories, so we fall back to `fs.statSync` for symlinks.
 */
function isDirectoryEntry(entry: fs.Dirent, fullPath: string): boolean {
  if (entry.isDirectory()) return true;
  if (entry.isSymbolicLink()) {
    try {
      return fs.statSync(fullPath).isDirectory();
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Check if a directory entry is a file, following symlinks.
 */
function isFileEntry(entry: fs.Dirent, fullPath: string): boolean {
  if (entry.isFile()) return true;
  if (entry.isSymbolicLink()) {
    try {
      return fs.statSync(fullPath).isFile();
    } catch {
      return false;
    }
  }
  return false;
}

export class SlashCommandService {
  private workspacePath: string;
  private userHomePath: string;
  private commandsCache = new Map<string, CachedSlashCommands>();
  private readonly CACHE_TTL = 5000; // 5 seconds

  constructor(workspacePath: string, options?: { userHomePath?: string }) {
    this.workspacePath = workspacePath;
    this.userHomePath = options?.userHomePath ?? homedir();
  }

  /**
   * Get the known built-in slash commands for a provider.
   * These are used as a fallback when the provider has no dynamic catalog.
   */
  private getKnownBuiltinCommands(provider: string): string[] {
    if (provider === 'openai-codex') {
      return [
        'compact',
        'diff',
        'init',
        'mcp',
        'review',
        'status',
      ];
    }

    return [
      'compact',
      'clear',
      'context',
      'cost',
      'init',
      'output-style:new',
      'pr-comments',
      'release-notes',
      'todos',
      'review',
      'security-review'
    ];
  }

  /**
   * List all available slash commands from provider-specific workspace sources.
   */
  async listCommands(options: SlashCommandDiscoveryOptions = {}): Promise<SlashCommand[]> {
    const {
      provider,
      sdkCommands = [],
      sdkSkills = [],
      pluginPaths = [],
    } = options;
    const resolvedProvider = provider ?? 'claude-code';

    // Check cache
    const now = Date.now();
    const cached = this.commandsCache.get(resolvedProvider);
    if (cached && (now - cached.cacheTime) < this.CACHE_TTL) {
      return this.mergeWithSdkEntries(cached.commands, resolvedProvider, sdkCommands, sdkSkills);
    }

    const commands: SlashCommand[] = [];
    if (resolvedProvider === 'openai-codex') {
      const projectSkills = await this.scanSkillsDirectory(
        path.join(this.workspacePath, '.agents', 'skills'),
        'project'
      );
      commands.push(...projectSkills);
    } else {
      const projectCommands = await this.scanCommandsDirectory(
        path.join(this.workspacePath, '.claude', 'commands'),
        'project'
      );
      commands.push(...projectCommands);

      const projectSkills = await this.scanSkillsDirectory(
        path.join(this.workspacePath, '.claude', 'skills'),
        'project'
      );
      commands.push(...projectSkills);

      const userCommandsPath = path.join(this.userHomePath, '.claude', 'commands');
      const userCommands = await this.scanCommandsDirectory(userCommandsPath, 'user');
      commands.push(...userCommands);

      const userSkillsPath = path.join(this.userHomePath, '.claude', 'skills');
      const userSkills = await this.scanSkillsDirectory(userSkillsPath, 'user');
      commands.push(...userSkills);

      const pluginSkillRoots = pluginPaths.length > 0
        ? pluginPaths
        : [path.join(this.userHomePath, '.claude', 'plugins')];
      const pluginSkills = await this.scanPluginSkillsDirectories(pluginSkillRoots);
      commands.push(...pluginSkills);
    }

    this.commandsCache.set(resolvedProvider, { commands, cacheTime: now });

    return this.mergeWithSdkEntries(commands, resolvedProvider, sdkCommands, sdkSkills);
  }

  /**
   * Merge scanned commands/skills with SDK-discovered entries.
   * SDK skills cover plugin-provided skills that are not present in local
   * .claude/skills directories, while scanned entries preserve descriptions and
   * user/project source metadata for local skills.
   */
  private mergeWithSdkEntries(
    customCommands: SlashCommand[],
    provider: string,
    sdkCommands: string[],
    sdkSkills: string[]
  ): SlashCommand[] {
    const builtinCommandNames = sdkCommands.length > 0
      ? sdkCommands
      : this.getKnownBuiltinCommands(provider);

    const builtinCommands: SlashCommand[] = builtinCommandNames.map(name => ({
      name,
      description: this.getBuiltinCommandDescription(name, provider),
      source: 'builtin' as const,
      kind: 'command' as const,
    }));

    const userVisibleCustomEntries = customCommands.filter(cmd => cmd.userInvocable !== false);
    const userVisibleNames = new Set(userVisibleCustomEntries.map(cmd => cmd.name));
    const sdkSkillEntries: SlashCommand[] = sdkSkills
      .filter(name => !userVisibleNames.has(name))
      .map(name => ({
        name,
        description: `Invoke the ${name} Claude skill`,
        source: 'plugin' as const,
        kind: 'skill' as const,
      }));

    const allCommands = [
      ...builtinCommands,
      ...userVisibleCustomEntries,
      ...sdkSkillEntries,
    ];

    // Remove duplicates while preserving the earliest source in the merged list.
    const seen = new Set<string>();
    return allCommands.filter(cmd => {
      if (seen.has(cmd.name)) {
        return false;
      }
      seen.add(cmd.name);
      return true;
    });
  }

  /**
   * Get description for provider-native commands.
   */
  private getBuiltinCommandDescription(name: string, provider: string): string {
    if (provider === 'openai-codex') {
      const descriptions: Record<string, string> = {
        'compact': 'Summarize the current conversation to free context while preserving key points',
        'diff': 'Show the current Git diff, including untracked files',
        'init': 'Generate an AGENTS.md scaffold for the current directory',
        'mcp': 'List the configured MCP tools available in this Codex session',
        'review': 'Ask Codex to review the current working tree',
        'status': 'Display active model, sandbox, and session token usage information',
      };
      return descriptions[name] || `Execute ${name} command`;
    }

    const descriptions: Record<string, string> = {
      'compact': 'Reduces conversation history by summarizing older messages',
      'clear': 'Start a new conversation session (in agent mode, stays attached to current workstream/worktree)',
      'context': 'Show context information about the current session',
      'cost': 'Display token usage and cost information for the session',
      'init': 'Initialize or reinitialize the Claude Code session',
      'output-style:new': 'Create a new custom output style configuration',
      'pr-comments': 'Generate pull request comments for code changes',
      'release-notes': 'Generate release notes from recent changes',
      'todos': 'Extract and manage TODO items from the codebase',
      'review': 'Perform code review on recent changes',
      'security-review': 'Conduct security analysis of the codebase'
    };
    return descriptions[name] || `Execute ${name} command`;
  }

  /**
   * Scan a directory for command files (recursively)
   * @param dirPath Path to commands directory
   * @param source Source type (project or user)
   * @returns List of parsed commands
   */
  private async scanCommandsDirectory(dirPath: string, source: 'project' | 'user'): Promise<SlashCommand[]> {
    const commands: SlashCommand[] = [];

    try {
      // Check if directory exists
      if (!fs.existsSync(dirPath)) {
        // console.log(`[SlashCommandService] Commands directory does not exist: ${dirPath}`);
        return commands;
      }

      // Recursively scan directory
      this.scanDirectoryRecursive(dirPath, dirPath, source, commands);
    } catch (error) {
      console.error(`[SlashCommandService] Error scanning directory ${dirPath}:`, error);
    }

    return commands;
  }

  /**
   * Scan a skills directory for `skills/<name>/SKILL.md` files.
   */
  private async scanSkillsDirectory(dirPath: string, source: 'project' | 'user'): Promise<SlashCommand[]> {
    const commands: SlashCommand[] = [];

    try {
      if (!fs.existsSync(dirPath)) {
        return commands;
      }

      this.scanSkillsRecursive(dirPath, dirPath, source, commands);
    } catch (error) {
      console.error(`[SlashCommandService] Error scanning skills directory ${dirPath}:`, error);
    }

    return commands;
  }

  /**
   * Scan installed Claude plugins for bundled skills so they are available in
   * typeahead before the SDK session finishes initializing.
   */
  private async scanPluginSkillsDirectories(dirPaths: string[]): Promise<SlashCommand[]> {
    const commands: SlashCommand[] = [];

    for (const dirPath of dirPaths) {
      try {
        if (!fs.existsSync(dirPath)) {
          continue;
        }

        this.scanPluginSkillsRecursive(dirPath, commands);
      } catch (error) {
        console.error(`[SlashCommandService] Error scanning plugin skills directory ${dirPath}:`, error);
      }
    }

    return commands;
  }

  /**
   * Recursively scan a directory for command files
   * @param currentPath Current directory being scanned
   * @param rootPath Root commands directory (for computing relative paths)
   * @param source Source type (project or user)
   * @param commands Array to collect commands
   */
  private scanDirectoryRecursive(
    currentPath: string,
    rootPath: string,
    source: 'project' | 'user',
    commands: SlashCommand[]
  ): void {
    try {
      const entries = fs.readdirSync(currentPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(currentPath, entry.name);

        if (isDirectoryEntry(entry, fullPath)) {
          // Recursively scan subdirectories (follows symlinks)
          this.scanDirectoryRecursive(fullPath, rootPath, source, commands);
        } else if (isFileEntry(entry, fullPath) && entry.name.endsWith('.md')) {
          // Process markdown files
          try {
            // Compute relative path from root for namespacing
            const relativePath = path.relative(rootPath, fullPath).replace(/\\/g, '/');
            const command = parseCommandFile(fullPath, source, relativePath);

            if (command && validateCommand(command)) {
              commands.push(command);
              // console.log(`[SlashCommandService] Loaded command: ${command.name} from ${source}`);
            } else {
              console.warn(`[SlashCommandService] Invalid command file: ${fullPath}`);
            }
          } catch (error) {
            console.error(`[SlashCommandService] Error parsing command file ${fullPath}:`, error);
          }
        }
      }
    } catch (error) {
      console.error(`[SlashCommandService] Error reading directory ${currentPath}:`, error);
    }
  }

  private scanSkillsRecursive(
    currentPath: string,
    rootPath: string,
    source: 'project' | 'user',
    commands: SlashCommand[]
  ): void {
    try {
      const entries = fs.readdirSync(currentPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(currentPath, entry.name);

        if (isDirectoryEntry(entry, fullPath)) {
          this.scanSkillsRecursive(fullPath, rootPath, source, commands);
        } else if (isFileEntry(entry, fullPath) && entry.name === 'SKILL.md') {
          try {
            const relativePath = path.relative(rootPath, fullPath).replace(/\\/g, '/');
            const command = parseSkillFile(fullPath, source, relativePath);

            if (command && validateCommand(command)) {
              commands.push(command);
            } else {
              console.warn(`[SlashCommandService] Invalid skill file: ${fullPath}`);
            }
          } catch (error) {
            console.error(`[SlashCommandService] Error parsing skill file ${fullPath}:`, error);
          }
        }
      }
    } catch (error) {
      console.error(`[SlashCommandService] Error reading skills directory ${currentPath}:`, error);
    }
  }

  private scanPluginSkillsRecursive(currentPath: string, commands: SlashCommand[]): void {
    try {
      const entries = fs.readdirSync(currentPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(currentPath, entry.name);

        if (isDirectoryEntry(entry, fullPath)) {
          this.scanPluginSkillsRecursive(fullPath, commands);
          continue;
        }

        if (!isFileEntry(entry, fullPath) || entry.name !== 'SKILL.md') {
          continue;
        }

        const skillsRootMarker = `${path.sep}skills${path.sep}`;
        const markerIndex = fullPath.lastIndexOf(skillsRootMarker);
        if (markerIndex === -1) {
          continue;
        }

        const relativePath = fullPath.slice(markerIndex + skillsRootMarker.length);
        try {
          const command = parseSkillFile(fullPath, 'plugin', relativePath);
          if (command && validateCommand(command) && command.userInvocable !== false) {
            commands.push(command);
          }
        } catch (error) {
          console.error(`[SlashCommandService] Error parsing plugin skill file ${fullPath}:`, error);
        }
      }
    } catch (error) {
      console.error(`[SlashCommandService] Error reading plugin skills directory ${currentPath}:`, error);
    }
  }

  /**
   * Clear the commands cache
   */
  clearCache(): void {
    this.commandsCache.clear();
  }

  /**
   * Get a specific command by name
   * @param name Command name (without "/")
   * @returns Command or null if not found
   */
  async getCommand(name: string, options: SlashCommandDiscoveryOptions = {}): Promise<SlashCommand | null> {
    const commands = await this.listCommands(options);
    return commands.find(cmd => cmd.name === name) || null;
  }
}
