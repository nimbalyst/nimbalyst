/**
 * Permission evaluation logic for agent providers
 *
 * Determines whether a tool/command should be allowed based on:
 * - Workspace trust status
 * - Permission mode (ask/allow-all/bypass-all)
 * - Pattern matching against approved patterns
 *
 * This centralizes the decision-making logic used by both ClaudeCodeProvider
 * and OpenAICodexProvider when evaluating tool permissions.
 */

import {
  PermissionMode,
  TrustChecker,
  PermissionPatternChecker,
} from '../providers/ProviderPermissionMixin';

/**
 * Configuration options for PermissionEvaluator
 */
export interface PermissionEvaluatorOptions {
  /**
   * Function to check if a workspace is trusted and get its permission mode
   */
  trustChecker: TrustChecker;

  /**
   * Function to check if a pattern is approved in persisted settings
   */
  patternChecker: PermissionPatternChecker;
}

/**
 * Trust check result
 */
export interface TrustCheckResult {
  /**
   * Whether the workspace is trusted
   */
  trusted: boolean;

  /**
   * Permission mode for this workspace
   */
  mode: PermissionMode;
}

/**
 * Evaluates tool permissions based on trust status and approved patterns
 */
export class PermissionEvaluator {
  private readonly trustChecker: TrustChecker;
  private readonly patternChecker: PermissionPatternChecker;

  constructor(options: PermissionEvaluatorOptions) {
    this.trustChecker = options.trustChecker;
    this.patternChecker = options.patternChecker;
  }

  /**
   * Check if workspace is trusted and return permission mode
   *
   * @param workspacePath - Path to the workspace to check
   * @returns Trust status and permission mode
   */
  checkTrust(workspacePath: string): TrustCheckResult {
    const trustStatus = this.trustChecker(workspacePath);
    return {
      trusted: trustStatus.trusted,
      mode: trustStatus.mode,
    };
  }

  /**
   * Check if pattern is in session cache or persisted settings
   *
   * @param workspacePath - Path to the workspace
   * @param pattern - Permission pattern to check (e.g., 'Bash(git commit:*)')
   * @param sessionCache - Session-level cache of approved patterns
   * @returns True if pattern is approved
   */
  async isPatternApproved(
    workspacePath: string,
    pattern: string,
    sessionCache: Set<string>
  ): Promise<boolean> {
    // Check session cache first (fast path)
    if (sessionCache.has(pattern)) {
      return true;
    }

    // Check persisted settings (slower, requires file read)
    return await this.patternChecker(workspacePath, pattern);
  }

  /**
   * Determine if we need to prompt user for permission
   *
   * Takes into account:
   * - Trust mode (bypass-all auto-approves everything)
   * - Whether pattern is already approved
   *
   * @param trustMode - Permission mode for the workspace
   * @param patternApproved - Whether the pattern is already approved
   * @returns True if user should be prompted
   */
  shouldPromptUser(
    trustMode: PermissionMode,
    patternApproved: boolean
  ): boolean {
    // Bypass-all mode: never prompt
    if (trustMode === 'bypass-all') {
      return false;
    }

    // Pattern already approved: don't prompt
    if (patternApproved) {
      return false;
    }

    // Otherwise, prompt is needed
    return true;
  }

  /**
   * Check if a specific tool should be auto-approved in allow-all mode
   *
   * Allow-all mode auto-approves file edit operations but still requires
   * approval for potentially dangerous operations like Bash commands and
   * web requests.
   *
   * @param toolName - Name of the tool to check
   * @returns True if tool should be auto-approved in allow-all mode
   */
  isFileEditTool(toolName: string): boolean {
    const fileEditTools = [
      'Edit',
      'Write',
      'MultiEdit',
      'Read',
      'Glob',
      'Grep',
      'LS',
      'NotebookEdit'
    ];
    return fileEditTools.includes(toolName);
  }

  /**
   * Check if a tool is an internal Nimbalyst MCP tool that should always be allowed
   *
   * These tools are either:
   * - Read-only (e.g., screenshot capture)
   * - Display-only (e.g., display_to_user)
   * - Interactive widgets where user confirms within the widget (e.g., git commit proposal)
   *
   * @param toolName - Name of the tool to check
   * @returns True if tool is an internal MCP tool
   */
  isInternalMcpTool(toolName: string): boolean {
    const internalMcpTools = [
      // Eager core (`nimbalyst`).
      'mcp__nimbalyst__update_session_meta',
      'mcp__nimbalyst__capture_editor_screenshot',
      'mcp__nimbalyst__display_to_user',
      'mcp__nimbalyst__get_session_edited_files',
      'mcp__nimbalyst__developer_git_commit_proposal',
      // git_log is served by the built-in Developer Tools extension, so it
      // carries the extension prefix (not core). Read-only → safe to auto-allow.
      'mcp__nimbalyst-developer__developer_git_log',
      // Situational (`nimbalyst-situational`) — voice.
      'mcp__nimbalyst-situational__voice_agent_speak',
      'mcp__nimbalyst-situational__voice_agent_stop',
    ];
    return internalMcpTools.includes(toolName);
  }

  /**
   * Check if a tool is an agent team coordination tool
   *
   * These tools are SDK-native and used for team coordination and task management.
   * They should always be allowed without permission prompts.
   *
   * @param toolName - Name of the tool to check
   * @returns True if tool is a team coordination tool
   */
  isTeamCoordinationTool(toolName: string): boolean {
    const teamTools = [
      'SendMessage',
      'TaskCreate',
      'TaskList',
      'TaskUpdate',
      'TaskGet',
      'TeamCreate',
      'TeamDelete',
      'TeammateTool',
      'TodoRead',
      'TodoWrite'
    ];
    return teamTools.includes(toolName);
  }
}
