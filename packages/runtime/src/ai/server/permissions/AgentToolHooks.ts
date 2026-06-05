/**
 * Centralized tool hooks service for agent providers
 *
 * Manages the full lifecycle of tool execution hooks:
 * - Pre-tool hooks: ExitPlanMode confirmation, file operation tracking
 * - Post-tool hooks: File system flush delays for watcher detection
 * - File tagging: Pre-edit tagging via HistoryManager for local history and diffs
 * - Turn snapshots: End-of-turn snapshot creation for all edited files
 *
 * This service consolidates hook logic previously in ClaudeCodeProvider,
 * making it reusable for OpenAI Codex and future agent providers.
 */

import path from 'path';
import fs from 'fs';
import { parseBashForFileOps, hasShellChainingOperators, splitOnShellOperators } from './BashCommandAnalyzer';
import { generateToolPattern, buildToolDescription } from './toolPermissionHelpers';
import { getPatternDisplayName } from '../types';
import type { TrustChecker } from '../providers/ProviderPermissionMixin';

/**
 * Configuration options for AgentToolHooks service
 */
export interface AgentToolHooksOptions {
  /**
   * Workspace path for file operations
   */
  workspacePath: string;

  /**
   * Session ID for logging and tracking
   */
  sessionId?: string;

  /**
   * Event emitter function for notifying about hook events
   */
  emit: (event: string, data: any) => void;

  /**
   * Function to log agent messages to database
   */
  logAgentMessage: (
    sessionId: string,
    source: string,
    direction: 'input' | 'output',
    content: string,
    metadata?: any
  ) => Promise<void>;

  /**
   * Security logging function
   */
  logSecurity: (message: string, data?: any) => void;

  /**
   * Function to check if a workspace is trusted
   */
  trustChecker?: TrustChecker;

  /**
   * Function to check if a pattern is approved in persisted settings
   */
  patternChecker?: (workspacePath: string, pattern: string) => Promise<boolean>;

  /**
   * Function to save an approved pattern to persisted settings
   */
  patternSaver?: (workspacePath: string, pattern: string) => Promise<void>;

  /**
   * Current mode ('planning' | 'agent' | 'auto')
   */
  getCurrentMode?: () => 'planning' | 'agent' | 'auto' | undefined;

  /**
   * Set current mode
   */
  setCurrentMode?: (mode: 'planning' | 'agent' | 'auto' | undefined) => void;

  /**
   * Get pending ExitPlanMode confirmations map
   */
  getPendingExitPlanModeConfirmations?: () => Map<string, {
    resolve: (value: { approved: boolean; clearContext?: boolean; feedback?: string }) => void;
    reject: (reason?: any) => void;
  }>;

  /**
   * Get session-approved patterns cache
   */
  getSessionApprovedPatterns?: () => Set<string>;

  /**
   * Get pending tool permissions map
   */
  getPendingToolPermissions?: () => Map<string, {
    resolve: (value: { decision: 'allow' | 'deny'; scope: 'once' | 'session' | 'always' | 'always-all' }) => void;
    reject: (reason?: any) => void;
    request: any;
  }>;

  /**
   * Delegate tool handling to TeammateManager
   */
  teammatePreToolHandler?: (
    toolName: string,
    toolInput: any,
    toolUseID: string | undefined,
    sessionId: string | undefined
  ) => Promise<{ handled: boolean; result?: any }>;

  /**
   * Check if this is a teammate session (skips permission prompts)
   */
  isTeammateSession?: boolean;

  /**
   * Path for permission checks (may differ from workspacePath for worktrees)
   */
  permissionsPath?: string;

  /**
   * History manager for creating file snapshots and tags
   * Optional - if not provided, snapshot creation will be skipped
   */
  historyManager?: {
    createSnapshot: (
      filePath: string,
      content: string,
      snapshotType: string,
      message: string,
      metadata?: any
    ) => Promise<void>;
    getPendingTags: (filePath: string) => Promise<Array<{ id: string; createdAt: Date; sessionId?: string }>>;
    tagFile: (workspacePath: string, filePath: string, tagId: string, content: string, metadata?: any) => Promise<void>;
    updateTagStatus: (filePath: string, tagId: string, status: string) => Promise<void>;
  };
}

/**
 * Centralized tool hooks service for agent providers
 */
export class AgentToolHooks {
  private readonly workspacePath: string;
  private readonly sessionId?: string;
  private readonly emit: (event: string, data: any) => void;
  private readonly logAgentMessage: (
    sessionId: string,
    source: string,
    direction: 'input' | 'output',
    content: string,
    metadata?: any
  ) => Promise<void>;
  private readonly logSecurity: (message: string, data?: any) => void;
  private readonly trustChecker?: TrustChecker;
  private readonly patternChecker?: (workspacePath: string, pattern: string) => Promise<boolean>;
  private readonly patternSaver?: (workspacePath: string, pattern: string) => Promise<void>;
  private readonly getCurrentMode?: () => 'planning' | 'agent' | 'auto' | undefined;
  private readonly setCurrentMode?: (mode: 'planning' | 'agent' | 'auto' | undefined) => void;
  private readonly getPendingExitPlanModeConfirmations?: () => Map<string, {
    resolve: (value: { approved: boolean; clearContext?: boolean; feedback?: string }) => void;
    reject: (reason?: any) => void;
  }>;
  private readonly getSessionApprovedPatterns?: () => Set<string>;
  private readonly getPendingToolPermissions?: () => Map<string, {
    resolve: (value: { decision: 'allow' | 'deny'; scope: 'once' | 'session' | 'always' | 'always-all' }) => void;
    reject: (reason?: any) => void;
    request: any;
  }>;
  private readonly teammatePreToolHandler?: (
    toolName: string,
    toolInput: any,
    toolUseID: string | undefined,
    sessionId: string | undefined
  ) => Promise<{ handled: boolean; result?: any }>;
  private readonly isTeammateSession: boolean;
  private readonly permissionsPath?: string;
  private readonly historyManager?: {
    createSnapshot: (filePath: string, content: string, snapshotType: string, message: string, metadata?: any) => Promise<void>;
    getPendingTags: (filePath: string) => Promise<Array<{ id: string; createdAt: Date; sessionId?: string }>>;
    tagFile: (workspacePath: string, filePath: string, tagId: string, content: string, metadata?: any) => Promise<void>;
    updateTagStatus: (filePath: string, tagId: string, status: string) => Promise<void>;
  };

  /**
   * Track files edited during current turn for snapshot creation
   */
  private readonly editedFilesThisTurn: Set<string> = new Set();

  constructor(options: AgentToolHooksOptions) {
    this.workspacePath = options.workspacePath;
    this.sessionId = options.sessionId;
    this.emit = options.emit;
    this.logAgentMessage = options.logAgentMessage;
    this.logSecurity = options.logSecurity;
    this.trustChecker = options.trustChecker;
    this.patternChecker = options.patternChecker;
    this.patternSaver = options.patternSaver;
    this.getCurrentMode = options.getCurrentMode;
    this.setCurrentMode = options.setCurrentMode;
    this.getPendingExitPlanModeConfirmations = options.getPendingExitPlanModeConfirmations;
    this.getSessionApprovedPatterns = options.getSessionApprovedPatterns;
    this.getPendingToolPermissions = options.getPendingToolPermissions;
    this.teammatePreToolHandler = options.teammatePreToolHandler;
    this.isTeammateSession = options.isTeammateSession || false;
    this.permissionsPath = options.permissionsPath;
    this.historyManager = options.historyManager;
  }

  /**
   * Clear edited files tracker for a new turn
   */
  clearEditedFiles(): void {
    this.editedFilesThisTurn.clear();
  }

  /**
   * Get the set of files edited during this turn
   */
  getEditedFiles(): Set<string> {
    return this.editedFilesThisTurn;
  }

  /**
   * Create a pre-tool-use hook for the Claude Code SDK
   *
   * This hook handles:
   * - Teammate tool delegation
   * - ExitPlanMode confirmation in planning mode
   * - Bash file operation tracking and tagging
   * - Compound Bash command security checks
   * - Pre-edit file tagging for Edit/Write/MultiEdit
   */
  createPreToolUseHook() {
    const pathForTrust = this.permissionsPath || this.workspacePath;

    return async (input: any, toolUseID: string | undefined, options: { signal: AbortSignal }) => {
      const toolName = input.tool_name;
      const toolInput = input.tool_input;

      // TeamDelete should be validated by the SDK against active team members.
      // Do not pre-clean teammates here, or TeamDelete will incorrectly succeed.

      // MANAGED TEAMMATES: Delegate Task-spawn and SendMessage routing to TeammateManager
      if (!this.isTeammateSession && this.teammatePreToolHandler) {
        const teammateResult = await this.teammatePreToolHandler(toolName, toolInput, toolUseID, this.sessionId);
        if (teammateResult.handled) {
          return teammateResult.result;
        }
      }

      // EXITPLANMODE CONFIRMATION: Intercept ExitPlanMode tool calls in planning mode
      if (toolName === 'ExitPlanMode' && this.getCurrentMode?.() === 'planning') {
        return await this.handleExitPlanModeConfirmation(toolInput, toolUseID, options);
      }

      // NOTE: Bash file pre-tagging was removed to eliminate race conditions with
      // watcher-based attribution (WorkspaceFileEditAttributionService). The watcher
      // attribution service is now the single source of truth for pending diff tags.
      // Bash editedFilesThisTurn tracking is handled in createPostToolUseHook() instead.

      // SECURITY: Check each part of compound Bash commands separately
      // Claude's pattern matching (e.g., Bash(git add:*)) can be bypassed with chained commands
      // like "git add file && rm -rf /". PreToolUse runs BEFORE SDK's allow rules, so we can catch this.
      // See: https://github.com/anthropics/claude-code/issues/4956
      if (toolName === 'Bash') {
        // In bypass-all mode, skip compound command checking entirely
        if (pathForTrust && this.trustChecker) {
          const trustStatus = this.trustChecker(pathForTrust);
          if (trustStatus.trusted && trustStatus.mode === 'bypass-all') {
            return {};
          }
        }

        // In Auto session mode, the SDK classifier is the sole decision-maker
        // for Bash. Running our compound-bash splitter here would preempt the
        // classifier and surface a Nimbalyst permission prompt for benign
        // sub-commands (cd, echo, npx ...) that the classifier would have
        // approved silently. Defer to the classifier; if it denies, the
        // PermissionDenied hook will re-prompt with the classifier's reason.
        if (this.getCurrentMode?.() === 'auto') {
          return {};
        }

        const compoundResult = await this.handleCompoundBashCommand(toolInput, options);
        if (compoundResult) {
          return compoundResult;
        }
      }

      // WebFetch/WebSearch: Let SDK handle via canUseTool
      // The SDK reads settings.json and calls canUseTool when permission is needed
      if (toolName === 'WebFetch' || toolName === 'WebSearch') {
        this.logSecurity(`[PreToolUse] ${toolName} - deferring to SDK/canUseTool`);
        return {};
      }

      // Bash: Continue to canUseTool for permission checking
      // (File operation tracking happens earlier in this function)
      if (toolName === 'Bash') {
        return {};
      }

      // Handle non-file-editing tools (except ExitPlanMode which is handled above)
      // Return empty object to let the request continue through permission flow to canUseTool
      if (toolName !== 'Edit' && toolName !== 'Write' && toolName !== 'MultiEdit') {
        return {};
      }

      // Handle Edit/Write/MultiEdit file operations
      return await this.handleFileEditOperations(toolName, toolInput, toolUseID, options);
    };
  }

  /**
   * Create a permission-denied hook for the Claude Code SDK.
   *
   * Auto-mode classifier sometimes blocks a tool on its own without escalating
   * through `canUseTool`. The SDK then emits a `permission_denied` system
   * message and the tool fails. Claude Code CLI mirrors this case by asking
   * the user to approve the original call -- this hook reproduces that flow
   * inside Nimbalyst.
   *
   * Behaviour:
   * - Only re-prompts when the session is in `auto` mode.
   * - Shows the regular ToolPermission widget with the classifier reason as
   *   a warning so the user knows why the model flagged the call.
   * - If the user approves, returns `retry: true` so the SDK re-runs the
   *   original tool call; if the user denies (or aborts), returns `{}` and
   *   the SDK's original denial stands.
   *
   * Outside auto mode we return `{}` so deny rules, `dontAsk` mode, and
   * headless auto-deny keep their existing terminal behaviour.
   */
  createPermissionDeniedHook() {
    return async (input: any, _toolUseID: string | undefined, options: { signal: AbortSignal }) => {
      if (this.getCurrentMode?.() !== 'auto') {
        return {};
      }

      const toolName = input.tool_name as string;
      const toolInput = input.tool_input;
      const classifierReason = input.reason as string | undefined;

      const getPendingToolPermissions = this.getPendingToolPermissions;
      if (!getPendingToolPermissions) {
        return {};
      }

      const requestId = `auto-denied-${this.sessionId || 'unknown'}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const pattern = generateToolPattern(toolName, toolInput);
      const toolDescription = buildToolDescription(toolName, toolInput);
      const patternDisplay = getPatternDisplayName(pattern);
      const rawCommand = toolName === 'Bash' ? (toolInput?.command || '') : toolDescription;
      const isDestructive = ['Write', 'Edit', 'MultiEdit', 'Bash'].includes(toolName);
      const warnings = classifierReason
        ? [`Auto-mode classifier flagged this call: ${classifierReason}`]
        : ['Auto-mode classifier requested user approval before running this tool.'];

      this.logSecurity('[PermissionDenied] Auto-mode denied tool, re-prompting user:', {
        toolName,
        classifierReason,
      });

      const request = {
        id: requestId,
        toolName,
        rawCommand,
        actionsNeedingApproval: [{
          action: {
            pattern,
            displayName: toolDescription,
            command: toolName === 'Bash' ? rawCommand : '',
            isDestructive,
            referencedPaths: [],
            hasRedirection: false,
          },
          decision: 'ask' as const,
          reason: classifierReason || 'Auto-mode classifier requested user approval',
          isDestructive,
          isRisky: true,
          warnings,
          outsidePaths: [],
          sensitivePaths: [],
        }],
        hasDestructiveActions: isDestructive,
        createdAt: Date.now(),
      };

      if (this.sessionId) {
        await this.logAgentMessage(
          this.sessionId,
          'claude-code',
          'output',
          JSON.stringify({
            type: 'nimbalyst_tool_use',
            id: requestId,
            name: 'ToolPermission',
            input: {
              requestId,
              toolName,
              rawCommand,
              pattern,
              patternDisplayName: patternDisplay,
              isDestructive,
              warnings,
              workspacePath: this.workspacePath,
            }
          })
        );
      }

      const responsePromise = new Promise<{
        decision: 'allow' | 'deny';
        scope: 'once' | 'session' | 'always' | 'always-all';
      }>((resolve, reject) => {
        getPendingToolPermissions().set(requestId, { resolve, reject, request });

        if (options.signal) {
          options.signal.addEventListener('abort', () => {
            getPendingToolPermissions().delete(requestId);
            reject(new Error('Request aborted'));
          }, { once: true });
        }
      });

      this.emit('toolPermission:pending', {
        requestId,
        sessionId: this.sessionId,
        workspacePath: this.workspacePath,
        request,
        timestamp: Date.now(),
      });

      try {
        const response = await responsePromise;

        this.emit('toolPermission:resolved', {
          requestId,
          sessionId: this.sessionId,
          response,
          timestamp: Date.now(),
        });

        if (response.decision !== 'allow') {
          return {};
        }

        // Cache session-scoped approvals so the same call is not blocked again
        // mid-turn. Compound bash patterns intentionally skip caching there;
        // here the pattern is for the whole tool call, so the same rule
        // applies: only cache when the user opted for a broader scope.
        if (response.scope !== 'once' && this.getSessionApprovedPatterns) {
          this.getSessionApprovedPatterns().add(pattern);
        }

        if ((response.scope === 'always' || response.scope === 'always-all') && this.patternSaver) {
          try {
            const patternToSave =
              response.scope === 'always-all' && toolName === 'WebFetch' ? 'WebFetch' : pattern;
            await this.patternSaver(this.workspacePath, patternToSave);
          } catch (saveError) {
            console.error('[AGENT-HOOKS] PermissionDenied: failed to persist pattern:', saveError);
          }
        }

        return {
          hookSpecificOutput: {
            hookEventName: 'PermissionDenied' as const,
            retry: true,
          },
        };
      } catch (error) {
        this.emit('toolPermission:resolved', {
          requestId,
          sessionId: this.sessionId,
          response: { decision: 'deny', scope: 'once' },
          timestamp: Date.now(),
        });
        this.logSecurity('[PermissionDenied] Re-prompt failed or aborted:', {
          toolName,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
        return {};
      }
    };
  }

  /**
   * Create a post-tool-use hook for the Claude Code SDK
   *
   * This hook adds delays to ensure file system has flushed writes,
   * giving file watchers time to detect changes.
   */
  createPostToolUseHook() {
    return async (input: any, toolUseID: string | undefined, options: { signal: AbortSignal }) => {
      const toolName = input.tool_name;
      const toolInput = input.tool_input;

      // Handle Bash file operations
      if (toolName === 'Bash') {
        const command = (toolInput?.command as string) || '';
        const cwd = this.workspacePath || process.cwd();

        // Check if this Bash command affected any files
        const affectedFiles = parseBashForFileOps(command, cwd);

        if (affectedFiles.length > 0) {
          // Track affected files for turn-end snapshots (local history).
          // This was previously done in the pre-tool hook, but pre-tagging was removed
          // to avoid racing with watcher-based attribution for diff baselines.
          for (const filePath of affectedFiles) {
            this.editedFilesThisTurn.add(filePath);
          }

          // Add delay for file watcher to detect changes from Bash operations
          // Same delay as Edit/Write/MultiEdit to ensure consistent behavior
          await new Promise(resolve => setTimeout(resolve, 200));

          console.log('[BASH-FILE-OPS] PostToolUse delay complete, files should be visible to watcher:', {
            count: affectedFiles.length,
            files: affectedFiles.map((f: string) => path.basename(f))
          });
        }

        return {};
      }

      // Only care about file editing tools
      if (toolName !== 'Edit' && toolName !== 'Write' && toolName !== 'MultiEdit') {
        return {};
      }

      // Small delay to ensure file system has flushed the write
      // This gives chokidar time to detect the change and trigger diff update
      // Increased from 50ms to 200ms to ensure file watcher can process each edit
      await new Promise(resolve => setTimeout(resolve, 200));

      return {};
    };
  }

  /**
   * Create 'ai-edit' snapshots for all files edited during this turn
   * Called at the end of the agent's turn, before yielding completion
   */
  async createTurnEndSnapshots(): Promise<void> {
    for (const filePath of this.editedFilesThisTurn) {
      try {
        // Read the final content after all edits this turn
        let finalContent = '';
        try {
          finalContent = fs.readFileSync(filePath, 'utf-8');
        } catch (error) {
          console.warn(`[AGENT-HOOKS] Turn-end snapshot: Could not read file:`, filePath);
          continue;
        }

        // Save as 'ai-edit' snapshot in history
        // The sessionId is stored in snapshot metadata so the HistoryDialog can display
        // which AI session made the edit and provide a clickable link to open that session
        try {
          if (this.historyManager) {
            await this.historyManager.createSnapshot(
              filePath,
              finalContent,
              'ai-edit',
              `AI edit turn complete (session: ${this.sessionId || 'unknown'})`,
              this.sessionId ? { sessionId: this.sessionId } : undefined
            );
          }
        } catch (importError) {
          console.warn('[AGENT-HOOKS] Could not create snapshot:', importError);
        }
      } catch (error) {
        console.error(`[AGENT-HOOKS] Failed to create turn-end snapshot for ${filePath}:`, error);
      }
    }
  }

  /**
   * Tag a file's current state before an AI edit
   * @param isNewFile - If true, the file doesn't exist yet (being created), so use empty content
   */
  async tagFileBeforeEdit(
    filePath: string,
    toolUseId: string,
    isNewFile: boolean = false
  ): Promise<void> {
    try {
      // Use historyManager if available
      if (this.historyManager) {
        // CRITICAL: Check if there are already pending tags for this file
        // If yes, skip creating a new tag - we want to show ALL edits together as one diff
        const pendingTags = await this.historyManager.getPendingTags(filePath);

        if (pendingTags && pendingTags.length > 0) {
          const existingTag = pendingTags[0];
          const tagAge = Date.now() - existingTag.createdAt.getTime();

          // Check if the pending tag is from the current session
          if (existingTag.sessionId === this.sessionId) {
            // Same session - skip creating another (existing behavior)
            // console.log('[PRE-EDIT SKIP]', JSON.stringify({
            //   file: path.basename(filePath),
            //   existingTagAge: tagAge + 'ms',
            //   existingTagId: existingTag.id,
            //   reason: 'same_session_tag',
            // }));
            return;
          }

          // Different session - clear the old tag and create a new one
          // This prevents edits from multiple sessions accumulating into one diff
          // console.log('[PRE-EDIT CLEAR]', JSON.stringify({
          //   file: path.basename(filePath),
          //   clearedTagId: existingTag.id,
          //   clearedSessionId: existingTag.sessionId,
          //   newSessionId: this.sessionId,
          //   reason: 'different_session',
          // }));
          await this.historyManager.updateTagStatus(filePath, existingTag.id, 'reviewed');
        }

        const tagId = `ai-edit-pending-${this.sessionId || 'unknown'}-${toolUseId}`;
        // console.log('[PRE-EDIT TAG]', JSON.stringify({
        //   file: path.basename(filePath),
        //   tagId,
        //   isNewFile,
        // }));

        // Get content: empty for new files, current content for existing files
        const content = isNewFile ? '' : fs.readFileSync(filePath, 'utf-8');

        await this.historyManager.tagFile(
          this.workspacePath,
          filePath,
          tagId,
          content,
          {
            sessionId: this.sessionId || 'unknown',
            toolUseId,
          }
        );

        // Small delay to ensure tag is committed to database before next edit check
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    } catch (error) {
      // Check if this is a unique constraint violation (expected if tag already exists)
      const errorStr = String(error);
      if (errorStr.includes('unique') || errorStr.includes('UNIQUE') || errorStr.includes('duplicate')) {
        // This is fine - means another rapid edit already created the tag
        return;
      }
      console.error('[AGENT-HOOKS] PreToolUse: Failed to tag file:', error);
      // Don't throw - allow the edit to proceed even if tagging fails
    }
  }

  /**
   * Handle ExitPlanMode confirmation in planning mode
   */
  private async handleExitPlanModeConfirmation(
    toolInput: any,
    toolUseID: string | undefined,
    options: { signal: AbortSignal }
  ) {
    if (!this.getPendingExitPlanModeConfirmations) {
      return {};
    }

    // planFilePath is optional - used for "Start new session to implement" option
    const planFilePath = toolInput?.planFilePath || '';

    if (!planFilePath) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse' as const,
          permissionDecision: 'deny' as const,
          permissionDecisionReason: 'ExitPlanMode requires the planFilePath argument. Try ExitPlanMode again and include the fully qualified plan file path.'
        }
      };
    }

    // Use the SDK's tool_use ID as the request ID so the widget can match it via toolCall.id
    const requestId = toolUseID || `exit-plan-${this.sessionId}-${Date.now()}`;
    const planSummary = toolInput?.plan || '';

    // Create a promise that will be resolved when user responds
    const confirmationPromise = new Promise<{ approved: boolean; clearContext?: boolean; feedback?: string }>((resolve, reject) => {
      this.getPendingExitPlanModeConfirmations!().set(requestId, { resolve, reject });

      // Set up abort handler - persist cancellation to DB to avoid orphaned pending prompts
      if (options.signal) {
        options.signal.addEventListener('abort', () => {
          this.getPendingExitPlanModeConfirmations!().delete(requestId);
          if (this.sessionId) {
            const cancelContent = {
              type: 'exit_plan_mode_response' as const,
              requestId,
              approved: false,
              cancelled: true,
              respondedAt: Date.now(),
              respondedBy: 'system',
            };
            this.logAgentMessage(
              this.sessionId, 'claude-code', 'output',
              JSON.stringify(cancelContent),
              { messageType: 'exit_plan_mode_response' }
            ).catch(() => {});
          }
          reject(new Error('Request aborted'));
        }, { once: true });
      }
    });

    // Persist the ExitPlanMode request as a message for durable prompts
    // This allows the confirmation to survive session switches and app restarts
    const exitPlanModeContent = {
      type: 'exit_plan_mode_request' as const,
      requestId,
      planSummary,
      planFilePath,
      timestamp: Date.now(),
      status: 'pending' as const,
    };

    if (this.sessionId) {
      await this.logAgentMessage(
        this.sessionId,
        'claude-code',
        'output',
        JSON.stringify(exitPlanModeContent),
        { messageType: 'exit_plan_mode_request' }
      );
    }

    // Emit event to notify renderer to show confirmation UI
    this.emit('exitPlanMode:confirm', {
      requestId,
      sessionId: this.sessionId,
      planSummary,
      planFilePath,
      timestamp: Date.now()
    });

    try {
      const response = await confirmationPromise;

      if (response.approved) {
        // User approved - update mode state and allow ExitPlanMode to proceed
        if (this.setCurrentMode) {
          this.setCurrentMode('agent');
        }

        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse' as const,
            permissionDecision: 'allow' as const
          }
        };
      } else {
        // User denied - keep in planning mode
        // Include feedback in the denial reason if provided
        const feedbackText = response.feedback
          ? `\n\nUser feedback: "${response.feedback}"`
          : '';
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse' as const,
            permissionDecision: 'deny' as const,
            permissionDecisionReason: `The user chose to continue planning.${feedbackText}`
          }
        };
      }
    } catch (error) {
      // Handle abort or other errors
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse' as const,
          permissionDecision: 'deny' as const,
          permissionDecisionReason: `ExitPlanMode was cancelled or interrupted.`
        }
      };
    }
  }

  /**
   * Handle compound Bash command security checks
   */
  private async handleCompoundBashCommand(
    toolInput: any,
    options: { signal: AbortSignal }
  ): Promise<any | null> {
    const command = (toolInput?.command as string) || '';

    // Use quote-aware detection to avoid false positives on heredocs/quoted strings
    if (!hasShellChainingOperators(command)) {
      return null; // Not a compound command
    }

    if (!this.getSessionApprovedPatterns || !this.getPendingToolPermissions) {
      return null; // Can't check permissions without these
    }

    this.logSecurity(`[PreToolUse] Compound Bash command detected, checking each part:`, { command: command.slice(0, 100) });

    // Split on unquoted &&, ||, ; while respecting quotes and heredocs
    const subCommands = splitOnShellOperators(command);

    // Check each sub-command
    for (const subCommand of subCommands) {
      const subPattern = generateToolPattern('Bash', { command: subCommand });

      // Skip if already approved in session
      if (this.getSessionApprovedPatterns().has(subPattern)) {
        this.logSecurity(`[PreToolUse] Sub-command already approved in session:`, { subCommand: subCommand.slice(0, 50), pattern: subPattern });
        continue;
      }

      // Also check if pattern is in persisted settings (would be auto-approved by SDK)
      if (this.patternChecker) {
        try {
          const isAllowed = await this.patternChecker(this.workspacePath, subPattern);
          if (isAllowed) {
            this.logSecurity(`[PreToolUse] Sub-command allowed by settings:`, { subCommand: subCommand.slice(0, 50), pattern: subPattern });
            // Add to session cache so we don't check file again
            this.getSessionApprovedPatterns().add(subPattern);
            continue;
          }
        } catch (e) {
          // If check fails, proceed to ask user
          this.logSecurity(`[PreToolUse] Failed to check settings:`, { error: e });
        }
      }

      // Need to check this sub-command - use permission flow
      this.logSecurity(`[PreToolUse] Sub-command needs approval:`, { subCommand: subCommand.slice(0, 50), pattern: subPattern });

      const requestId = `compound-${this.sessionId || 'unknown'}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const subDescription = `Part of compound command: ${subCommand.slice(0, 60)}${subCommand.length > 60 ? '...' : ''}`;

      // Create permission request for this sub-command
      const request = {
        id: requestId,
        toolName: 'Bash',
        rawCommand: subCommand,
        actionsNeedingApproval: [{
          action: {
            pattern: subPattern,
            displayName: subDescription,
            command: subCommand,
            isDestructive: true,
            referencedPaths: [],
            hasRedirection: false,
          },
          decision: 'ask' as const,
          reason: 'Sub-command of compound command requires approval',
          isDestructive: true,
          isRisky: true,
          warnings: ['This is part of a compound command - each part is checked separately'],
          outsidePaths: [],
          sensitivePaths: [],
        }],
        hasDestructiveActions: true,
        createdAt: Date.now(),
      };

      // Log as nimbalyst_tool_use so SessionManager creates a toolCall for ToolPermissionWidget rendering
      if (this.sessionId) {
        const patternDisplay = getPatternDisplayName(subPattern);
        await this.logAgentMessage(
          this.sessionId,
          'claude-code',
          'output',
          JSON.stringify({
            type: 'nimbalyst_tool_use',
            id: requestId,
            name: 'ToolPermission',
            input: {
              requestId,
              toolName: 'Bash',
              rawCommand: subCommand,
              pattern: subPattern,
              patternDisplayName: patternDisplay,
              isDestructive: true,
              warnings: ['This is part of a compound command - each part is checked separately'],
              workspacePath: this.workspacePath,
            }
          })
        );
      }

      // Wait for user approval
      const responsePromise = new Promise<{ decision: 'allow' | 'deny'; scope: 'once' | 'session' | 'always' | 'always-all' }>((resolve, reject) => {
        this.getPendingToolPermissions!().set(requestId, { resolve, reject, request });
      });

      // Emit event to show permission UI
      this.emit('toolPermission:pending', {
        requestId,
        sessionId: this.sessionId,
        workspacePath: this.workspacePath,
        request,
        timestamp: Date.now()
      });

      try {
        const response = await responsePromise;

        // Emit resolved event so the renderer clears the "waiting for input" indicator
        this.emit('toolPermission:resolved', {
          requestId,
          sessionId: this.sessionId,
          response,
          timestamp: Date.now()
        });

        if (response.decision === 'deny') {
          this.logSecurity(`[PreToolUse] Sub-command denied:`, { subCommand: subCommand.slice(0, 50) });
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse' as const,
              permissionDecision: 'deny' as const,
              permissionDecisionReason: `Command denied: ${subCommand.slice(0, 50)}`
            }
          };
        }

        // Cache approval if not 'once'
        if (response.scope !== 'once') {
          this.getSessionApprovedPatterns().add(subPattern);
          this.logSecurity(`[PreToolUse] Sub-command approved and cached:`, { pattern: subPattern, scope: response.scope });
        }

        // Save to settings if 'always'
        if (response.scope === 'always' && this.patternSaver) {
          try {
            await this.patternSaver(this.workspacePath, subPattern);
          } catch (e) {
            console.error('[AGENT-HOOKS] Failed to save pattern:', e);
          }
        }
      } catch (error) {
        // Emit resolved event on error path too, so the indicator is cleared
        this.emit('toolPermission:resolved', {
          requestId,
          sessionId: this.sessionId,
          response: { decision: 'deny', scope: 'once' },
          timestamp: Date.now()
        });
        this.logSecurity(`[PreToolUse] Sub-command permission failed:`, { error });
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse' as const,
            permissionDecision: 'deny' as const,
            permissionDecisionReason: `Permission check failed for: ${subCommand.slice(0, 50)}`
          }
        };
      }
    }

    // All sub-commands approved, allow the compound command
    this.logSecurity(`[PreToolUse] All sub-commands approved, allowing compound command`);
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse' as const,
        permissionDecision: 'allow' as const
      }
    };
  }

  /**
   * Handle Edit/Write/MultiEdit file operations: validate and tag
   */
  private async handleFileEditOperations(
    toolName: string,
    toolInput: any,
    toolUseID: string | undefined,
    options: { signal: AbortSignal }
  ): Promise<any> {
    try {
      // Extract file paths from tool arguments
      const filePaths: string[] = [];
      if (toolName === 'Edit' || toolName === 'Write') {
        const filePath = toolInput.file_path || toolInput.filePath;
        if (filePath) {
          filePaths.push(filePath);
        }
      } else if (toolName === 'MultiEdit') {
        // MultiEdit might have multiple files - tag each one
        const edits = toolInput.edits || [];
        for (const edit of edits) {
          const editFilePath = edit.file_path || edit.filePath;
          if (editFilePath) {
            filePaths.push(editFilePath);
          }
        }
      }

      // Note: Planning mode file type restrictions are now handled natively by the SDK
      // via `permissionMode: 'plan'` which scopes Write to the plan file only.

      // Tag each file and track for end-of-turn snapshot
      for (let filePath of filePaths) {
        if (!filePath) continue;

        // Make file path absolute if relative
        if (!path.isAbsolute(filePath)) {
          filePath = path.join(this.workspacePath, filePath);
        }

        // Track this file as edited during this turn
        this.editedFilesThisTurn.add(filePath);

        // Create unique tag ID for this edit
        const actualToolUseId = toolUseID || `tool-${Date.now()}`;

        // Read current file content (if file exists)
        // For new files, we create a pre-edit tag with empty content to enable diff mode
        try {
          fs.readFileSync(filePath, 'utf-8');
          // File exists - tag with current content
          await this.tagFileBeforeEdit(filePath, actualToolUseId);
        } catch (error) {
          // File doesn't exist yet (Write tool creating new file)
          // Create a pre-edit tag with empty content so diff mode shows the full new file
          await this.tagFileBeforeEdit(filePath, actualToolUseId, true);
        }
      }

    } catch (error) {
      console.error('[AGENT-HOOKS] PreToolUse hook error:', error);
      // Don't block the edit if tagging fails
    }

    // Return empty object to let the request continue through permission flow to canUseTool
    // This allows our permission engine to check workspace trust and ask for approval
    return {};
  }
}
