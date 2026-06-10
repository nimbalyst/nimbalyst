/**
 * Claude Code provider using claude-agent-sdk with MCP support
 * Uses bundled SDK from package dependencies
 */

import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';

// Query interface not properly exported by SDK, so we define it inline
interface Query extends AsyncGenerator<SDKMessage, void> {
  interrupt(): Promise<void>;
  setPermissionMode(mode: string): Promise<void>;
  setModel(model?: string): Promise<void>;
  streamInput(stream: AsyncIterable<any>): Promise<void>;
  mcpServerStatus(): Promise<McpServerStatusInfo[]>;
  reconnectMcpServer(serverName: string): Promise<void>;
}

/** MCP server status as reported by the SDK */
export interface McpServerStatusInfo {
  name: string;
  status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled';
  error?: string;
  serverInfo?: { name: string; version: string };
  tools?: { name: string; description?: string }[];
}
import { parse as parseShellCommand } from 'shell-quote';

import { BaseAgentProvider } from './BaseAgentProvider';
import {
  DocumentContext,
  ProviderConfig,
  ProviderCapabilities,
  StreamChunk,
  AIModel,
  PermissionRequestContent,
  PermissionResponseContent,
  CLAUDE_CODE_VARIANTS,
  ModelIdentifier,
  resolveClaudeCodeModelVariant,
} from '../types';
import {
  CLAUDE_CODE_VARIANT_VERSIONS,
  CLAUDE_CODE_MODEL_LABELS,
  CLAUDE_CODE_VARIANTS_WITH_1M,
} from '../../modelConstants';
import { isBedrockToolSearchError } from '../utils/errorDetection';
import { AgentMessagesRepository } from '../../../storage/repositories/AgentMessagesRepository';
import { TranscriptMigrationRepository } from '../../../storage/repositories/TranscriptMigrationRepository';
import { TeammateManager, type TeammateToLeadMessage } from './TeammateManager';
import path from 'path';
import os from 'os';
import { buildClaudeCodeSystemPrompt, buildMetaAgentSystemPrompt } from '../../prompt';

import { SessionManager } from '../SessionManager';
import { parseBashForFileOps, hasShellChainingOperators, splitOnShellOperators } from '../permissions/BashCommandAnalyzer';

import { ToolPermissionService } from '../permissions/ToolPermissionService';
import { AgentToolHooks } from '../permissions/AgentToolHooks';
import { McpConfigService } from '../services/McpConfigService';
import { historyManager } from '../../../../../electron/src/main/HistoryManager';
import {
  appendLargeAttachmentInstructions,
  buildMessageWithDocumentContext,
  prepareClaudeCodeAttachments,
} from './claudeCode/messagePreparation';
import {
  applyToolResultToToolCall,
  isSearchableAssistantChunk,
  isTransientClaudeCodeChunk,
} from './claudeCode/toolChunkUtils';
import {
  INTERNAL_MCP_TOOLS,
  TEAM_TOOLS,
} from './claudeCode/toolPolicy';
import {
  buildBedrockToolErrorGuidance,
  detectResultChunkErrorFlags,
  extractResultChunkErrorMessage,
} from './claudeCode/resultChunkUtils';

import {
  handleAskUserQuestionTool,
  pollForAskUserQuestionResponse,
  type PendingAskUserQuestionEntry,
} from './claudeCode/askUserQuestion';
import { ClaudeCodeTranscriptAdapter } from './claudeCode/ClaudeCodeTranscriptAdapter';

import {
  resolveImmediateToolDecision as resolveImmediateToolDecisionHelper,
} from './claudeCode/immediateToolDecision';
import {
  handleToolPermissionFallback as handleToolPermissionFallbackHelper,
  handleToolPermissionWithService as handleToolPermissionWithServiceHelper,
} from './claudeCode/toolAuthorization';
import { ClaudeCodeDeps } from './claudeCode/dependencyInjection';
import { buildSdkOptions, type PromptStreamController } from './claudeCode/sdkOptionsBuilder';
import { applyTaskListMutation, sortTaskList, type TaskListItem } from './claudeCode/taskListReconstruct';


/**
 * SDK-native tools that are executed by the Claude Code SDK itself (not by Nimbalyst).
 * AskUserQuestion is included because we handle it in canUseTool (user input, not local execution).
 * This list is the single source of truth — used for tool_use logging and tool_result logging.
 */
const SDK_NATIVE_TOOLS: readonly string[] = [
  'Read', 'Write', 'Edit', 'MultiEdit',
  'Glob', 'Grep', 'LS',
  'Bash',
  'WebFetch', 'WebSearch',
  'Task', 'Agent',  // Agent is the renamed Task tool (SDK 0.2.x+)
  'TaskOutput', 'TaskStop', 'ExitPlanMode', 'AskUserQuestion',
  'EnterPlanMode', 'EnterWorktree', 'ExitWorktree', 'Skill',
  'NotebookRead', 'NotebookEdit',
  'TodoRead', 'TodoWrite',
  'ToolSearch',
  // Task management tools (SDK-internal)
  'TaskCreate', 'TaskGet', 'TaskUpdate', 'TaskList',
  // Agent Teams tools (SDK-internal, executed by CLI subprocess)
  'TeammateTool', 'SendMessage', 'TeamCreate', 'TeamDelete',
  // Claude Code 2.1.116+ additions (CLI-native, do NOT route through our toolHandler)
  'Monitor', 'PushNotification', 'RemoteTrigger',
  'CronCreate', 'CronDelete', 'CronList',
  'ListMcpResources', 'ListMcpResourcesTool',
  'ReadMcpResource', 'ReadMcpResourceTool',
  'Config', 'Mcp',
  // claude-agent-sdk 0.3.x additions (CLI-native multi-agent orchestration)
  'Workflow', 'REPL',
];

/**
 * Tools the CLI emits as tool_use but Nimbalyst services handle as a side effect
 * inside this provider (see the `tool_use` switch). Their tool_result from the CLI
 * is informational only -- routing them through `this.toolHandler` would throw
 * "Unknown tool", so we treat them like SDK_NATIVE_TOOLS for the warn/route check.
 */
const NIMBALYST_HANDLED_TOOLS: readonly string[] = [
  'ScheduleWakeup',
];

/**
 * Track changes in the agent-sdk and claude-code itself here:
 * https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md
 * https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md
 */
// CLAUDE_CODE_VARIANT_VERSIONS and CLAUDE_CODE_MODEL_LABELS now live in
// `modelConstants.ts` so the renderer can share them — see comment there.

export interface ScheduleWakeupRequest {
  sessionId: string;
  workspacePath: string;
  delaySeconds: number;
  prompt: string;
  reason: string;
}


export class ClaudeCodeProvider extends BaseAgentProvider {
  private currentMode?: 'planning' | 'agent' | 'auto'; // Track session mode for prompt customization and tool filtering
  private slashCommands: string[] = []; // Available slash commands from SDK
  private skills: string[] = []; // Available user-invocable skills from SDK

  // Static cache of SDK-reported skills/commands so they survive across provider instances.
  // Once any session receives the init chunk, new sessions can use the cached list as a
  // fallback before their own init chunk arrives.
  private static cachedSdkSkills: string[] = [];
  private static cachedSdkSlashCommands: string[] = [];

  // Per-process guard: tracks sessionIds we've already attempted naming for so we
  // don't keep nudging the SDK every turn if the first attempt failed.
  private sessionNamingSideQuestionFiredFor: Set<string> = new Set();

  private markMessagesAsHidden: boolean = false; // Flag to mark next messages as hidden
  private helperMethod: 'native' | 'custom' = 'native';

  // Lead query reference for interruptWithMessage support
  private leadQuery: Query | null = null;
  // Flag: set when a teammate:messageWhileIdle has been emitted but sendMessage hasn't
  // started yet. Prevents interruptWithMessage from emitting duplicate events.
  private teammateIdleMessagePending: boolean = false;
  // Flag: set when streamInput fails due to dead transport, used in finally block
  private transportDied: boolean = false;
  // Flag: set when interrupt() is called on the lead query. After interrupt(),
  // the transport is dead and streamInput will always fail, so skip the while loop.
  private wasInterrupted: boolean = false;
  // Guard: prevents infinite continuation loops when the lead's turn keeps ending
  // with active teammates. Incremented on each continuation, reset when a real
  // teammate message arrives or teammates complete. Abandon after MAX_CONTINUATIONS.
  private continuationCount: number = 0;
  private static readonly MAX_CONTINUATIONS = 3;
  // Resolve function to break the for-await loop immediately when interrupt is called.
  // Racing this against .next() lets us unblock without waiting for the SDK transport.
  private interruptResolve: (() => void) | null = null;
  // Controller for the persistent prompt AsyncIterable. Ending it lets the
  // SDK's streamInput generator return and close the binary's stdin pipe.
  // Must be ended in the finally block of sendMessage and on abort.
  // See sdkOptionsBuilder.ts for why we always use a persistent AsyncIterable.
  private promptController: PromptStreamController | null = null;
  // Timer that fires controller.end() after a grace period following the first
  // `result` chunk. Reset on every subsequent chunk so multi-result turns
  // (compaction, etc.) keep stdin open until the binary truly stops emitting.
  private promptEndTimer: ReturnType<typeof setTimeout> | null = null;

  // Teammate management: spawning, messaging, lifecycle, config I/O
  private teammateManager: TeammateManager;

  // SDK-native sub-agent task tracking (task_started/task_progress/task_notification)
  private activeTasks = new Map<string, {
    taskId: string;
    description: string;
    taskType?: string;
    status: 'running' | 'completed' | 'failed' | 'stopped';
    startedAt: number;
    toolUseId?: string;
    toolCount: number;
    tokenCount: number;
    durationMs: number;
    lastToolName?: string;
    summary?: string;
  }>();

  // SDK-native task-list tracking (TaskCreate/TaskUpdate tools — the shared,
  // dependency-aware work queue, distinct from the sub-agent telemetry above).
  // Reconstructed incrementally from tool args/results because TaskUpdate only
  // sends the changed fields, never the full board. Surfaced to the UI via
  // metadata.currentTaskList. Keyed by the SDK-assigned task id ("1", "2", ...).
  private taskListItems = new Map<string, TaskListItem>();

  // MCP server status tracking: last known statuses for change detection
  private mcpServerStatuses: Map<string, McpServerStatusInfo> = new Map();
  // Interval handle for periodic MCP health checks during active sessions
  private mcpHealthCheckInterval: ReturnType<typeof setInterval> | null = null;
  // Session ID for the current streaming session (needed for health check emissions)
  private currentSessionId: string | undefined;
  // Persistent query reference for MCP operations (survives between turns).
  // Unlike leadQuery which is nulled after each turn, this stays set as long as
  // the SDK subprocess is alive (i.e. the session has MCP servers).
  private mcpQuery: Query | null = null;

  // Permission service for tool permission handling
  private permissionService: ToolPermissionService | null = null;

  // Tool hooks service for pre/post tool execution and file tracking
  private toolHooksService: AgentToolHooks | null = null;

  // MCP configuration service for loading and processing MCP server configs
  private mcpConfigService: McpConfigService;

  // ---- Static dependency forwarding ----
  // All static fields and setters live in ClaudeCodeDeps.
  // These forwarding setters maintain backward compatibility for callers.

  public static setCustomClaudeCodePathLoader(loader: ((workspacePath: string) => string) | null): void { ClaudeCodeDeps.setCustomClaudeCodePathLoader(loader); }

  constructor() {
    super();
    this.teammateManager = new TeammateManager({
      logNonBlocking: (sessionId, source, direction, content, metadata) =>
        this.logAgentMessageNonBlocking(sessionId, source, direction, content, metadata),
      emit: (event, payload) => this.emit(event, payload),
      createPreToolUseHook: (cwd, sessionId, permissionsPath, context) => {
        // Create AgentToolHooks instance for teammate
        const teammateHooks = this.createTeammateToolHooksService(cwd, sessionId, permissionsPath, context?.isTeammateSession || false);
        return teammateHooks.createPreToolUseHook();
      },
      createPostToolUseHook: (cwd, sessionId) => {
        // Create AgentToolHooks instance for teammate
        const teammateHooks = this.createTeammateToolHooksService(cwd, sessionId, undefined, true);
        return teammateHooks.createPostToolUseHook();
      },
      getAbortSignal: () => this.abortController?.signal,
      interruptWithMessage: (message) => this.interruptWithMessage(message),
      createCanUseToolHandler: (sessionId, workspacePath, permissionsPath, teammateName) =>
        this.createCanUseToolHandler(sessionId, workspacePath, permissionsPath, teammateName),
    });

    // Initialize permission service if all dependencies are available
    // For Claude Code, these dependencies are optional since permission handling
    // can fall back to inline logic if not configured (e.g., in tests)
    if (
      BaseAgentProvider.trustChecker &&
      ClaudeCodeDeps.claudeSettingsPatternSaver &&
      ClaudeCodeDeps.claudeSettingsPatternChecker
    ) {
      this.permissionService = new ToolPermissionService({
        trustChecker: BaseAgentProvider.trustChecker,
        patternSaver: ClaudeCodeDeps.claudeSettingsPatternSaver,
        patternChecker: ClaudeCodeDeps.claudeSettingsPatternChecker,
        securityLogger: BaseAgentProvider.securityLogger ?? undefined,
        emit: this.emit.bind(this),
      });
    }

    // Initialize MCP configuration service
    this.mcpConfigService = new McpConfigService({
      mcpServerPort: ClaudeCodeDeps.mcpServerPort,
      sessionNamingServerPort: ClaudeCodeDeps.sessionNamingServerPort,
      extensionDevServerPort: ClaudeCodeDeps.extensionDevServerPort,
      superLoopProgressServerPort: null, // Disabled - was leaking into non-super-loop sessions
      sessionContextServerPort: ClaudeCodeDeps.sessionContextServerPort,
      metaAgentServerPort: ClaudeCodeDeps.metaAgentServerPort,
      settingsServerPort: ClaudeCodeDeps.settingsServerPort,
      settingsAgentToolsDisabledLoader: ClaudeCodeDeps.settingsAgentToolsDisabledLoader,
      mcpAuthToken: ClaudeCodeDeps.mcpAuthToken,
      mcpConfigLoader: ClaudeCodeDeps.mcpConfigLoader,
      extensionPluginsLoader: ClaudeCodeDeps.extensionPluginsLoader,
      claudeSettingsEnvLoader: ClaudeCodeDeps.claudeSettingsEnvLoader,
      shellEnvironmentLoader: ClaudeCodeDeps.shellEnvironmentLoader,
    });
  }

  getProviderName(): string {
    return 'claude-code';
  }

  /**
   * Create AgentToolHooks service for teammate sessions
   * Teammates need separate hook instances with isTeammateSession: true
   */
  private createTeammateToolHooksService(
    workspacePath: string,
    sessionId: string | undefined,
    permissionsPath: string | undefined,
    isTeammateSession: boolean
  ): AgentToolHooks {
    return this.createToolHooksService(workspacePath, sessionId, permissionsPath, isTeammateSession);
  }

  private createToolHooksService(
    workspacePath: string,
    sessionId: string | undefined,
    permissionsPath: string | undefined,
    isTeammateSession: boolean
  ): AgentToolHooks {
    return new AgentToolHooks({
      workspacePath: workspacePath,
      sessionId,
      emit: this.emit.bind(this),
      logAgentMessage: this.logAgentMessage.bind(this),
      logSecurity: this.logSecurity.bind(this),
      trustChecker: BaseAgentProvider.trustChecker || undefined,
      patternChecker: ClaudeCodeDeps.claudeSettingsPatternChecker || undefined,
      patternSaver: ClaudeCodeDeps.claudeSettingsPatternSaver || undefined,
      getCurrentMode: () => this.currentMode,
      setCurrentMode: (mode) => { this.currentMode = mode; },
      getPendingExitPlanModeConfirmations: () => this.pendingExitPlanModeConfirmations,
      getSessionApprovedPatterns: () => this.permissions.sessionApprovedPatterns,
      getPendingToolPermissions: () => this.permissions.pendingToolPermissions,
      teammatePreToolHandler: async (toolName, toolInput, toolUseID, sessionId) =>
        this.teammateManager.handlePreToolUse(toolName, toolInput, toolUseID, sessionId),
      isTeammateSession: !!isTeammateSession,
      permissionsPath,
      historyManager: this.createHistoryManagerAdapter(),
    });
  }

  private createHistoryManagerAdapter() {
    return {
      createSnapshot: async (filePath: string, content: string, snapshotType: string, message: string, metadata?: any) => {
        await historyManager.createSnapshot(filePath, content, snapshotType as any, message, metadata);
      },
      getPendingTags: async (filePath: string) => {
        const tags = await historyManager.getPendingTags(filePath);
        return tags.map(tag => ({
          id: tag.id,
          createdAt: tag.createdAt,
          sessionId: tag.sessionId
        }));
      },
      tagFile: async (workspacePath: string, filePath: string, tagId: string, content: string, metadata?: any) => {
        await historyManager.createTag(
          workspacePath,
          filePath,
          tagId,
          content,
          metadata?.sessionId || 'unknown',
          metadata?.toolUseId || ''
        );
      },
      updateTagStatus: async (filePath: string, tagId: string, status: string) => {
        await historyManager.updateTagStatus(filePath, tagId, status as any);
      }
    };
  }

  // ExitPlanMode confirmation response type
  private pendingExitPlanModeConfirmations: Map<string, {
    resolve: (response: { approved: boolean; clearContext?: boolean; feedback?: string }) => void;
    reject: (error: Error) => void;
  }> = new Map();

  // AskUserQuestion tool - stores pending question resolvers
  // When Claude calls AskUserQuestion, we block until the UI provides answers via IPC
  private pendingAskUserQuestions: Map<string, PendingAskUserQuestionEntry> = new Map();

  static readonly DEFAULT_MODEL = ClaudeCodeDeps.DEFAULT_MODEL;

  public static setMcpServerPort(port: number | null): void { ClaudeCodeDeps.setMcpServerPort(port); }
  public static setSessionNamingServerPort(port: number | null): void { ClaudeCodeDeps.setSessionNamingServerPort(port); }
  public static setExtensionDevServerPort(port: number | null): void { ClaudeCodeDeps.setExtensionDevServerPort(port); }
  public static setSuperLoopProgressServerPort(port: number | null): void { ClaudeCodeDeps.setSuperLoopProgressServerPort(port); }
  public static setSessionContextServerPort(port: number | null): void { ClaudeCodeDeps.setSessionContextServerPort(port); }
  public static setMetaAgentServerPort(port: number | null): void { ClaudeCodeDeps.setMetaAgentServerPort(port); }
  public static setSettingsServerPort(port: number | null): void { ClaudeCodeDeps.setSettingsServerPort(port); }
  public static setSettingsAgentToolsDisabledLoader(loader: (() => boolean) | null): void { ClaudeCodeDeps.setSettingsAgentToolsDisabledLoader(loader); }
  public static setMcpAuthToken(token: string | null): void { ClaudeCodeDeps.setMcpAuthToken(token); }
  public static setMCPConfigLoader(loader: ((workspacePath?: string) => Promise<Record<string, any>>) | null): void { ClaudeCodeDeps.setMCPConfigLoader(loader); }
  public static setExtensionPluginsLoader(loader: ((workspacePath?: string) => Promise<Array<{ type: 'local'; path: string }>>) | null): void { ClaudeCodeDeps.setExtensionPluginsLoader(loader); }
  public static setClaudeCodeSettingsLoader(loader: (() => Promise<{ projectCommandsEnabled: boolean; userCommandsEnabled: boolean }>) | null): void { ClaudeCodeDeps.setClaudeCodeSettingsLoader(loader); }
  public static setClaudeSettingsEnvLoader(loader: (() => Promise<Record<string, string>>) | null): void { ClaudeCodeDeps.setClaudeSettingsEnvLoader(loader); }
  public static setShellEnvironmentLoader(loader: (() => Record<string, string> | null) | null): void { ClaudeCodeDeps.setShellEnvironmentLoader(loader); }
  public static setEnhancedPathLoader(loader: (() => string) | null): void { ClaudeCodeDeps.setEnhancedPathLoader(loader); }
  public static setAdditionalDirectoriesLoader(loader: ((workspacePath: string) => string[]) | null): void { ClaudeCodeDeps.setAdditionalDirectoriesLoader(loader); }
  public static setSecurityLogger(logger: ((message: string, data?: any) => void) | null): void { BaseAgentProvider.setSecurityLogger(logger); }
  public static setImageCompressor(compressor: ((buffer: Buffer, mimeType: string, options?: { targetSizeBytes?: number }) => Promise<{ buffer: Buffer; mimeType: string; wasCompressed: boolean }>) | null): void { ClaudeCodeDeps.setImageCompressor(compressor); }
  public static setClaudeSettingsPatternSaver(saver: ((workspacePath: string, pattern: string) => Promise<void>) | null): void { ClaudeCodeDeps.setClaudeSettingsPatternSaver(saver); }
  public static setClaudeSettingsPatternChecker(checker: ((workspacePath: string, pattern: string) => Promise<boolean>) | null): void { ClaudeCodeDeps.setClaudeSettingsPatternChecker(checker); }
  public static setTrustChecker(checker: ((workspacePath: string) => { trusted: boolean; mode: 'ask' | 'allow-all' | 'bypass-all' | null }) | null): void { BaseAgentProvider.setTrustChecker(checker); }
  public static setExtensionFileTypesLoader(loader: (() => Set<string>) | null): void { ClaudeCodeDeps.setExtensionFileTypesLoader(loader); }

  private static scheduleWakeupHandler: ((request: ScheduleWakeupRequest) => Promise<void>) | null = null;
  public static setScheduleWakeupHandler(handler: ((request: ScheduleWakeupRequest) => Promise<void>) | null): void {
    ClaudeCodeProvider.scheduleWakeupHandler = handler;
  }

  async initialize(config: ProviderConfig): Promise<void> {
    const safeConfig = { ...config, apiKey: config.apiKey ? '***' : undefined };
    //   model: config.model,
    //   configKeys: Object.keys(config),
    //   config: safeConfig
    // }, null, 2));

    this.config = config;

    // Claude Code manages its own authentication - do not require or use API key
  }

  /**
   * Mark the next sendMessage call's logged messages as hidden
   * Used for auto-triggered commands like /context that shouldn't appear in UI
   * Flag is automatically reset after sendMessage completes
   */
  public setHiddenMode(hidden: boolean): void {
    this.markMessagesAsHidden = hidden;
  }

  private resolveModelVariant(): string {
    return resolveClaudeCodeModelVariant(this.config.model, ClaudeCodeProvider.DEFAULT_MODEL);
  }



  async *sendMessage(
    message: string,
    documentContext?: DocumentContext,
    sessionId?: string,
    messages?: any[],
    workspacePath?: string,
    attachments?: any[]
  ): AsyncIterableIterator<StreamChunk> {
    const startTime = Date.now();

    // Capture the original user message for the naming side-question. Held in a
    // local const (not an instance field) so concurrent or hidden sendMessage
    // calls can't overwrite each other's description before handleSystemInit
    // fires.
    const firstUserMessageDescription = message;

    // CRITICAL: Capture hidden mode flag at START and reset immediately
    // This prevents race conditions when concurrent sendMessage calls overlap
    // (e.g., auto-context /context command running while a queued prompt fires)
    const hideMessages = this.markMessagesAsHidden;
    this.markMessagesAsHidden = false;

    // Track session mode for MCP server configuration and tool filtering
    this.currentMode = (documentContext as any)?.mode || 'agent';

    // Trust-level upgrade: when workspace permission is "Allow All" (internal
    // mode 'bypass-all') and session mode is 'agent', transparently upgrade to
    // 'auto' so the SDK classifier handles permissions instead of Nimbalyst
    // bypassing everything. This matches CLI auto-mode behaviour and adds a
    // safety layer on top of the previous blanket bypass. Plan mode is never
    // upgraded — it always uses the SDK's native read-only enforcement.
    const pathForTrustUpgrade = (documentContext as any)?.permissionsPath || workspacePath;
    if (this.currentMode === 'agent' && pathForTrustUpgrade && BaseAgentProvider.trustChecker) {
      const trustStatus = BaseAgentProvider.trustChecker(pathForTrustUpgrade);
      if (trustStatus.trusted && trustStatus.mode === 'bypass-all') {
        this.currentMode = 'auto';
      }
    }

    // Threshold for large text attachments that should be written to /tmp instead of sent inline
    // This reduces initial token usage for very large attachments
    const LARGE_ATTACHMENT_CHAR_THRESHOLD = 10000;

    const {
      imageContentBlocks,
      documentContentBlocks,
      largeAttachmentFilePaths,
    } = await prepareClaudeCodeAttachments({
      attachments,
      largeAttachmentCharThreshold: LARGE_ATTACHMENT_CHAR_THRESHOLD,
      imageCompressor: ClaudeCodeDeps.imageCompressor || undefined,
    });

    // Abort any existing request before starting a new one
    if (this.abortController) {
      this.abortController.abort();
    }

    // Create abort controller for this request
    this.abortController = new AbortController();

    // For worktree sessions, use the parent project path for permission lookups
    // This is passed via documentContext.permissionsPath from AIService
    const permissionsPath = (documentContext as any)?.permissionsPath || workspacePath;

    // For worktree sessions, use the parent project path for MCP config lookup
    // .mcp.json and ~/.claude.json project entries are keyed by parent project path
    const mcpConfigWorkspacePath = (documentContext as any)?.mcpConfigWorkspacePath || workspacePath;

    // Create tool hooks service for this turn
    // This service manages pre/post hooks, file tagging, and snapshot creation
    this.toolHooksService = this.createToolHooksService(
      workspacePath!,
      sessionId,
      permissionsPath,
      false
    );

    // Clear edited files tracker for new turn
    this.toolHooksService.clearEditedFiles();

    // Capture stderr from the subprocess for diagnostics (populated inside try, read in catch)
    const stderrLines: string[] = [];

    // Hoisted so the catch block can avoid double-yielding `complete` if the
    // result chunk's early-yield already fired before an error was thrown.
    let completeEmitted = false;

    try {
      // Append document context to message using pre-built prompts from DocumentContextService
      // Skip adding system message if the prompt starts with a slash command
      const isSlashCommand = message.trimStart().startsWith('/');
      const documentContextPrompt = (documentContext as any)?.documentContextPrompt;
      const editingInstructions = (documentContext as any)?.editingInstructions;
      const messageWithContext = buildMessageWithDocumentContext({
        message,
        isSlashCommand,
        documentContextPrompt,
        editingInstructions,
      });
      let userMessageAddition = messageWithContext.userMessageAddition;
      message = messageWithContext.messageWithContext;

      // Add large attachment file paths to system message
      // These are text attachments over 10k chars that were written to /tmp
      message = appendLargeAttachmentInstructions(message, largeAttachmentFilePaths);

      // Load env vars from ~/.claude/settings.json early so they're available for both
      // system prompt building (agent teams flag) and SDK environment setup
      let settingsEnv: Record<string, string> = {};
      if (ClaudeCodeDeps.claudeSettingsEnvLoader) {
        try {
          settingsEnv = await ClaudeCodeDeps.claudeSettingsEnvLoader();
        } catch (error) {
          console.warn('[CLAUDE-CODE] Failed to load settings env vars:', error);
        }
      }

      // Load shell environment vars (AWS credentials, NODE_EXTRA_CA_CERTS, etc.)
      // These fill in env vars that are missing from Electron's minimal environment
      // when launched from Dock/Finder instead of terminal
      let shellEnv: Record<string, string> = {};
      if (ClaudeCodeDeps.shellEnvironmentLoader) {
        try {
          shellEnv = ClaudeCodeDeps.shellEnvironmentLoader() || {};
        } catch (error) {
          console.warn('[CLAUDE-CODE] Failed to load shell environment:', error);
        }
      }

      // Build system prompt (no longer contains document context)
      const promptBuildStart = Date.now();
      // console.log('[CLAUDE-CODE] sendMessage - documentContext keys:', documentContext ? Object.keys(documentContext) : 'undefined');
      // console.log('[CLAUDE-CODE] sendMessage - documentContext.sessionType:', (documentContext as any)?.sessionType);
      const enableAgentTeams = settingsEnv.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS === '1';
      const agentRole = await this.getAgentRole(sessionId);
      const isMetaAgent = agentRole === 'meta-agent';
      const systemPrompt = this.buildSystemPrompt(documentContext, enableAgentTeams, isMetaAgent);

      // Note: Attachments (images/documents) are NOT added to the message text.
      // They're sent as separate content blocks via the API's multimodal format.
      // We only show what's actually appended to the user's text message.

      // Emit prompt additions for debugging UI
      // Only emit for user-initiated messages, not hidden/auto-triggered commands like /context
      // This prevents auto-commands from overwriting the user's prompt additions data
      const hasAttachments = attachments && attachments.length > 0;
      if (!hideMessages && sessionId && (systemPrompt || userMessageAddition || hasAttachments)) {
        // Build attachment summaries (don't include full base64 data, just metadata)
        const attachmentSummaries = attachments?.map(att => ({
          type: att.type,
          filename: att.filename || (att.filepath ? path.basename(att.filepath) : 'unknown'),
          mimeType: att.mimeType,
          filepath: att.filepath
        })) || [];

        this.emit('promptAdditions', {
          sessionId,
          systemPromptAddition: systemPrompt || null,
          userMessageAddition: userMessageAddition,
          attachments: attachmentSummaries,
          timestamp: Date.now()
        });
      }

      // Require workspace path
      if (!workspacePath) {
        throw new Error('[CLAUDE-CODE] workspacePath is required but was not provided');
      }

      // Build SDK options (settings, MCP config, env, session resumption, prompt input)
      const sdkResult = await buildSdkOptions(
        {
          resolveModelVariant: () => this.resolveModelVariant(),
          mcpConfigService: this.mcpConfigService,
          createCanUseToolHandler: (sid, wp, pp) => this.createCanUseToolHandler(sid, wp, pp),
          toolHooksService: this.toolHooksService!,
          teammateManager: this.teammateManager,
          sessions: this.sessions,
          config: this.config,
          abortController: this.abortController!,
        },
        {
          message,
          workspacePath,
          sessionId,
          documentContext,
          settingsEnv,
          shellEnv,
          systemPrompt,
          currentMode: this.currentMode,
          imageContentBlocks,
          documentContentBlocks,
          permissionsPath,
          mcpConfigWorkspacePath,
          isMetaAgent,
        }
      );
      const { options, promptInput, promptController } = sdkResult;
      this.helperMethod = sdkResult.helperMethod;
      this.promptController = promptController;

      // Meta-agent: override MCP config with meta-agent profile and apply tool restrictions
      if (isMetaAgent) {
        options.mcpServers = await this.mcpConfigService.getMcpServersConfig({
          sessionId,
          workspacePath,
          profile: 'meta-agent',
        });
        const allowedSet = new Set(BaseAgentProvider.META_AGENT_ALLOWED_TOOLS);
        const blockedNativeTools = SDK_NATIVE_TOOLS.filter(t => !allowedSet.has(t));
        (options as any).allowedTools = BaseAgentProvider.META_AGENT_ALLOWED_TOOLS;
        (options as any).disallowedTools = blockedNativeTools;
        (options as any).blockedTools = blockedNativeTools;
      }

      const queryStartTime = Date.now();

      // Log the raw input to the SDK (include attachments and mode in metadata for UI restoration)
      if (sessionId) {
        const metadataToLog: Record<string, any> = {};
        if (attachments && attachments.length > 0) {
          metadataToLog.attachments = attachments;
        }
        if (documentContext?.mode) {
          metadataToLog.mode = documentContext.mode;
        }
        const teammateMatch = message.match(/^\[Teammate message from "([^"]+)"\]/);
        if (teammateMatch) {
          metadataToLog.messageType = 'teammate_message_injected';
          metadataToLog.teammateName = teammateMatch[1];
        }
        if (documentContext?.promptOrigin) {
          metadataToLog.promptOrigin = documentContext.promptOrigin;
        }
        await this.logAgentMessage(sessionId, 'claude-code', 'input', JSON.stringify({
          prompt: message,
          options: {
            model: options.model,
            cwd: options.cwd,
            resume: options.resume,
            systemPrompt: options.systemPrompt,
            settingSources: options.settingSources,
            mcpServers: options.mcpServers ? Object.keys(options.mcpServers) : [],
            allowedTools: options.allowedTools,
            disallowedTools: options.disallowedTools,
            permissionMode: options.permissionMode
          }
        }), metadataToLog, hideMessages, undefined, true /* searchable */);
      }

      // Create transcript adapter as chunk parser (returns ParsedItems for the streaming loop).
      // Canonical events are written by the TranscriptTransformer from raw ai_agent_messages.
      const transcriptAdapter = sessionId
        ? new ClaudeCodeTranscriptAdapter(null, sessionId)
        : null;

      // Canonical transcript: user message
      transcriptAdapter?.userMessage(
        message,
        documentContext?.mode === 'planning' ? 'planning' : 'agent',
        attachments as any,
      );

      // Wire up stderr capture so process exit errors include diagnostic context.
      const MAX_STDERR_LINES = 50;
      options.stderr = (data: string) => {
        stderrLines.push(data);
        if (stderrLines.length > MAX_STDERR_LINES) {
          stderrLines.shift();
        }
        // Log stderr in real-time for diagnostics (native binary crashes)
        const trimmed = data.trim();
        if (trimmed) {
          console.warn(`[CLAUDE-CODE-STDERR] ${trimmed.substring(0, 300)}`);
        }
      };

      const queryCallStart = Date.now();

      const leadQuery: AsyncIterable<any> = query({
        prompt: promptInput as any,
        options
      });

      this.leadQuery = leadQuery as unknown as Query;
      this.teammateIdleMessagePending = false;
      const queryIterator = leadQuery as AsyncIterable<any>;
      const queryCallDuration = Date.now() - queryCallStart;
      if (queryCallDuration > 5000) {
        console.warn(`[CLAUDE-CODE] SDK query() took ${queryCallDuration}ms to return iterator (>5s threshold) - possible Windows Defender/antivirus delay`);
      }


      let fullContent = '';
      let chunkCount = 0;
      let firstChunkTime: number | undefined;
      let toolCallCount = 0;
      let receivedCompactBoundary = false;
      // Timestamp of the first `type: 'result'` chunk from the SDK. Used to
      // arm a grace-period timer that ends the prompt AsyncIterable so the
      // SDK can call transport.endInput() and let the binary exit cleanly.
      // The grace period gives late can_use_tool control requests a chance to
      // complete over the still-open stdin -- they're the original cause of
      // the "Stream closed" tool permission errors.
      let resultReceivedTime: number | null = null;
      let resultReceivedChunkCount: number | null = null;
      // `completeEmitted` is declared outside the try block so the catch can
      // see it. We yield `complete` as soon as the SDK sends the `result`
      // chunk so the UI flips to ready immediately, rather than waiting for
      // the post-result grace period to expire (~30s of perceived "still
      // running" with no new output). The for-await loop and grace timer
      // continue running so late can_use_tool control requests on stdin still
      // complete; subsequent chunks (rare -- teammate drainage, late text)
      // are still yielded to the consumer.
      // Grace window after `type: 'result'` before the controller ends the
      // prompt iterable and the SDK closes the binary's stdin pipe.
      //
      // Originally 5 seconds. Bumped to 30 seconds in the #320 follow-up
      // after reporters hit "Tool permission request failed: Error: Stream
      // closed" on sessions with 15-25+ accumulated tracker tasks. The
      // binary's task-list `<system-reminder>` hook serializes that many
      // tasks slowly enough that the result chunk lands well before the
      // hook finishes; the hook then tries to write the reminder over a
      // stdin that the previous 5s timer had already closed and throws,
      // ending the prompt controller and turning every subsequent
      // permission-requiring tool into "Stream closed".
      //
      // The reset-on-activity branch below still resets the timer on every
      // post-result chunk, so a turn that genuinely keeps streaming work
      // never hits the timer. Interrupted / idle turns linger for the
      // grace window; 30s is the trade-off for the task-list-heavy case.
      // If diagnostic logs still show STREAM_CLOSED_DIAGNOSTIC after
      // RESULT_MESSAGE_RECEIVED on a session with this fix, bump further.
      const PROMPT_GRACE_MS = 30_000;
      const armPromptEndTimer = (reason: string) => {
        if (this.promptEndTimer) {
          clearTimeout(this.promptEndTimer);
        }
        this.promptEndTimer = setTimeout(() => {
          this.promptEndTimer = null;
          this.promptController?.end(reason);
        }, PROMPT_GRACE_MS);
      };
      // Track tool calls by ID so we can update them with results
      const toolCallsById: Map<string, any> = new Map();
      // Track usage data from the SDK (gets overwritten by cumulative result.usage)
      let usageData: {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      } | undefined;
      // Track the last assistant message's usage separately (per-step, not cumulative).
      // Used for context window fill calculation: input + cacheRead + cacheCreation = actual context size.
      let lastAssistantUsage: typeof usageData | undefined;
      // Track per-model usage from SDK result (contains inputTokens, outputTokens, costUSD, etc.)
      let modelUsageData: Record<string, {
        inputTokens?: number;
        outputTokens?: number;
        cacheReadInputTokens?: number;
        cacheCreationInputTokens?: number;
        costUSD?: number;
        contextWindow?: number;
        webSearchRequests?: number;
      }> | undefined;
      // Track whether any displayable content was yielded during this request
      // Used to detect when a slash command returns no output
      let hasYieldedContent = false;
      let hasYieldedError = false;


      // Stream the response
      try {
        // Use manual iteration with Promise.race so interruptWithMessage() can
        // break the loop immediately without waiting for the SDK subprocess.
        const iterator = (queryIterator as AsyncIterable<any>)[Symbol.asyncIterator]();
        let interruptPromise = new Promise<'interrupted'>(resolve => {
          this.interruptResolve = () => resolve('interrupted');
        });
        while (true) {
          // Check for abort signal before each iteration
          if (this.abortController?.signal.aborted) {
            console.log('[CLAUDE-CODE] Abort signal detected in streaming loop, breaking out');
            break;
          }

          // Race the next chunk against the interrupt signal
          const nextPromise = iterator.next();
          const raceResult = await Promise.race([nextPromise, interruptPromise]);

          if (raceResult === 'interrupted') {
            console.log('[CLAUDE-CODE] Interrupt signal received, breaking streaming loop');
            break;
          }

          const iterResult = raceResult as IteratorResult<any>;
          if (iterResult.done) break;
          const rawChunk = iterResult.value;

          const chunk = rawChunk as any;
          chunkCount++;

          // Grace-period stdin-close logic. The SDK's `isSingleUserTurn` is
          // false because we always pass an AsyncIterable prompt -- so the
          // SDK does NOT close stdin on `type: 'result'` for us. Instead, we
          // arm a 5s timer on the first result chunk and reset it on every
          // subsequent chunk, ending the prompt controller only after the
          // binary has been silent for the grace period. This lets late
          // can_use_tool requests (the original "Stream closed" trigger)
          // complete on the still-open stdin while still letting the turn
          // finish in a bounded amount of time.
          if (typeof chunk === 'object' && chunk !== null) {
            if (chunk.type === 'result' && resultReceivedTime === null) {
              resultReceivedTime = Date.now();
              resultReceivedChunkCount = chunkCount;
              console.log(`[CLAUDE-CODE] RESULT_MESSAGE_RECEIVED: turnElapsed=${resultReceivedTime - queryStartTime}ms chunkCount=${chunkCount} subtype="${chunk.subtype}" isError=${chunk.is_error === true}`);
              armPromptEndTimer('grace-period-after-result');
            } else if (resultReceivedTime !== null) {
              // Activity continued after result -- reset the grace timer so
              // we don't kill stdin while the binary is still working.
              armPromptEndTimer('grace-period-reset-on-activity');
            }
          }

          // Diagnostic: detect a "Stream closed" tool_result at the raw chunk level.
          // Narrow match: only fires when the chunk is a user/tool_result with is_error=true
          // AND the content string contains "Stream closed". Avoids false positives from
          // successful Bash output that happens to contain the phrase (e.g., git log echoing
          // a commit message about the stream-close fix).
          if (typeof chunk === 'object' && chunk !== null && chunk.type === 'user' && Array.isArray(chunk.message?.content)) {
            const hasStreamClosedError = chunk.message.content.some((item: any) =>
              item?.type === 'tool_result'
              && item.is_error === true
              && typeof item.content === 'string'
              && item.content.includes('Stream closed')
            );
            if (hasStreamClosedError) {
              const chunkJson = JSON.stringify(chunk);
              const timeSinceResult = resultReceivedTime !== null
                ? `${Date.now() - resultReceivedTime}ms (result was chunk #${resultReceivedChunkCount})`
                : 'result not yet received';
              console.error(`[CLAUDE-CODE] STREAM_CLOSED_RAW_CHUNK: chunkType="${chunk.type}" chunkSubtype="${chunk.subtype}" chunkCount=${chunkCount} turnElapsed=${Date.now() - queryStartTime}ms stderrLines=${stderrLines.length} timeSinceResult=${timeSinceResult}`);
              console.error(`[CLAUDE-CODE] STREAM_CLOSED_RAW_CHUNK: ${chunkJson.substring(0, 500)}`);
              if (stderrLines.length > 0) {
                console.error(`[CLAUDE-CODE] STREAM_CLOSED_RAW_CHUNK stderr: ${stderrLines.join('').trim().substring(0, 500)}`);
              }
            }
          }

          // Log raw SDK chunks to database (non-blocking for streaming performance)
          // Extract SDK-provided uuid for deduplication in sync.
          // Skip transient chunk types (hook lifecycle, task progress, tool_progress,
          // auth_status, rate_limit_event): the live dispatch loop above already
          // reacted to them, and the persistent reparse path (ClaudeCodeRawParser)
          // ignores them, so persisting just inflates ai_agent_messages + sync churn.
          if (sessionId && !isTransientClaudeCodeChunk(chunk)) {
            const rawChunkJson = typeof chunk === 'string'
              ? JSON.stringify({ type: 'text', content: chunk })
              : JSON.stringify(chunk);
            // Non-string chunks from SDK have a uuid field we can use for deduplication
            const providerMessageId = typeof chunk !== 'string' ? chunk.uuid : undefined;

            // Determine if this chunk should be searchable (assistant text without tool content)
            // Only assistant messages with text content (no tool_use/tool_result) are searchable
            const isSearchable = isSearchableAssistantChunk(chunk);

            this.logAgentMessageNonBlocking(sessionId, 'claude-code', 'output', rawChunkJson, undefined, hideMessages, providerMessageId, isSearchable);
            // Drive incremental transcript transformation. Without this, the
            // canonical store only advances on the next aiLoadSession from
            // the renderer, which never fires when the user's active session
            // isn't this one -- so widgets keyed on canonical events (e.g.
            // developer_git_commit_proposal's GitCommitConfirmationWidget)
            // never appear when a turn pauses mid-stream waiting on user
            // input. Fire-and-forget so the chunk loop stays responsive;
            // the per-session lock inside TranscriptTransformer serializes
            // concurrent calls and the next chunk picks up anything that
            // hadn't flushed in time.
            this.scheduleTranscriptProcessing(sessionId);
          }

          // if (chunkCount <= 5) {
          //     typeof chunk === 'string'
          //       ? { type: 'string', length: chunk.length, preview: chunk.substring(0, 100) }
          //       : JSON.stringify(chunk, null, 2)
          //   );
          // }

          if (!firstChunkTime) {
            firstChunkTime = Date.now();
            const timeToFirstChunk = firstChunkTime - queryStartTime;
            // console.log(`[CLAUDE-CODE] First chunk received in ${timeToFirstChunk}ms from query start`);
            if (timeToFirstChunk > 10000) {
              console.warn(`[CLAUDE-CODE] Time to first chunk was ${timeToFirstChunk}ms (>10s threshold) - possible Windows Defender/antivirus delay during subprocess spawn`);
            }
          }
          // All chunk types go through the adapter. Provider dispatches on parsed items
          // for side effects only -- the adapter owns all parsing and canonical event emission.
          const parsed = transcriptAdapter?.processChunk(chunk) ?? [];
          let breakOuter = false;
          for (const item of parsed) {
            switch (item.kind) {
              case 'text':
                fullContent += item.text;
                yield { type: 'text', content: item.text };
                break;

              case 'session_id':
                // Fail loud if we asked the SDK to resume session X and it reports a
                // different session Y. That means resume silently failed (the CLI
                // couldn't find the transcript, the file was corrupt, the --resume
                // flag never made it, etc.) and we'd otherwise happily start a new
                // conversation on top of what the user thinks is an existing thread.
                // Forked sessions are exempt: `forkSession: true` tells the CLI to
                // intentionally emit a new session ID from the source conversation.
                if (options.resume && !options.forkSession && item.id !== options.resume) {
                  const mismatchError = new Error(
                    `[CLAUDE-CODE] Session resume mismatch: requested resume of ` +
                    `"${options.resume}" but SDK reported session "${item.id}". ` +
                    `The prior conversation is not loaded. Aborting so the user sees ` +
                    `the failure rather than silently starting a fresh session.`
                  );
                  console.error(mismatchError.message);
                  throw mismatchError;
                }
                if (sessionId) {
                  this.sessions.captureSessionId(sessionId, item.id);
                }
                break;

              case 'usage':
                usageData = item.usage;
                if (item.isPerStep) lastAssistantUsage = item.usage;
                if (item.modelUsage) modelUsageData = item.modelUsage;
                break;

              case 'tool_use': {
                toolCallCount++;
                const { toolId, toolName, args, isMcp, isSubagent } = item;

                if (toolName === 'TodoWrite' && args?.todos) {
                  this.emitTodoUpdate(sessionId, args.todos as any[]).catch(() => {});
                }

                // The CLI emits ScheduleWakeup tool calls but its tool_result is informational only --
                // nothing in the SDK actually fires the wakeup. Route through Nimbalyst's
                // SessionWakeupScheduler so the prompt is re-queued at fire time.
                if (toolName === 'ScheduleWakeup' && sessionId && workspacePath) {
                  this.handleScheduleWakeupTool(sessionId, workspacePath, args || {}).catch(err => {
                    console.error('[CLAUDE-CODE] handleScheduleWakeupTool failed:', err);
                  });
                }

                const isSdkNativeTool = SDK_NATIVE_TOOLS.includes(toolName);
                const isNimbalystHandled = NIMBALYST_HANDLED_TOOLS.includes(toolName);
                if (!toolName || isMcp || isSdkNativeTool || isNimbalystHandled || isSubagent) {
                  // Handled by SDK, a subagent spawn, or a Nimbalyst side-effect handler above
                } else if (this.toolHandler) {
                  // Unknown, non-MCP, non-whitelisted tool. Almost always means Anthropic
                  // added a new CLI-native tool we haven't added to SDK_NATIVE_TOOLS yet.
                  // Log a warning and treat it as SDK-native rather than routing to our
                  // toolHandler (which will throw "Unknown tool" and can leave the CLI's
                  // control stream in a broken state -- see hook_0 "Stream closed" cascade).
                  console.warn(`[CLAUDE-CODE] Unrecognized tool "${toolName}" not in SDK_NATIVE_TOOLS whitelist; assuming CLI-native and skipping local execution.`);
                }

                const toolCall = { id: toolId, name: toolName, arguments: args };
                toolCallsById.set(toolId, toolCall);
                // Yield so AIService can track tool calls (notification text reset,
                // worktree inference, file tracking side effects). Parity with
                // Codex/OpenCode providers -- the result is attached later in
                // `tool_result` and picked up via toolCallsById.
                yield { type: 'tool_call', toolCall };
                break;
              }

              case 'tool_result': {
                const toolCall = toolCallsById.get(item.toolUseId);
                if (toolCall) {
                  const { isDuplicate } = applyToolResultToToolCall(toolCall, item.content, item.isError);
                  if (isDuplicate) break;

                  // Diagnostic: detect "Stream closed" errors from the native binary
                  const resultText = typeof item.content === 'string' ? item.content : JSON.stringify(item.content);
                  if (item.isError && resultText.includes('Stream closed')) {
                    const timeSinceResult = resultReceivedTime !== null
                      ? `${Date.now() - resultReceivedTime}ms (result was chunk #${resultReceivedChunkCount})`
                      : 'result not yet received';
                    const controllerState = this.promptController
                      ? (this.promptController.isEnded() ? 'ended' : 'open')
                      : 'null';
                    console.error(`[CLAUDE-CODE] STREAM_CLOSED_DIAGNOSTIC: tool="${toolCall.name}" toolUseId="${item.toolUseId}" isError=${item.isError} stderrLines=${stderrLines.length} chunkCount=${chunkCount} turnElapsed=${Date.now() - queryStartTime}ms timeSinceResult=${timeSinceResult} promptController=${controllerState}`);
                    console.error(`[CLAUDE-CODE] STREAM_CLOSED_DIAGNOSTIC: resultText="${resultText.substring(0, 300)}"`);
                    if (stderrLines.length > 0) {
                      console.error(`[CLAUDE-CODE] STREAM_CLOSED_DIAGNOSTIC: stderr="${stderrLines.join('').trim().substring(0, 500)}"`);
                    }
                  }

                  this.processTeammateToolResult(sessionId, toolCall.name, toolCall.arguments, item.content, toolCall.isError === true, toolCall.id);

                  // Mirror SDK-native task-list mutations into session metadata so
                  // the UI can show the tasks for this session (TaskCreate id is
                  // only available in the result, so capture happens here).
                  if (!toolCall.isError) {
                    this.captureTaskListMutation(sessionId, toolCall.name, toolCall.arguments, item.content);
                  }

                  if (item.toolUseId) {
                    for (const task of this.activeTasks.values()) {
                      if (task.toolUseId === item.toolUseId && task.status === 'running') {
                        task.status = toolCall.isError ? 'failed' : 'completed';
                        if (typeof item.content === 'string') task.summary = (item.content as string).substring(0, 200);
                        this.emitTaskUpdate(sessionId).catch(() => {});
                        break;
                      }
                    }
                  }
                }
                break;
              }

              case 'error': {
                let errorMessage = item.message;
                const errorChunk = item.chunk;

                if (errorChunk?.type === 'assistant' && errorChunk?.error === 'authentication_failed') {
                  this.logError(sessionId, 'claude-code', new Error(errorMessage), 'assistant_chunk', 'authentication_error', hideMessages);
                  yield { type: 'error', error: errorMessage, isAuthError: true };
                  yield { type: 'complete', isComplete: true };
                  breakOuter = true;
                  break;
                }

                if (errorChunk?.type === 'result') {
                  errorMessage = extractResultChunkErrorMessage(errorChunk);
                  const { isAuthError, isExpiredSessionError, isServerError } = detectResultChunkErrorFlags(errorMessage);

                  if (isExpiredSessionError && sessionId) {
                    this.sessions.expireSession(sessionId);
                    errorMessage = 'Your previous conversation session has expired and can no longer be resumed. Please send a new message to start a fresh conversation - your chat history is still visible but the AI will start with a clean context.';
                  }

                  const isBedrockToolError = isBedrockToolSearchError(errorMessage);
                  if (isServerError) errorMessage += '\n\nClaude may be experiencing issues. Check https://status.anthropic.com for service status.';
                  if (isBedrockToolError) errorMessage = buildBedrockToolErrorGuidance(errorMessage);

                  const isRateLimitError = /rate limit/i.test(errorMessage);
                  const is1mModel = this.config.model != null && this.config.model.includes('-1m');
                  if (isRateLimitError && is1mModel) errorMessage += '\n\nThis 1M context model may not be available on your plan.';

                  const errorType = isAuthError ? 'authentication_error' : isBedrockToolError ? 'bedrock_tool_error' : isExpiredSessionError ? 'expired_session_error' : 'api_error';
                  this.logError(sessionId, 'claude-code', new Error(errorMessage), 'result_chunk', errorType, hideMessages);
                  transcriptAdapter?.systemMessage(errorMessage, 'error');

                  yield {
                    type: 'error',
                    error: errorMessage,
                    ...(isAuthError && { isAuthError: true }),
                    ...(isBedrockToolError && { isBedrockToolError: true }),
                    ...(isExpiredSessionError && { isExpiredSessionError: true }),
                    ...(isServerError && { isServerError: true }),
                  };

                  await this.flushPendingWrites();
                  if (sessionId) await this.processTranscriptMessages(sessionId);
                  yield { type: 'complete', isComplete: true };
                  breakOuter = true;
                  break;
                }

                yield { type: 'error', error: errorMessage };
                break;
              }

              // -- Lifecycle items (side effects only, not transcript-relevant) --

              case 'system_init':
                yield* this.handleSystemInit(item.chunk, sessionId, hideMessages, firstUserMessageDescription);
                break;

              case 'system_task':
                this.handleSystemTask(item.subtype, item.chunk, sessionId);
                break;

              case 'system_compact':
                receivedCompactBoundary = true;
                lastAssistantUsage = undefined;
                yield { type: 'text', content: `Conversation compacted (was ${item.preTokens} tokens)` };
                break;

              case 'system_message':
                yield { type: 'text', content: item.text };
                break;

              case 'summary': {
                if (item.isAuthError) {
                  // console.error('[CLAUDE-CODE] Authentication error detected in summary:', item.text);
                  this.logError(sessionId, 'claude-code', new Error(item.text), 'summary_chunk', 'authentication_error', hideMessages);
                  yield { type: 'error', error: item.text, isAuthError: true };
                  yield { type: 'complete', isComplete: true };
                  breakOuter = true;
                } else {
                  const displayMessage = item.text
                    ? `[Claude Agent]: ${item.text}`
                    : `[Claude Agent]: ${JSON.stringify(item.chunk)}`;
                  yield { type: 'text', content: displayMessage };
                }
                break;
              }

              case 'auth_status': {
                const authChunk = item.chunk;
                if (authChunk.error || authChunk.isAuthenticating === false) {
                  const errorMessage = authChunk.error || 'Authentication required';
                  // console.error('[CLAUDE-CODE] Auth status error:', errorMessage);
                  this.logError(sessionId, 'claude-code', new Error(errorMessage), 'auth_status_chunk', 'authentication_error', hideMessages);
                  yield { type: 'error', error: errorMessage, isAuthError: true };
                }
                if (authChunk.output?.length > 0) {
                  // console.log('[CLAUDE-CODE] Auth status output:', authChunk.output.join('\n'));
                }
                break;
              }

              case 'rate_limit': {
                const info = item.chunk.rate_limit_info;
                if (info && info.status !== 'allowed') {
                  const resetsAtUnix = info.resetsAt || null;
                  const limitType = info.rateLimitType === 'five_hour' ? '5-hour session' : info.rateLimitType || 'unknown';
                  const utilization = info.utilization != null ? Math.round(info.utilization * 100) : null;
                  const isWarning = info.status === 'allowed_warning';
                  const marker = isWarning ? '[RATE_LIMIT_WARNING]' : '[RATE_LIMIT]';
                  const utilizationStr = utilization != null ? ` usage=${utilization}` : '';
                  const modelStr = this.config.model ? ` model=${this.config.model}` : '';
                  yield { type: 'text', content: `\n\n<!-- ${marker} limitType=${limitType} resetsAtUnix=${resetsAtUnix || 'unknown'}${utilizationStr}${modelStr} -->\n\n` };
                }
                break;
              }

              case 'tool_progress':
              case 'tool_use_summary':
                // Informational only -- handled visually through transcript
                break;

              case 'unknown':
                if (item.extractedText) {
                  yield { type: 'text', content: item.extractedText };
                }
                break;
            }
          }
          if (breakOuter) break;

          // Yield `complete` as soon as the SDK reports the turn is done (`result`
          // chunk). usageData / lastAssistantUsage / modelUsageData were populated
          // by the parsed items above (via `usage` items from the result chunk).
          // The for-await keeps running so stdin stays open for late control
          // requests, but the consumer sees completion immediately.
          if (typeof chunk === 'object' && chunk !== null && chunk.type === 'result' && !completeEmitted) {
            await this.flushPendingWrites();
            if (sessionId) await this.processTranscriptMessages(sessionId);

            if (this.toolHooksService && this.toolHooksService.getEditedFiles().size > 0) {
              await this.toolHooksService.createTurnEndSnapshots();
            }

            // Prefer result.usage (deduplicated by Anthropic via message.id). The SDK's
            // modelUsage aggregate over-counts: the agent stream emits each assistant
            // message 2-3x (one event per content block) and modelUsage sums the dupes,
            // inflating cumulative input/output. Fall back to the modelUsage sum only when
            // result.usage is missing. See NIM-689.
            let totalInputTokens = usageData?.input_tokens || 0;
            let totalOutputTokens = usageData?.output_tokens || 0;
            if (!usageData && modelUsageData) {
              for (const modelName of Object.keys(modelUsageData)) {
                const modelStats = modelUsageData[modelName];
                totalInputTokens += modelStats.inputTokens || 0;
                totalOutputTokens += modelStats.outputTokens || 0;
              }
            }

            const lastMessageContextTokens = lastAssistantUsage
              ? (lastAssistantUsage.input_tokens || 0)
                + (lastAssistantUsage.cache_read_input_tokens || 0)
                + (lastAssistantUsage.cache_creation_input_tokens || 0)
              : undefined;

            transcriptAdapter?.turnEnded(usageData, modelUsageData);

            yield {
              type: 'complete',
              isComplete: true,
              ...(usageData || modelUsageData ? {
                usage: {
                  input_tokens: totalInputTokens,
                  output_tokens: totalOutputTokens,
                  cache_read_input_tokens: usageData?.cache_read_input_tokens || 0,
                  cache_creation_input_tokens: usageData?.cache_creation_input_tokens || 0,
                  total_tokens: totalInputTokens + totalOutputTokens
                }
              } : {}),
              ...(modelUsageData ? { modelUsage: modelUsageData } : {}),
              ...(lastMessageContextTokens !== undefined ? { contextFillTokens: lastMessageContextTokens } : {}),
              ...(receivedCompactBoundary ? { contextCompacted: true } : {})
            };
            completeEmitted = true;

            // Break out of the chunk loop. The for-await would otherwise stay
            // alive indefinitely on sessions where the binary's task-list
            // `<system-reminder>` hook keeps trying can_use_tool requests over
            // closed stdin (each failure emits a tool_result(Stream closed)
            // chunk that resets the grace timer). Witnessed in the wild as
            // 13+ minute hangs after ScheduleWakeup-driven turns.
            //
            // Because this is a manual `while (true)` loop iterating via
            // iterator.next() (not for-await), `break` does NOT call
            // iterator.return(), so the SDK generator's internal state is
            // preserved for the next turn. The binary subprocess stays alive
            // for session resume (existing finally-block behavior).
            //
            // Teammate drainage at the next block reads from the same
            // leadQuery iterator if pending messages exist, so that flow
            // still works.
            break;
          }
        }
      } catch (iterError) {
        // Don't log abort errors - they're expected when user cancels
        const errMessage = (iterError as Error).message || '';
        const isAbort = (iterError as any).name === 'AbortError' || errMessage.includes('aborted');
        if (!isAbort) {
          console.error('[CLAUDE-CODE] Error during iteration:', iterError);
          console.error('[CLAUDE-CODE] Error stack:', (iterError as Error).stack);
        }
        throw iterError;
      }

      // ── Process queued teammate messages via streamInput ──────────────
      // After the main loop exits naturally, drain any pending teammate-to-lead
      // messages. Each is injected as a new user turn on the existing query via
      // streamInput. Skip if the query was interrupted — after interrupt() the
      // transport is dead and streamInput will always fail. Messages stay queued
      // for the finally block to re-trigger via a fresh sendMessage.
      while (this.teammateManager.hasPendingTeammateMessages() && this.leadQuery && !this.wasInterrupted) {
        const nextMsg = this.teammateManager.drainNextTeammateMessage();
        if (!nextMsg) break;

        const formattedMessage = `[Teammate message from "${nextMsg.teammateName}"]\n\n${nextMsg.content}`;
        console.log(`[CLAUDE-CODE] Processing queued teammate message via streamInput: "${nextMsg.summary}"`);

        // Log the injected user message to the DB so the conversation is complete.
        // Uses non-blocking since we're mid-turn and don't need to await persistence.
        if (sessionId) {
          this.logAgentMessageNonBlocking(
            sessionId, 'claude-code', 'input',
            JSON.stringify({ prompt: formattedMessage }),
            { messageType: 'teammate_message_injected', teammateName: nextMsg.teammateName }
          );
        }

        try {
          await this.leadQuery.streamInput(
            this.teammateManager.createInjectedUserMessageStream(formattedMessage)
          );
        } catch (streamErr) {
          console.warn('[CLAUDE-CODE] streamInput failed for teammate message:', streamErr);
          // Lead transport is dead. Re-queue the message so the finally block
          // can re-trigger delivery via a fresh sendMessage call.
          this.teammateManager.requeueTeammateMessage(nextMsg);
          this.transportDied = true;
          break;
        }

        // Consume output from the new turn (same chunk processing)
        try {
          for await (const rawChunk of (this.leadQuery as AsyncIterable<any>)) {
            if (this.abortController?.signal.aborted) {
              console.log('[CLAUDE-CODE] Abort signal detected during teammate message processing');
              break;
            }
            const chunk = typeof rawChunk === 'string' ? rawChunk : rawChunk;

            if (typeof chunk === 'string') {
              fullContent += chunk;
              yield { type: 'text', content: chunk };
            } else if (chunk && typeof chunk === 'object') {
              if (chunk.type === 'result') {
                if (chunk.usage) {
                  usageData = {
                    ...(usageData || {}),
                    input_tokens: (usageData?.input_tokens || 0) + (chunk.usage.input_tokens || 0),
                    output_tokens: (usageData?.output_tokens || 0) + (chunk.usage.output_tokens || 0),
                  };
                }
              } else if (chunk.type === 'assistant' && chunk.message?.content) {
                for (const block of chunk.message.content) {
                  if (block.type === 'text' && block.text) {
                    fullContent += block.text;
                    yield { type: 'text', content: block.text };
                  } else if (block.type === 'tool_use') {
                    toolCallCount++;
                    if (sessionId) {
                      this.logAgentMessageNonBlocking(
                        sessionId, 'claude-code', 'output',
                        JSON.stringify(block),
                        { messageType: 'tool_use', toolName: block.name }
                      );
                    }
                  } else if (block.type === 'tool_result') {
                    if (sessionId) {
                      this.logAgentMessageNonBlocking(
                        sessionId, 'claude-code', 'output',
                        JSON.stringify(block),
                        { messageType: 'tool_result' }
                      );
                    }
                  }
                }
              }
            }
          }
        } catch (iterError) {
          const errMessage = (iterError as Error).message || '';
          const isAbort = (iterError as any).name === 'AbortError' || errMessage.includes('aborted');
          if (!isAbort) {
            console.error('[CLAUDE-CODE] Error during teammate message iteration:', iterError);
          }
          throw iterError;
        }
      }

      // Check if this was a slash command that returned no output
      // This helps users understand when a command doesn't exist or failed silently
      // Skip this check if we received a compact_boundary (compact outputs via system message, not fullContent)
      if (isSlashCommand && fullContent.trim().length === 0 && toolCallCount === 0 && !receivedCompactBoundary) {
        // Extract the command name from the message for the error message
        const commandMatch = message.trimStart().match(/^\/(\S+)/);
        const commandName = commandMatch ? commandMatch[1] : 'unknown';

        const errorMessage = `The command "/${commandName}" did not produce any output. This command may not exist or may have failed silently. Try typing "/" to see available commands.`;
        // console.error(`[CLAUDE-CODE] Slash command /${commandName} returned no output`);

        // Log error to database for persistence
        // The logError call saves the message to the database and emits 'message:logged'
        // which triggers a session reload in the UI, displaying the error
        // Do NOT yield an error chunk here - that would cause duplicate display via ai:error IPC
        // Pass hideMessages so /context errors (auto-triggered) stay hidden
        this.logError(sessionId, 'claude-code', new Error(errorMessage), 'slash_command', 'slash_command_error', hideMessages);
      }

      // Send completion event
      const totalTime = Date.now() - startTime;

      // If we already emitted `complete` on the `result` chunk (the common
      // path), all post-turn side effects (flushPendingWrites, snapshots,
      // transcriptAdapter.turnEnded) were already run there. Skip them and the
      // duplicate yield. We only fall through to the legacy end-of-loop path
      // when no `result` chunk was ever seen (e.g. iterator closed early,
      // slash command produced no result).
      if (!completeEmitted) {
        // Flush all pending non-blocking DB writes before signaling completion.
        // Without this, the UI receives session:completed and reloads from DB
        // before the final messages (e.g. compact_boundary, continuation, result)
        // have been committed, causing a stale transcript.
        await this.flushPendingWrites();
        if (sessionId) await this.processTranscriptMessages(sessionId);

        // Create snapshots for all files edited during this turn
        if (this.toolHooksService && this.toolHooksService.getEditedFiles().size > 0) {
          await this.toolHooksService.createTurnEndSnapshots();
        }

        // Prefer result.usage (deduplicated by Anthropic via message.id) for token totals.
        // modelUsage over-counts because the agent stream emits each assistant message
        // 2-3x (one event per content block) and modelUsage sums the dupes. Use the
        // modelUsage sum only as a fallback when result.usage is absent. Cost still comes
        // from modelUsage (the only per-model cost source; not displayed). See NIM-689.
        let totalInputTokens = usageData?.input_tokens || 0;
        let totalOutputTokens = usageData?.output_tokens || 0;
        let totalCostUSD = 0;

        if (modelUsageData) {
          if (!usageData) {
            totalInputTokens = 0;
            totalOutputTokens = 0;
          }
          for (const modelName of Object.keys(modelUsageData)) {
            const modelStats = modelUsageData[modelName];
            if (!usageData) {
              totalInputTokens += modelStats.inputTokens || 0;
              totalOutputTokens += modelStats.outputTokens || 0;
            }
            totalCostUSD += modelStats.costUSD || 0;
          }
        }

        // Compute context fill from last assistant message's usage (not cumulative result.usage).
        // CRITICAL: Use lastAssistantUsage, NOT usageData (which gets overwritten by cumulative result.usage).
        const lastMessageContextTokens = lastAssistantUsage
          ? (lastAssistantUsage.input_tokens || 0)
            + (lastAssistantUsage.cache_read_input_tokens || 0)
            + (lastAssistantUsage.cache_creation_input_tokens || 0)
          : undefined;

        // Canonical transcript: turn ended with usage
        transcriptAdapter?.turnEnded(usageData, modelUsageData);

        yield {
          type: 'complete',
          // Don't send content here - it's already been sent in chunks
          // The AIService accumulates the chunks itself
          isComplete: true,
          ...(usageData || modelUsageData ? {
            usage: {
              input_tokens: totalInputTokens,
              output_tokens: totalOutputTokens,
              cache_read_input_tokens: usageData?.cache_read_input_tokens || 0,
              cache_creation_input_tokens: usageData?.cache_creation_input_tokens || 0,
              total_tokens: totalInputTokens + totalOutputTokens
            }
          } : {}),
          // Include modelUsage for detailed per-model breakdown and cost tracking
          ...(modelUsageData ? { modelUsage: modelUsageData } : {}),
          // Context fill from last assistant message (for context window display)
          ...(lastMessageContextTokens !== undefined ? { contextFillTokens: lastMessageContextTokens } : {}),
          // Signal that compaction happened so AIService clears stale currentContext
          ...(receivedCompactBoundary ? { contextCompacted: true } : {})
        };
      }


    } catch (error: any) {
      const errorTime = Date.now() - startTime;
      const isAbort = error.name === 'AbortError' || error.message?.includes('aborted');

      // Only log details for non-abort errors
      if (!isAbort) {
        console.error(`[CLAUDE-CODE] ========== ERROR in sendMessage ==========`);
        console.error(`[CLAUDE-CODE] Error occurred after ${errorTime}ms`);
        console.error(`[CLAUDE-CODE] Error name: ${error.name}`);
        console.error(`[CLAUDE-CODE] Error message: ${error.message}`);
        console.error(`[CLAUDE-CODE] Error stack:`, error.stack);
        if (stderrLines.length > 0) {
          console.error(`[CLAUDE-CODE] Subprocess stderr (${stderrLines.length} lines):`);
          for (const line of stderrLines) {
            console.error(`[CLAUDE-CODE-STDERR] ${line}`);
          }
        }
        // Enrich the error message with stderr for the UI
        if (stderrLines.length > 0) {
          const stderrSummary = stderrLines.join('').trim().slice(0, 500);
          if (stderrSummary) {
            error.message = `${error.message}\n\nProcess output:\n${stderrSummary}`;
          }
        }
      }

      if (isAbort) {
        // Abort is expected - user cancelled, don't log as error
        await this.flushPendingWrites();
        if (sessionId) await this.processTranscriptMessages(sessionId);
        if (!completeEmitted) {
          yield {
            type: 'complete',
            isComplete: true
          };
        }
      } else {
        console.error(`[CLAUDE-CODE] Error occurred`);

        // Diagnostic only: log whether the resumed session was in history.jsonl.
        // We no longer mis-attribute arbitrary SDK errors to "session expired" --
        // history.jsonl lookups race with SDK writes and may not reflect programmatic
        // sessions, so a miss is not authoritative. The SDK's own error handling at
        // the isExpiredSessionError branch above is the source of truth for real expiry.
        const resumeSessionId = sessionId ? this.sessions.getSessionId(sessionId) : null;
        if (resumeSessionId) {
          const sessionExists = await this.checkSessionExists(resumeSessionId);
          if (!sessionExists) {
            console.warn(`[CLAUDE-CODE] Resume session ${resumeSessionId} not found in history.jsonl (soft signal -- not acting on it)`);
          }
        }

        console.error(`[CLAUDE-CODE] Yielding error to client`);
        console.error(`[CLAUDE-CODE] Session ID for error logging:`, sessionId);

        // Log error to database (as 'output' since errors are provider responses)
        if (!sessionId) {
          console.error(`[CLAUDE-CODE] CRITICAL: Cannot log error - sessionId is undefined!`);
        } else {
          console.error(`[CLAUDE-CODE] Logging error to database for session:`, sessionId);
          this.logError(sessionId, 'claude-code', error, 'catch_block', 'exception', hideMessages);
        }

        yield {
          type: 'error',
          error: error.message
        };

        // CRITICAL: Always send completion after error to clean up UI state.
        // Skip if we already emitted complete on the result chunk -- the UI
        // is already cleaned up; this error was raised after the turn was
        // delivered (e.g. teammate streamInput failure).
        await this.flushPendingWrites();
        if (sessionId) await this.processTranscriptMessages(sessionId);
        if (!completeEmitted) {
          yield {
            type: 'complete'
          };
        }
      }
    } finally {
      // Don't stop MCP health checks or clear mcpQuery between turns -
      // the SDK subprocess stays alive for session resume, so MCP operations
      // (health checks, reconnect) should keep working between turns.
      // They are cleaned up in abort() and when the provider is destroyed.
      this.leadQuery = null;
      this.abortController = null;
      this.wasInterrupted = false;
      this.interruptResolve = null;
      // End the persistent prompt stream so the SDK's streamInput generator
      // returns and closes the binary's stdin pipe cleanly. Safety net for
      // turns where the grace timer never armed (no result chunk received,
      // e.g. error path) or the controller is still open for some reason.
      // Idempotent inside the controller. Also clear the grace timer so it
      // can't fire after we're gone.
      if (this.promptEndTimer) {
        clearTimeout(this.promptEndTimer);
        this.promptEndTimer = null;
      }
      if (this.promptController) {
        this.promptController.end('sendMessage-finally');
        this.promptController = null;
      }
      // Note: markMessagesAsHidden is reset at the START of sendMessage to prevent race conditions

      this.handlePostLeadTurnTeammateState(sessionId, hideMessages);

      this.transportDied = false;
    }
  }

  abort(): void {
    console.log('[CLAUDE-CODE] Abort called, abortController:', this.abortController ? 'exists' : 'NULL');

    // Resolve the interrupt promise so the Promise.race in the streaming loop
    // settles immediately, preventing the loop from hanging on a dead transport.
    if (this.interruptResolve) {
      this.interruptResolve();
      this.interruptResolve = null;
    }

    // End the persistent prompt stream so the SDK can close stdin. The finally
    // block in sendMessage will also handle this, but aborts can fire while
    // the for-await is mid-iteration -- if we don't end the controller here,
    // the SDK's streamInput stays blocked on its endPromise and the for-await
    // can hang waiting for chunks that never come from the dead transport.
    if (this.promptEndTimer) {
      clearTimeout(this.promptEndTimer);
      this.promptEndTimer = null;
    }
    if (this.promptController) {
      this.promptController.end('abort');
    }

    // Call base class abort (handles abortController and rejectAllPendingPermissions)
    super.abort();

    // Clean up Claude Code-specific pending user interactions
    this.rejectAllPendingConfirmations();
    this.rejectAllPendingQuestions();

    // Abort all managed teammates
    this.teammateManager.killAll();

    // Clean up MCP health checks and persistent query reference
    this.stopMcpHealthChecks();
    this.mcpQuery = null;
    this.currentSessionId = undefined;
  }

  /**
   * If the session is still unnamed, fire two SDK control requests in parallel:
   *   1. generateSessionTitle — built-in fast title generator (~1s)
   *   2. askSideQuestion — text-only "/btw"-style question asking the agent
   *      to suggest tags+phase. Returns plain text, NO tool calls (the side
   *      question context can't reach the main turn's tool registry), so we
   *      parse the agent's reply ourselves and persist via the repository.
   *
   * Must be called DURING the turn (after init, before result), because the SDK
   * calls transport.endInput() after the first result chunk and rejects all
   * pending control_responses with "Query closed before response received".
   *
   * Both calls are best-effort. The default phase fallback ensures the kanban
   * always shows the session even if either request races the closure.
   *
   * Uses two undocumented SDK methods (generateSessionTitle and askSideQuestion
   * exist in 0.2.117 runtime but are not on the public sdk.d.ts surface).
   */

  // Per-session "transcript processing already scheduled" flag. The streaming
  // chunk loop fires scheduleTranscriptProcessing per chunk, so without this
  // we'd queue one processNewMessages run per chunk; the per-session lock
  // inside TranscriptTransformer would serialize them, but we'd still pay N
  // DB roundtrips for what could have been one. Setting the flag at schedule
  // time and clearing it when the run starts coalesces bursts of chunks into
  // at most one in-flight run + one queued run per session.
  private transcriptProcessingScheduled: Set<string> = new Set();

  /**
   * Schedule a non-blocking pass over any unprocessed rows in
   * ai_agent_messages for this session. Mirrors what OpenCodeProvider,
   * CopilotCLIProvider, and OpenAICodexACPProvider do synchronously, but
   * fired-and-forgotten so the high-throughput Claude Code chunk loop stays
   * responsive. End-of-turn callers should still `await
   * processTranscriptMessages` directly to guarantee post-flush consistency.
   */
  private scheduleTranscriptProcessing(sessionId: string): void {
    if (!TranscriptMigrationRepository.hasService()) return;
    if (this.transcriptProcessingScheduled.has(sessionId)) return;
    this.transcriptProcessingScheduled.add(sessionId);
    queueMicrotask(() => {
      this.transcriptProcessingScheduled.delete(sessionId);
      void this.processTranscriptMessages(sessionId);
    });
  }

  /**
   * Drive the canonical transcript transformer forward for this session.
   * Best-effort: failures here must not abort the streaming turn, and the
   * next call (or end-of-turn aiLoadSession from the renderer) will catch
   * up. Without this, canonical events only get materialized when the
   * renderer's active session is read, so mid-turn widgets (the commit
   * proposal pending widget, AskUserQuestion, ExitPlanMode) never appear
   * when the user is viewing a different session.
   */
  private async processTranscriptMessages(sessionId: string): Promise<void> {
    try {
      if (TranscriptMigrationRepository.hasService()) {
        await TranscriptMigrationRepository.getService().processNewMessages(
          sessionId,
          'claude-code',
        );
      }
    } catch {
      // Best effort -- next chunk or post-flush call will catch up.
    }
  }

  private async maybeFireSessionNamingSideQuestion(
    queryRef: Query,
    sessionId: string,
    description: string
  ): Promise<void> {
    if (this.sessionNamingSideQuestionFiredFor.has(sessionId)) return;

    try {
      const { AISessionsRepository } = await import('../../../storage/repositories/AISessionsRepository');
      const session = await AISessionsRepository.get(sessionId);
      if (!session) return;
      if ((session as any).hasBeenNamed === true) return;

      const generateTitle = (queryRef as any).generateSessionTitle;
      const askSide = (queryRef as any).askSideQuestion;
      if (typeof generateTitle !== 'function') {
        console.warn('[CLAUDE-CODE] naming skip: generateSessionTitle not exposed on Query');
        return;
      }

      this.sessionNamingSideQuestionFiredFor.add(sessionId);

      // Fire both in parallel; persist independently. allSettled so one failure
      // doesn't abort the other.
      await Promise.allSettled([
        this.runTitleGeneration(queryRef, sessionId, description, generateTitle),
        typeof askSide === 'function'
          ? this.runTagsPhaseSideQuestion(queryRef, sessionId, askSide)
          : Promise.resolve(),
      ]);

      // Default phase fallback — only if no phase has been set by either path
      // (agent prompt-instruction call, side-question parse, or prior turn).
      const refreshed = await AISessionsRepository.get(sessionId);
      const existingPhase = (refreshed?.metadata as any)?.phase;
      if (!existingPhase) {
        const fallbackMetadata = { phase: 'planning' };
        await AISessionsRepository.updateMetadata(sessionId, {
          metadata: fallbackMetadata,
        });
        // Mirror the broadcast/sync that SessionNamingService does for the
        // MCP-tool path so the kanban and iOS pick up the phase write.
        this.emit('session:metadata-updated', { sessionId, metadata: fallbackMetadata });
      }
    } catch (error) {
      // Best-effort -- never let naming errors disrupt the main session
      console.warn('[CLAUDE-CODE] Session naming failed:', (error as Error)?.message ?? error);
    }
  }

  private async runTitleGeneration(
    queryRef: Query,
    sessionId: string,
    description: string,
    generateTitle: any
  ): Promise<void> {
    try {
      // generateSessionTitle has no language parameter on the SDK surface, so
      // we steer it via the description string. This is best-effort -- the
      // SDK still ultimately decides.
      const { getPreferredAgentLanguage } = await import('../preferredAgentLanguageConfig');
      const language = getPreferredAgentLanguage();
      const promptDescription = language
        ? `${description}\n\n(Write the title in this language: ${language}.)`
        : description;

      const title: string | undefined = await generateTitle.call(queryRef, promptDescription, { persist: false });
      if (!title || typeof title !== 'string' || title.trim().length === 0) return;

      const trimmed = title.trim();
      const { SessionManager } = await import('../SessionManager');
      const manager = new SessionManager();
      await manager.initialize();
      await manager.updateSessionTitle(sessionId, trimmed);

      this.emit('session:title-updated', { sessionId, title: trimmed });
      // console.log(`[CLAUDE-CODE] generated session title for ${sessionId}: "${trimmed}"`);
    } catch (error) {
      console.warn('[CLAUDE-CODE] generateSessionTitle failed:', (error as Error)?.message ?? error);
    }
  }

  private async runTagsPhaseSideQuestion(
    queryRef: Query,
    sessionId: string,
    askSide: any
  ): Promise<void> {
    const VALID_PHASES = new Set(['backlog', 'planning', 'implementing', 'validating']);
    const prompt =
      'Reply with ONE line in this exact format and nothing else:\n' +
      'tag1,tag2,tag3|phase\n\n' +
      'Where:\n' +
      '- tags: 2-4 lowercase hyphen-separated tags (type of work + area, e.g. bug-fix,ui)\n' +
      '- phase: one of backlog, planning, implementing, validating\n' +
      'Base your answer on what the user asked for in this conversation.';

    try {
      const reply = await askSide.call(queryRef, prompt);
      const text: string | undefined = reply?.response;
      if (!text || typeof text !== 'string') return;

      // Take the first non-empty line of the reply and parse "tags|phase"
      const line = text.split('\n').map((l: string) => l.trim()).find((l: string) => l.length > 0);
      if (!line || !line.includes('|')) {
        console.warn(`[CLAUDE-CODE] tags+phase reply not parseable: "${text.slice(0, 200)}"`);
        return;
      }

      const [tagsRaw, phaseRaw] = line.split('|');
      const tags = (tagsRaw ?? '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
        .slice(0, 6);
      const phaseTrim = (phaseRaw ?? '').trim().toLowerCase();
      const phase = VALID_PHASES.has(phaseTrim) ? phaseTrim : undefined;

      if (tags.length === 0 && !phase) return;

      const { AISessionsRepository } = await import('../../../storage/repositories/AISessionsRepository');
      const update: Record<string, unknown> = {};
      if (tags.length > 0) update.tags = tags;
      if (phase) update.phase = phase;
      await AISessionsRepository.updateMetadata(sessionId, { metadata: update });
      // Broadcast + mobile-sync are wired in MessageStreamingHandler so the
      // kanban/sidebar and iOS pick up the write the same way they would
      // for an MCP-tool-driven update via SessionNamingService.
      this.emit('session:metadata-updated', { sessionId, metadata: update });
      // console.log(`[CLAUDE-CODE] applied side-question tags+phase for ${sessionId}: ${JSON.stringify(update)}`);
    } catch (error) {
      // Most likely "Query closed before response received" on short turns -- expected
      console.warn('[CLAUDE-CODE] tags+phase side-question failed:', (error as Error)?.message ?? error);
    }
  }

  /**
   * Interrupt the current turn so the session completes early.
   * The streaming loop breaks, the 'complete' chunk is still yielded,
   * and the AIService completion handler runs normally (including queue processing).
   * This is a graceful stop — unlike abort(), it doesn't kill the SDK subprocess.
   *
   * If there is no active lead query, defer to the BaseAIProvider default
   * (hard abort) so the caller still gets a sensible signal back.
   */
  async interruptCurrentTurn(): Promise<{ method: 'interrupt' | 'abort' }> {
    if (!this.leadQuery) {
      console.log('[CLAUDE-CODE] interruptCurrentTurn: no active lead query, falling back to abort');
      return super.interruptCurrentTurn();
    }

    console.log('[CLAUDE-CODE] interruptCurrentTurn: interrupting active lead query');
    this.wasInterrupted = true;

    // Resolve the interrupt promise so the Promise.race in the streaming loop
    // settles immediately without waiting for the SDK subprocess.
    if (this.interruptResolve) {
      this.interruptResolve();
      this.interruptResolve = null;
    }

    try {
      await this.leadQuery.interrupt();
    } catch (err) {
      console.warn('[CLAUDE-CODE] interruptCurrentTurn: interrupt() failed (transport may be closed):', err);
    }

    return { method: 'interrupt' };
  }

  /**
   * Interrupt the lead agent's current turn and queue a teammate message
   * to be delivered as a new user turn via streamInput.
   *
   * - If the lead is idle (no active query): stores the message for the next
   *   sendMessage() call and emits an event so AIService can trigger processing.
   * - If the lead has an active query: attempts interrupt() so the sendMessage()
   *   loop can inject the message via streamInput on the live transport. If the
   *   transport is already dead (turn finished but generator hasn't reached
   *   finally yet), interrupt() will fail gracefully and the message stays
   *   queued for the finally block to handle via resume.
   */
  async interruptWithMessage(message: string): Promise<void> {
    // A real teammate message arrived — reset the continuation guard so
    // the lead can get another continuation if its next turn also ends
    // with active teammates.
    this.continuationCount = 0;

    if (!this.leadQuery) {
      // Guard against duplicate idle triggers: if a teammate:messageWhileIdle event
      // was already emitted but sendMessage hasn't started yet, don't drain another.
      // The pending sendMessage will process the queue via its while loop.
      if (this.teammateIdleMessagePending) {
        console.log('[CLAUDE-CODE] interruptWithMessage: idle message already pending, skipping duplicate trigger');
        return;
      }

      const pendingMessageBatch = this.drainAndFormatPendingTeammateMessages();
      if (!pendingMessageBatch) return;

      console.log(`[CLAUDE-CODE] interruptWithMessage: lead is idle, triggering sendMessage for ${pendingMessageBatch.count} message(s): "${pendingMessageBatch.summaries}"`);
      this.emitTeammateMessageWhileIdle(pendingMessageBatch.formattedMessage);
      return;
    }

    // Interrupt the lead query. After interrupt(), the transport is dead and
    // streamInput will always fail. Set wasInterrupted so the while loop after
    // the for-await skips streamInput and lets the finally block re-trigger
    // delivery via a fresh sendMessage call.
    console.log('[CLAUDE-CODE] interruptWithMessage: interrupting active lead query');
    this.wasInterrupted = true;

    // Resolve the interrupt promise FIRST so the Promise.race in the streaming
    // loop settles immediately — this unblocks the JS side without waiting for
    // the SDK subprocess to acknowledge the interrupt.
    if (this.interruptResolve) {
      this.interruptResolve();
      this.interruptResolve = null;
    }

    try {
      await this.leadQuery.interrupt();
    } catch (err) {
      console.warn('[CLAUDE-CODE] interruptWithMessage: interrupt() failed (transport may be closed):', err);
    }
  }

  private handlePostLeadTurnTeammateState(sessionId: string | undefined, hideMessages: boolean): void {
    // If teammate messages are still queued (e.g. streamInput failed for a drained
    // message), re-trigger delivery now that leadQuery is null. This mirrors the
    // "lead is idle" path in interruptWithMessage.
    if (this.teammateManager.hasPendingTeammateMessages()) {
      const pendingMessageBatch = this.drainAndFormatPendingTeammateMessages();
      if (pendingMessageBatch) {
        console.log(`[CLAUDE-CODE] Re-triggering ${pendingMessageBatch.count} teammate message(s) after sendMessage exit: "${pendingMessageBatch.summaries}"`);
        this.emitTeammateMessageWhileIdle(pendingMessageBatch.formattedMessage);
      }
    } else if (this.transportDied) {
      // Transport died and no pending messages to re-trigger.
      // Abandon idle teammates since they can't be resumed.
      this.teammateManager.abandonIdleTeammates(sessionId);
    } else if (this.teammateManager.hasActiveTeammates() && !hideMessages) {
      // Skip for hidden commands (e.g., /context auto-fetch) — those are internal
      // bookkeeping calls that shouldn't drive teammate lifecycle.
      if (this.teammateManager.hasOnlyBackgroundAgents()) {
        // Only background agents (sub-agents) remain — no idle teammates to manage.
        // Don't trigger a continuation; the lead can't do anything useful for sub-agents.
        // The session stays deferred; teammates:allCompleted will fire when they finish
        // and deliverMessageToLead will restart the lead if there are results to deliver.
        console.log(`[CLAUDE-CODE] Lead turn ended with ${this.teammateManager.getActiveAgentCount()} background agent(s) still running, waiting for completion`);
        this.continuationCount = 0;
      } else if (this.teammateManager.hasPendingTeammateMessages()) {
        // Messages arrived while we were in the finally block (race between
        // streaming loop exit and interruptWithMessage). Drain and deliver them
        // instead of triggering a continuation or abandoning.
        const pendingMessageBatch = this.drainAndFormatPendingTeammateMessages();
        if (pendingMessageBatch) {
          console.log(`[CLAUDE-CODE] Finally block found ${pendingMessageBatch.count} pending teammate message(s), delivering: "${pendingMessageBatch.summaries}"`);
          this.continuationCount = 0;
          this.emitTeammateMessageWhileIdle(pendingMessageBatch.formattedMessage);
        }
      } else if (this.continuationCount < ClaudeCodeProvider.MAX_CONTINUATIONS) {
        // The lead's turn ended naturally but idle teammates exist that need managing.
        // Trigger a continuation so the lead gets another turn.
        // Guard: continuationCount prevents infinite loops if the lead's
        // continuation turns keep ending without resolving agents.
        console.log(`[CLAUDE-CODE] Lead turn ended with active agents, triggering continuation (${this.continuationCount + 1}/${ClaudeCodeProvider.MAX_CONTINUATIONS})`);
        this.continuationCount++;
        this.emitTeammateMessageWhileIdle('[System: Your previous turn ended but you still have active agents. Wait for their results, or take other actions as needed.]');
      } else {
        // Max continuations exhausted and the lead still didn't resolve teammates.
        // Abandon idle teammates to unstick the session.
        console.log(`[CLAUDE-CODE] Lead exhausted ${ClaudeCodeProvider.MAX_CONTINUATIONS} continuations without resolving teammates, abandoning idle teammates`);
        this.teammateManager.abandonIdleTeammates(sessionId);
        this.continuationCount = 0;
      }
    }
  }

  private drainAndFormatPendingTeammateMessages(): { formattedMessage: string; summaries: string; count: number } | null {
    const pendingMessages: TeammateToLeadMessage[] = [];
    while (this.teammateManager.hasPendingTeammateMessages()) {
      const message = this.teammateManager.drainNextTeammateMessage();
      if (message) {
        pendingMessages.push(message);
      } else {
        break;
      }
    }

    if (pendingMessages.length === 0) {
      return null;
    }

    return {
      formattedMessage: pendingMessages
        .map(message => `[Teammate message from "${message.teammateName}"]\n\n${message.content}`)
        .join('\n\n---\n\n'),
      summaries: pendingMessages.map(message => message.summary).join(', '),
      count: pendingMessages.length,
    };
  }

  private emitTeammateMessageWhileIdle(message: string): void {
    this.teammateIdleMessagePending = true;
    this.emit('teammate:messageWhileIdle', {
      sessionId: this.teammateManager.lastUsedSessionId,
      message,
    });
  }

  /**
   * Clean up provider resources including active subprocess
   * Called when provider is destroyed (e.g., app quit, session cleanup)
   */
  destroy(): void {
    console.log('[CLAUDE-CODE] Destroying provider');

    // Clean up permission service
    if (this.permissionService) {
      this.permissionService.clearSessionCache();
      this.permissionService.rejectAllPending();
    }

    // Abort any active SDK subprocess and reject all pending user interactions
    // Base class destroy() calls abort(), sessions.clear(), permissions.clearSessionCache(), and removeAllListeners()
    super.destroy();
  }

  /**
   * Stop a specific managed teammate by name
   */
  public stopManagedTeammate(name: string): boolean {
    return this.teammateManager.stop(name);
  }

  /**
   * Check if any teammates are still active (running or idle).
   * Used by AIService to decide whether to defer endSession().
   */
  public hasActiveTeammates(): boolean {
    return this.teammateManager.hasActiveTeammates();
  }

  /**
   * Check if the lead is currently processing or about to process a message.
   * True when leadQuery is set (actively streaming) or when a
   * teammate:messageWhileIdle event was emitted but sendMessage hasn't started yet.
   * Used by the teammates:allCompleted handler to avoid ending the session
   * while the lead is mid-turn.
   */
  public isLeadBusy(): boolean {
    return this.leadQuery !== null || this.teammateIdleMessagePending;
  }

  /**
   * Check if the lead will resume after the current query completes.
   * Unlike isLeadBusy(), this does NOT check leadQuery (which is still set
   * when called from inside the generator's for-await loop). Checks both:
   * - teammateIdleMessagePending: a re-trigger event was already emitted
   * - hasPendingTeammateMessages: messages are queued but not yet triggered
   *   (e.g., interruptWithMessage queued a message and called interrupt(),
   *   but the finally block hasn't run yet to re-trigger delivery)
   * Used by AIService's 'complete' chunk handler.
   */
  public willResumeAfterCompletion(): boolean {
    return this.teammateIdleMessagePending || this.teammateManager.hasPendingTeammateMessages();
  }

  /**
   * Process teammate-related side-effects after a tool_result is received.
   * Called from both chunk-processing paths to avoid duplication.
   */

  /** Handle system init chunk -- capture slash commands, skills, MCP health, etc. */
  private *handleSystemInit(
    chunk: any,
    sessionId: string | undefined,
    hideMessages: boolean,
    firstUserMessageDescription: string,
  ): Generator<StreamChunk> {
    // Clean up stale "running" tasks from previous sessions/restarts
    if (sessionId && this.activeTasks.size === 0) {
      (async () => {
        try {
          const { AISessionsRepository } = await import('../../../storage/repositories/AISessionsRepository');
          const currentSession = await AISessionsRepository.get(sessionId);
          const tasks = currentSession?.metadata?.currentTasks;
          if (Array.isArray(tasks) && tasks.some((t: any) => t.status === 'running')) {
            const cleaned = tasks.map((t: any) =>
              t.status === 'running' ? { ...t, status: 'stopped' } : t
            );
            await AISessionsRepository.updateMetadata(sessionId, {
              metadata: { ...currentSession?.metadata, currentTasks: cleaned }
            });
            this.emit('message:logged', { sessionId, direction: 'output' });
            // console.log(`[CLAUDE-CODE] Cleaned up ${tasks.filter((t: any) => t.status === 'running').length} stale running tasks`);
          }
        } catch {
          // Non-critical cleanup
        }
      })();
    }

    // Hydrate the in-memory task-list map from persisted metadata so TaskUpdate
    // deltas in a resumed session merge onto the existing board instead of
    // creating stubs (the map is per-provider-instance and starts empty).
    if (sessionId && this.taskListItems.size === 0) {
      (async () => {
        try {
          const { AISessionsRepository } = await import('../../../storage/repositories/AISessionsRepository');
          const currentSession = await AISessionsRepository.get(sessionId);
          const persisted = currentSession?.metadata?.currentTaskList;
          if (Array.isArray(persisted)) {
            for (const item of persisted as TaskListItem[]) {
              if (item && typeof item.id === 'string') this.taskListItems.set(item.id, item);
            }
          }
        } catch {
          // Non-critical hydration
        }
      })();
    }

    if (chunk.slash_commands && Array.isArray(chunk.slash_commands)) {
      this.slashCommands = chunk.slash_commands;
      ClaudeCodeProvider.cachedSdkSlashCommands = chunk.slash_commands;
    }
    if (chunk.skills && Array.isArray(chunk.skills)) {
      this.skills = chunk.skills;
      ClaudeCodeProvider.cachedSdkSkills = chunk.skills;
    }

    const mcpServerCount = Array.isArray(chunk.mcp_servers) ? chunk.mcp_servers.length : 0;
    (this as any)._initData = {
      mcpServerCount,
      slashCommandCount: Array.isArray(chunk.slash_commands) ? chunk.slash_commands.length : 0,
      agentCount: Array.isArray(chunk.agents) ? chunk.agents.length : 0,
      skillCount: Array.isArray(chunk.skills) ? chunk.skills.length : 0,
      pluginCount: Array.isArray(chunk.plugins) ? chunk.plugins.length : 0,
      toolCount: chunk.tools?.length || 0,
    };

    if (mcpServerCount > 0) {
      this.currentSessionId = sessionId;
      this.mcpQuery = this.leadQuery;
      this.checkMcpServerStatuses().catch(() => {});
      this.startMcpHealthChecks();
    }

    // Fire-and-forget session-naming side-question. Must run DURING the turn
    // (here, not post-turn) because the SDK calls transport.endInput() after the
    // first result chunk for both string-prompt and AsyncIterable paths, killing
    // the transport before any post-turn write could land. Init time is the
    // earliest safe moment: subprocess alive, stdin open, MCP servers connected.
    if (sessionId && this.leadQuery) {
      const queryRef = this.leadQuery;
      this.maybeFireSessionNamingSideQuestion(queryRef, sessionId, firstUserMessageDescription).catch(() => {});
    }
  }

  /** Handle system task chunks (task_started, task_progress, task_notification) */
  private handleSystemTask(subtype: string, chunk: any, sessionId: string | undefined): void {
    if (subtype === 'task_started') {
      this.activeTasks.set(chunk.task_id, {
        taskId: chunk.task_id,
        description: chunk.description || '',
        taskType: chunk.task_type,
        status: 'running',
        startedAt: Date.now(),
        toolUseId: chunk.tool_use_id,
        toolCount: 0,
        tokenCount: 0,
        durationMs: 0,
      });
      this.emitTaskUpdate(sessionId).catch(() => {});
    } else if (subtype === 'task_progress') {
      const existing = this.activeTasks.get(chunk.task_id);
      if (existing) {
        existing.toolCount = chunk.usage?.tool_uses ?? existing.toolCount;
        existing.tokenCount = chunk.usage?.total_tokens ?? existing.tokenCount;
        existing.durationMs = chunk.usage?.duration_ms ?? existing.durationMs;
        existing.lastToolName = chunk.last_tool_name ?? existing.lastToolName;
        this.emitTaskUpdate(sessionId).catch(() => {});
      }
    } else if (subtype === 'task_notification') {
      const existing = this.activeTasks.get(chunk.task_id);
      if (existing) {
        existing.status = chunk.status || 'completed';
        existing.summary = chunk.summary;
        if (chunk.usage) {
          existing.toolCount = chunk.usage.tool_uses ?? existing.toolCount;
          existing.tokenCount = chunk.usage.total_tokens ?? existing.tokenCount;
          existing.durationMs = chunk.usage.duration_ms ?? existing.durationMs;
        }
        this.emitTaskUpdate(sessionId).catch(() => {});
      }
    }
  }

  private processTeammateToolResult(
    sessionId: string | undefined,
    toolName: string,
    toolArguments: Record<string, unknown> | undefined,
    toolResult: unknown,
    isError: boolean,
    toolUseId?: string,
  ): void {
    // Detect shutdown_request results from SDK-handled SendMessage.
    // Skip if handlePreToolUse already handled this shutdown (resumed the teammate
    // for approval handshake) — otherwise we'd redundantly abort the just-resumed teammate.
    if (toolName === 'SendMessage' && toolArguments?.type === 'shutdown_request') {
      if (!this.teammateManager.consumeHandledShutdown(toolUseId)) {
        const shutdownRecipient = toolArguments.recipient;
        if (typeof shutdownRecipient === 'string' && shutdownRecipient) {
          this.teammateManager.handleShutdownResult(sessionId, shutdownRecipient);
        }
      }
    }

    // Track team context from TeamCreate/TeamDelete results
    this.teammateManager.updateTeamContextFromToolResult(
      toolName,
      toolArguments,
      toolResult,
      isError,
    );
  }

  /**
   * Update session metadata with current todos
   * Uses the existing metadata update mechanism instead of custom IPC events
   */
  private async handleScheduleWakeupTool(
    sessionId: string,
    workspacePath: string,
    args: { delaySeconds?: unknown; prompt?: unknown; reason?: unknown }
  ): Promise<void> {
    const rawDelay = args.delaySeconds;
    const delaySeconds = typeof rawDelay === 'number' ? rawDelay : Number(rawDelay);
    const prompt = typeof args.prompt === 'string' ? args.prompt : '';
    const reason = typeof args.reason === 'string' ? args.reason : '';

    if (!Number.isFinite(delaySeconds) || delaySeconds < 60 || delaySeconds > 604800) {
      console.warn(`[CLAUDE-CODE] ScheduleWakeup ignored: invalid delaySeconds=${rawDelay}`);
      return;
    }
    if (!prompt) {
      console.warn('[CLAUDE-CODE] ScheduleWakeup ignored: missing prompt');
      return;
    }

    const handler = ClaudeCodeProvider.scheduleWakeupHandler;
    if (!handler) {
      console.warn('[CLAUDE-CODE] ScheduleWakeup ignored: no handler registered');
      return;
    }

    await handler({ sessionId, workspacePath, delaySeconds, prompt, reason });
  }

  private async emitTodoUpdate(sessionId: string | undefined, todos: any[]): Promise<void> {

    if (!sessionId) {
      return;
    }

    try {
      // Update session metadata with the current todos
      // This will trigger session reloads which will update the UI

      // Import AISessionsRepository dynamically
      const { AISessionsRepository } = await import('../../../storage/repositories/AISessionsRepository');

      // Get current session to merge metadata
      const currentSession = await AISessionsRepository.get(sessionId);

      const currentMetadata = currentSession?.metadata || {};

      await AISessionsRepository.updateMetadata(sessionId, {
        metadata: {
          ...currentMetadata,
          currentTodos: todos
        }
      });


      // Emit message:logged event to trigger UI reload
      // This will cause the AgenticPanel to reload the session and pick up the new todos
      this.emit('message:logged', {
        sessionId,
        direction: 'output'
      });
    } catch (error) {
      console.error('[CLAUDE-CODE] Failed to update session metadata with todos:', error);
      console.error('[CLAUDE-CODE] Error stack:', error instanceof Error ? error.stack : 'No stack trace');
    }
  }

  private async emitTaskUpdate(sessionId: string | undefined): Promise<void> {
    if (!sessionId) return;

    try {
      const { AISessionsRepository } = await import('../../../storage/repositories/AISessionsRepository');
      const currentSession = await AISessionsRepository.get(sessionId);
      const currentMetadata = currentSession?.metadata || {};

      await AISessionsRepository.updateMetadata(sessionId, {
        metadata: {
          ...currentMetadata,
          currentTasks: Array.from(this.activeTasks.values()),
        }
      });

      this.emit('message:logged', { sessionId, direction: 'output' });
    } catch (error) {
      console.error('[CLAUDE-CODE] Failed to update session metadata with tasks:', error);
    }
  }

  /**
   * Reconstruct the SDK-native task list from TaskCreate/TaskUpdate tool calls.
   * TaskUpdate only carries the changed fields, so we keep a running map keyed by
   * the SDK-assigned id and merge each mutation. TaskCreate does not echo the id
   * in its args — it appears only in the result text ("Task #3 created ...") — so
   * this must run on tool_result, not tool_use.
   */
  private captureTaskListMutation(
    sessionId: string | undefined,
    toolName: string,
    args: Record<string, unknown> | undefined,
    resultContent: unknown,
  ): void {
    if (!sessionId) return;
    const resultText = typeof resultContent === 'string' ? resultContent : '';
    const changed = applyTaskListMutation(this.taskListItems, toolName, args, resultText);
    if (changed) {
      this.emitTaskListUpdate(sessionId).catch(() => {});
    }
  }

  private async emitTaskListUpdate(sessionId: string | undefined): Promise<void> {
    if (!sessionId) return;
    try {
      const { AISessionsRepository } = await import('../../../storage/repositories/AISessionsRepository');
      const currentSession = await AISessionsRepository.get(sessionId);
      const currentMetadata = currentSession?.metadata || {};

      await AISessionsRepository.updateMetadata(sessionId, {
        metadata: {
          ...currentMetadata,
          // Sorted by numeric id so the board renders in creation order.
          currentTaskList: sortTaskList(this.taskListItems.values()),
        }
      });

      this.emit('message:logged', { sessionId, direction: 'output' });
    } catch (error) {
      console.error('[CLAUDE-CODE] Failed to update session metadata with task list:', error);
    }
  }

  /**
   * Start periodic MCP server health checks during an active session.
   * Polls the SDK for server status and emits events when servers disconnect.
   */
  private startMcpHealthChecks(): void {
    this.stopMcpHealthChecks();
    // Poll every 30 seconds
    this.mcpHealthCheckInterval = setInterval(() => {
      this.checkMcpServerStatuses().catch(() => {});
    }, 30_000);
  }

  private stopMcpHealthChecks(): void {
    if (this.mcpHealthCheckInterval) {
      clearInterval(this.mcpHealthCheckInterval);
      this.mcpHealthCheckInterval = null;
    }
  }

  /**
   * Query MCP server status from the SDK and emit events for any changes.
   * Uses mcpQuery (persistent across turns) rather than leadQuery (per-turn).
   */
  private async checkMcpServerStatuses(): Promise<void> {
    const q = this.mcpQuery;
    if (!q) return;

    try {
      const statuses: McpServerStatusInfo[] = await q.mcpServerStatus();
      const changes: McpServerStatusInfo[] = [];

      for (const server of statuses) {
        const prev = this.mcpServerStatuses.get(server.name);
        if (!prev || prev.status !== server.status) {
          changes.push(server);
          if (prev && prev.status === 'connected' && server.status === 'failed') {
            console.warn(`[CLAUDE-CODE] MCP server "${server.name}" disconnected: ${server.error || 'unknown reason'}`);
          }
        }
        this.mcpServerStatuses.set(server.name, server);
      }

      if (changes.length > 0) {
        this.emit('mcpServerStatus:changed', {
          sessionId: this.currentSessionId,
          servers: Array.from(this.mcpServerStatuses.values()),
          changes,
        });
      }
    } catch {
      // Query may be closing, ignore
    }
  }

  /**
   * Reconnect a disconnected MCP server by name.
   * Can be called from the UI via IPC.
   * Uses mcpQuery (persistent across turns) so reconnect works between turns.
   */
  async reconnectMcpServer(serverName: string): Promise<void> {
    const q = this.mcpQuery;
    if (!q) {
      throw new Error('No active session to reconnect MCP server');
    }
    console.log(`[CLAUDE-CODE] Reconnecting MCP server: ${serverName}`);
    await q.reconnectMcpServer(serverName);
    // Re-check statuses immediately after reconnect attempt
    await this.checkMcpServerStatuses();
  }

  /**
   * Get current MCP server statuses (cached from last health check).
   */
  getMcpServerStatuses(): McpServerStatusInfo[] {
    return Array.from(this.mcpServerStatuses.values());
  }

  getCapabilities(): ProviderCapabilities {
    return {
      streaming: true,
      tools: true,
      mcpSupport: true,  // Full MCP support
      edits: true,
      resumeSession: true,  // Can resume Claude Code sessions
      supportsFileTools: true  // Uses tools to access files (Read, Glob, etc.)
    };
  }

  getProviderSessionData(sessionId: string): any {
    const { providerSessionId } = this.sessions.getProviderSessionData(sessionId);
    return {
      claudeSessionId: providerSessionId,
    };
  }

  /**
   * Handle ExitPlanMode in canUseTool - blocks until user approves or denies.
   * This is the primary mechanism for ExitPlanMode confirmation since the Claude Agent SDK
   * does not support the `hooks` option. The canUseTool callback is the only way to block
   * tool execution from the SDK.
   */
  private async handleExitPlanMode(
    sessionId: string | undefined,
    input: any,
    options: { signal: AbortSignal; toolUseID?: string },
  ): Promise<{ behavior: 'allow' | 'deny'; updatedInput?: any; message?: string }> {
    // If not in planning mode, allow immediately (no confirmation needed)
    if (this.currentMode !== 'planning') {
      return { behavior: 'allow', updatedInput: input };
    }

    const planFilePath = input?.planFilePath || '';
    if (!planFilePath) {
      return {
        behavior: 'deny',
        message: 'ExitPlanMode requires the planFilePath argument. Try ExitPlanMode again and include the fully qualified plan file path.',
      };
    }

    const requestId = options.toolUseID || `exit-plan-${sessionId}-${Date.now()}`;
    const planSummary = input?.plan || '';

    // Create a promise that will be resolved when user responds via the widget
    const confirmationPromise = new Promise<{ approved: boolean; clearContext?: boolean; feedback?: string }>((resolve, reject) => {
      this.pendingExitPlanModeConfirmations.set(requestId, { resolve, reject });

      if (options.signal) {
        options.signal.addEventListener('abort', () => {
          this.pendingExitPlanModeConfirmations.delete(requestId);
          // Persist cancellation to DB so orphaned requests don't appear as perpetually pending
          if (sessionId) {
            const cancelContent = {
              type: 'exit_plan_mode_response' as const,
              requestId,
              approved: false,
              cancelled: true,
              respondedAt: Date.now(),
              respondedBy: 'system',
            };
            this.logAgentMessage(
              sessionId, 'claude-code', 'output',
              JSON.stringify(cancelContent),
              { messageType: 'exit_plan_mode_response' }
            ).catch(() => {});
          }
          reject(new Error('Request aborted'));
        }, { once: true });
      }
    });

    // Persist the request as a durable prompt
    const exitPlanModeContent = {
      type: 'exit_plan_mode_request' as const,
      requestId,
      planSummary,
      planFilePath,
      timestamp: Date.now(),
      status: 'pending' as const,
    };

    if (sessionId) {
      await this.logAgentMessage(
        sessionId, 'claude-code', 'output',
        JSON.stringify(exitPlanModeContent),
        { messageType: 'exit_plan_mode_request' }
      );
    }

    // Emit event to notify renderer to show confirmation UI
    this.emit('exitPlanMode:confirm', {
      requestId,
      sessionId,
      planSummary,
      planFilePath,
      timestamp: Date.now(),
    });

    try {
      const response = await confirmationPromise;

      if (response.approved) {
        this.currentMode = 'agent';
        return { behavior: 'allow', updatedInput: input };
      } else {
        const feedbackText = response.feedback
          ? `\n\nUser feedback: "${response.feedback}"`
          : '';
        return {
          behavior: 'deny',
          message: `The user chose to continue planning.${feedbackText}`,
        };
      }
    } catch (error) {
      return {
        behavior: 'deny',
        message: 'ExitPlanMode was cancelled or interrupted.',
      };
    }
  }

  /**
   * Resolve a pending ExitPlanMode confirmation request
   * Called by AIService when renderer responds to confirmation prompt
   * @param requestId - Unique ID for this confirmation request
   * @param response - User's response containing:
   *   - approved: Whether to exit plan mode
   *   - clearContext: If true, clear the session context for a fresh start
   *   - feedback: Optional feedback message when denying (continue planning)
   */
  public resolveExitPlanModeConfirmation(
    requestId: string,
    response: { approved: boolean; clearContext?: boolean; feedback?: string },
    sessionId?: string,
    respondedBy: 'desktop' | 'mobile' = 'desktop'
  ): void {
    const pending = this.pendingExitPlanModeConfirmations.get(requestId);
    if (pending) {
      pending.resolve(response);
      this.pendingExitPlanModeConfirmations.delete(requestId);

      // Mirror AskUserQuestion / ToolPermission semantics: emit a resolved
      // event so MessageStreamingHandler can flip the SessionStateManager
      // status back to 'running'. Without this, the multi-project rail
      // misses the resume transition after an ExitPlanMode denial and the
      // "Thinking…" spinner stays hidden until the rail is remounted.
      this.emit('exitPlanMode:resolved', {
        requestId,
        sessionId,
        approved: response.approved,
        respondedBy,
        timestamp: Date.now(),
      });

      // Persist the response as a message for sync and audit trail
      if (sessionId) {
        const responseContent = {
          type: 'exit_plan_mode_response' as const,
          requestId,
          approved: response.approved,
          clearContext: response.clearContext,
          feedback: response.feedback,
          respondedAt: Date.now(),
          respondedBy,
        };
        this.logAgentMessage(
          sessionId,
          'claude-code',
          'output',
          JSON.stringify(responseContent),
          { messageType: 'exit_plan_mode_response' }
        ).catch(err => {
          console.error('[CLAUDE-CODE] Failed to persist ExitPlanMode response:', err);
        });
      }
      // TODO: Debug logging - uncomment if needed
    } else {
      console.warn(`[CLAUDE-CODE] No pending ExitPlanMode confirmation found for requestId: ${requestId}`);
    }
  }

  /**
   * Reject all pending ExitPlanMode confirmations (e.g., on abort)
   */
  public rejectAllPendingConfirmations(): void {
    for (const [requestId, pending] of this.pendingExitPlanModeConfirmations) {
      pending.reject(new Error('Request aborted'));
    }
    this.pendingExitPlanModeConfirmations.clear();
  }

  /**
   * Resolve a pending AskUserQuestion request with user's answers
   * Called by IPC handler when renderer provides answers
   * @param sessionId - Session ID for persisting the response message
   * @param respondedBy - Device that responded ('desktop' or 'mobile')
   */
  public resolveAskUserQuestion(
    questionId: string,
    answers: Record<string, string>,
    sessionId?: string,
    respondedBy: 'desktop' | 'mobile' = 'desktop'
  ): boolean {
    const pending = this.pendingAskUserQuestions.get(questionId);
    if (pending) {
      pending.resolve(answers);
      this.pendingAskUserQuestions.delete(questionId);

      // Log as nimbalyst_tool_result to complete the tool call
      // This sets toolCall.result which changes widget from interactive to completed
      if (sessionId) {
        this.logAgentMessage(
          sessionId,
          'claude-code',
          'output',
          JSON.stringify({
            type: 'nimbalyst_tool_result',
            tool_use_id: questionId,
            result: JSON.stringify({ answers, respondedAt: Date.now(), respondedBy })
          })
        ).catch(err => {
          console.error('[CLAUDE-CODE] Failed to persist AskUserQuestion response:', err);
        });
      }
      return true;
    } else {
      console.warn(`[CLAUDE-CODE] No pending AskUserQuestion found for questionId: ${questionId}`);
      return false;
    }
  }

  /**
   * Reject a pending AskUserQuestion request (e.g., on cancel/abort)
   */
  public rejectAskUserQuestion(questionId: string, error: Error): void {
    const pending = this.pendingAskUserQuestions.get(questionId);
    if (pending) {
      pending.reject(error);
      this.pendingAskUserQuestions.delete(questionId);
      // The cancelled tool result is logged by handleAskUserQuestionTool's catch block,
      // which fires when the promise rejects. It correctly handles all questionId formats
      // (both legacy ask-{sessionId}-{timestamp} and new toolu_... Claude tool use IDs).
    }
  }

  /**
   * Reject all pending AskUserQuestion requests (e.g., on abort)
   */
  public rejectAllPendingQuestions(): void {
    for (const [questionId, pending] of this.pendingAskUserQuestions) {
      pending.reject(new Error('Request aborted'));
    }
    this.pendingAskUserQuestions.clear();
  }

  /**
   * Resolve a pending Bash permission request with user's response
   * Called by IPC handler when renderer provides a permission response
   * @param sessionId - Session ID for persisting the response message
   * @param respondedBy - Device that responded ('desktop' or 'mobile')
   */
  public resolveToolPermission(
    requestId: string,
    response: { decision: 'allow' | 'deny'; scope: 'once' | 'session' | 'always' | 'always-all' },
    sessionId?: string,
    respondedBy: 'desktop' | 'mobile' = 'desktop'
  ): void {
    // Try ToolPermissionService first (primary path when service is available)
    if (this.permissionService) {
      this.permissionService.resolvePermission(requestId, response);
    }

    // Also check the inline pending map (used by AgentToolHooks compound bash checks,
    // including those from teammate sessions which create promises in this map)
    if (this.permissions.pendingToolPermissions.has(requestId)) {
      this.permissions.resolveToolPermission(
        requestId,
        response,
        (_reqId, resp, by) => {
          if (sessionId) {
            this.logAgentMessage(
              sessionId,
              'claude-code',
              'output',
              this.createPermissionResultMessage(_reqId, resp, by)
            ).catch(err => {
              console.error('[CLAUDE-CODE] Failed to persist permission response:', err);
            });
          }
        },
        respondedBy
      );
      return;
    }

    // Persist the response as nimbalyst_tool_result for widget rendering
    if (this.permissionService && sessionId) {
      this.logAgentMessage(
        sessionId,
        'claude-code',
        'output',
        this.createPermissionResultMessage(requestId, response, respondedBy)
      ).catch(err => {
        console.error('[CLAUDE-CODE] Failed to persist permission response:', err);
      });
      return;
    }

    // Fallback: resolve via the mixin's pending map (for tests or when service not available)
    this.permissions.resolveToolPermission(
      requestId,
      response,
      (_reqId, resp, by) => {
        if (sessionId) {
          this.logAgentMessage(
            sessionId,
            'claude-code',
            'output',
            this.createPermissionResultMessage(_reqId, resp, by)
          ).catch(err => {
            console.error('[CLAUDE-CODE] Failed to persist permission response:', err);
          });
        }
      },
      respondedBy
    );
  }

  /**
   * Reject a pending tool permission request (e.g., on cancel/abort)
   * @param sessionId - Session ID for persisting the cancellation message
   */
  public rejectToolPermission(requestId: string, error: Error, sessionId?: string): void {
    // Try ToolPermissionService first (primary path)
    if (this.permissionService) {
      this.permissionService.rejectPermission(requestId, error);
      if (sessionId) {
        this.logAgentMessage(
          sessionId,
          'claude-code',
          'output',
          this.createPermissionCancellationMessage(requestId)
        ).catch(err => {
          console.error('[CLAUDE-CODE] Failed to persist permission cancellation:', err);
        });
      }
      return;
    }

    // Fallback: reject via the mixin's pending map
    this.permissions.rejectToolPermission(requestId, error, (_reqId) => {
      if (sessionId) {
        this.logAgentMessage(
          sessionId,
          'claude-code',
          'output',
          this.createPermissionCancellationMessage(_reqId)
        ).catch(err => {
          console.error('[CLAUDE-CODE] Failed to persist permission cancellation:', err);
        });
      }
    });
  }

  /**
   * Reject all pending tool permission requests (e.g., on abort)
   */
  public rejectAllPendingPermissions(): void {
    this.permissions.rejectAllPendingPermissions();
  }

  /**
   * Poll for a permission response message in the session.
   * This enables mobile and cross-session responses.
   * When a response is found, it resolves the pending permission promise.
   */
  protected async pollForPermissionResponse(
    sessionId: string,
    requestId: string,
    signal: AbortSignal
  ): Promise<void> {
    const pollInterval = 500; // ms
    const maxPollTime = 10 * 60 * 1000; // 10 minutes max
    const startTime = Date.now();

    while (!signal.aborted && Date.now() - startTime < maxPollTime) {
      // Check if request was already resolved (e.g., via IPC)
      if (!this.permissions.pendingToolPermissions.has(requestId)) {
        return; // Already resolved, stop polling
      }

      try {
        // Get recent messages for this session
        const messages = await AgentMessagesRepository.list(sessionId, { limit: 50 });

        // Look for a nimbalyst_tool_result that matches our requestId
        for (const msg of messages) {
          try {
            const content = JSON.parse(msg.content);
            // Check for new nimbalyst_tool_result format
            if (content.type === 'nimbalyst_tool_result' && content.tool_use_id === requestId) {
              // Found a response - parse the result and resolve
              const result = typeof content.result === 'string' ? JSON.parse(content.result) : content.result;
              const pending = this.permissions.pendingToolPermissions.get(requestId);
              if (pending && result.decision) {
                pending.resolve({
                  decision: result.decision,
                  scope: result.scope
                });
                this.permissions.pendingToolPermissions.delete(requestId);
                this.logSecurity('[pollForPermissionResponse] Found nimbalyst_tool_result:', {
                  requestId,
                  decision: result.decision,
                  scope: result.scope,
                  respondedBy: result.respondedBy
                });
              }
              return;
            }
            // Legacy: also check for permission_response (for backwards compatibility)
            if (content.type === 'permission_response' && content.requestId === requestId) {
              const pending = this.permissions.pendingToolPermissions.get(requestId);
              if (pending) {
                pending.resolve({
                  decision: content.decision,
                  scope: content.scope
                });
                this.permissions.pendingToolPermissions.delete(requestId);
                this.logSecurity('[pollForPermissionResponse] Found legacy permission_response:', {
                  requestId,
                  decision: content.decision,
                  scope: content.scope,
                  respondedBy: content.respondedBy
                });
              }
              return;
            }
          } catch {
            // Not valid JSON, skip
          }
        }
      } catch (error) {
        // Log but continue polling
        console.error('[CLAUDE-CODE] Error polling for permission response:', error);
      }

      // Wait before polling again
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }

    // Timeout - don't reject, let IPC path handle it or let it stay pending
    this.logSecurity('[pollForPermissionResponse] Polling timed out:', { requestId });
  }

  /**
   * Poll for an AskUserQuestion response message in the session.
   * This enables mobile and cross-session responses.
   * When a response is found, it resolves the pending question promise.
   */
  private async pollForAskUserQuestionResponse(
    sessionId: string,
    questionId: string,
    signal: AbortSignal
  ): Promise<void> {
    return pollForAskUserQuestionResponse(
      {
        pendingAskUserQuestions: this.pendingAskUserQuestions,
        listRecentMessages: async (resolvedSessionId, limit) =>
          AgentMessagesRepository.list(resolvedSessionId, { limit }),
        logTimeout: (resolvedQuestionId) =>
          this.logSecurity('[pollForAskUserQuestionResponse] Polling timed out:', { questionId: resolvedQuestionId }),
        logResolved: (resolvedQuestionId, answersCount, respondedBy) =>
          this.logSecurity('[pollForAskUserQuestionResponse] Found response message:', {
            questionId: resolvedQuestionId,
            answersCount,
            respondedBy
          }),
        logCancelled: (resolvedQuestionId, respondedBy) =>
          this.logSecurity('[pollForAskUserQuestionResponse] Question cancelled:', {
            questionId: resolvedQuestionId,
            respondedBy
          }),
        logError: (error) =>
          console.error('[CLAUDE-CODE] Error polling for AskUserQuestion response:', error),
      },
      {
        sessionId,
        questionId,
        signal,
      }
    );
  }


  /**
   * Build a human-readable description of a tool call for permission checking.
   * For Bash, the command itself is used. For other tools, we create a descriptive string.
   */

  /**
   * Create canUseTool handler for permission requests.
   * The SDK evaluates settings.json rules first. This handler is only called when:
   * 1. No matching rule was found in settings.json
   * 2. The tool needs user approval
   *
   * Our job is to show UI, wait for user response, and save patterns if "Always" is chosen.
   */
  private createCanUseToolHandler(sessionId?: string, workspacePath?: string, permissionsPath?: string, teammateName?: string) {
    // Use permissionsPath for trust checks (parent project for worktrees), workspacePath for everything else
    const pathForTrust = permissionsPath || workspacePath;

    let canUseToolCallCount = 0;

    return async (
      toolName: string,
      input: any,
      options: { signal: AbortSignal; suggestions?: any[]; toolUseID?: string }
    ): Promise<{ behavior: 'allow' | 'deny'; updatedInput?: any; message?: string }> => {
      const callNum = ++canUseToolCallCount;
      const callStart = Date.now();
      // console.log(`[canUseTool] #${callNum} ENTER tool="${toolName}" toolUseID=${options.toolUseID}`);

      let result: { behavior: 'allow' | 'deny'; updatedInput?: any; message?: string };

      try {
        const immediateDecision = await this.resolveImmediateToolDecision(
          toolName,
          input,
          options,
          sessionId,
          pathForTrust
        );
        if (immediateDecision) {
          result = immediateDecision;
        } else if (this.permissionService && sessionId && workspacePath) {
          result = await this.handleToolPermissionWithService(
            toolName,
            input,
            options,
            sessionId,
            workspacePath,
            permissionsPath,
            teammateName
          );
        } else {
          result = await this.handleToolPermissionFallback(toolName, input, options, sessionId, workspacePath);
        }
      } catch (error) {
        console.error(`[canUseTool] #${callNum} EXCEPTION tool="${toolName}" after ${Date.now() - callStart}ms:`, error);
        throw error;
      }

      // Normalize the response to satisfy the native binary's Zod schema:
      // - allow MUST have updatedInput (Record)
      // - deny MUST have message (string)
      if (result.behavior === 'allow' && result.updatedInput === undefined) {
        result.updatedInput = input;
      } else if (result.behavior === 'deny' && result.message === undefined) {
        result.message = 'Tool call denied';
      }

      // console.log(`[canUseTool] #${callNum} EXIT tool="${toolName}" -> ${result.behavior} (${Date.now() - callStart}ms)`);

      return result;
    };
  }

  private async resolveImmediateToolDecision(
    toolName: string,
    input: any,
    options: { signal: AbortSignal; suggestions?: any[]; toolUseID?: string },
    sessionId: string | undefined,
    pathForTrust: string | undefined
  ): Promise<{ behavior: 'allow' | 'deny'; updatedInput?: any; message?: string } | null> {
    return resolveImmediateToolDecisionHelper(
      {
        internalMcpTools: INTERNAL_MCP_TOOLS,
        teamTools: TEAM_TOOLS,
        trustChecker: BaseAgentProvider.trustChecker ?? undefined,
        resolveTeamContext: (resolvedSessionId) => this.teammateManager.resolveTeamContext(resolvedSessionId),
        handleAskUserQuestion: (resolvedSessionId, resolvedInput, resolvedOptions, resolvedToolUseId) =>
          this.handleAskUserQuestion(resolvedSessionId, resolvedInput, resolvedOptions, resolvedToolUseId),
        handleExitPlanMode: (resolvedSessionId, resolvedInput, resolvedOptions) =>
          this.handleExitPlanMode(resolvedSessionId, resolvedInput, resolvedOptions),
        setCurrentMode: (mode) => { this.currentMode = mode; },
        getCurrentMode: () => this.currentMode,
        logSecurity: (message, data) => this.logSecurity(message, data),
      },
      {
        toolName,
        input,
        options,
        sessionId,
        pathForTrust,
      }
    );
  }

  private async handleToolPermissionWithService(
    toolName: string,
    input: any,
    options: { signal: AbortSignal; suggestions?: any[]; toolUseID?: string },
    sessionId: string,
    workspacePath: string,
    permissionsPath: string | undefined,
    teammateName: string | undefined
  ): Promise<{ behavior: 'allow' | 'deny'; updatedInput?: any; message?: string }> {
    return handleToolPermissionWithServiceHelper(
      {
        logSecurity: (message, data) => this.logSecurity(message, data),
        logAgentMessage: (resolvedSessionId, content) =>
          this.logAgentMessage(resolvedSessionId, 'claude-code', 'output', content),
        requestToolPermission: (request) => this.permissionService!.requestToolPermission(request),
      },
      {
        toolName,
        input,
        options,
        sessionId,
        workspacePath,
        permissionsPath,
        teammateName
      }
    );
  }

  private async handleToolPermissionFallback(
    toolName: string,
    input: any,
    options: { signal: AbortSignal; suggestions?: any[]; toolUseID?: string },
    sessionId: string | undefined,
    workspacePath: string | undefined
  ): Promise<{ behavior: 'allow' | 'deny'; updatedInput?: any; message?: string }> {
    return handleToolPermissionFallbackHelper(
      {
        permissions: this.permissions,
        logSecurity: (message, data) => this.logSecurity(message, data),
        logAgentMessage: (resolvedSessionId, content) =>
          this.logAgentMessage(resolvedSessionId, 'claude-code', 'output', content),
        emit: (event, payload) => this.emit(event, payload),
        pollForPermissionResponse: (resolvedSessionId, requestId, signal) =>
          this.pollForPermissionResponse(resolvedSessionId, requestId, signal),
        savePattern: ClaudeCodeDeps.claudeSettingsPatternSaver
          ? (path, pattern) => ClaudeCodeDeps.claudeSettingsPatternSaver!(path, pattern)
          : undefined,
        logError: (message, error) => console.error(message, error),
      },
      {
        toolName,
        input,
        options,
        sessionId,
        workspacePath,
      }
    );
  }

  /**
   * Handle AskUserQuestion tool - get user input for questions
   *
   * The toolUseID is the SDK's ID for this tool call. We use it so our synthetic
   * tool_use message has the same ID the SDK will use, allowing the widget to
   * correlate the pending question with the eventual tool_result.
   */
  private async handleAskUserQuestion(
    sessionId: string | undefined,
    input: any,
    options: { signal: AbortSignal },
    toolUseID?: string
  ): Promise<{ behavior: 'allow' | 'deny'; updatedInput?: any; message?: string }> {
    return handleAskUserQuestionTool(
      {
        sessionId,
        pendingAskUserQuestions: this.pendingAskUserQuestions,
        pollForResponse: (resolvedSessionId, questionId, signal) =>
          this.pollForAskUserQuestionResponse(resolvedSessionId, questionId, signal),
        emit: (event, payload) => this.emit(event, payload),
        logAgentMessage: async (resolvedSessionId, content) =>
          this.logAgentMessage(resolvedSessionId, 'claude-code', 'output', content),
        onError: (error) => {
          console.error('[CLAUDE-CODE] AskUserQuestion failed:', error);
        },
      },
      {
        input,
        signal: options.signal,
        toolUseID,
      }
    );
  }


  protected buildSystemPrompt(documentContext?: DocumentContext, enableAgentTeams?: boolean, isMetaAgent: boolean = false): string {
    if (isMetaAgent) {
      // TODO: Get workflowPreset from session metadata or documentContext
      return buildMetaAgentSystemPrompt('claude', 'default', {
        provider: 'claude-code',
        model: this.config.model ?? undefined,
      });
    }

    const hasSessionNaming = ClaudeCodeDeps.sessionNamingServerPort !== null;
    const worktreePath = documentContext?.worktreePath;
    const isVoiceMode = (documentContext as any)?.isVoiceMode;
    const voiceModeCodingAgentPrompt = (documentContext as any)?.voiceModeCodingAgentPrompt;

    const prompt = buildClaudeCodeSystemPrompt({
      hasSessionNaming,
      // claude-code generates titles out-of-band via the SDK's generateSessionTitle
      // (see maybeFireSessionNamingSideQuestion). Other providers must keep
      // hasOutOfBandNaming = false so the agent still names the session itself.
      hasOutOfBandNaming: true,
      worktreePath,
      isVoiceMode,
      voiceModeCodingAgentPrompt,
      enableAgentTeams,
    });

    // console.log('[CLAUDE-CODE] Built system prompt - length:', prompt.length, 'characters');
    return prompt;
  }

  /**
   * Get Claude Code models.
   * Returns standard models plus Sonnet 1M variant (access controlled by Anthropic).
   */
  static async getModels(): Promise<AIModel[]> {
    const models: AIModel[] = [];

    // Add models in desired order
    for (const variant of CLAUDE_CODE_VARIANTS) {
      const baseContextWindow = variant === 'fable' ? 1000000 : 200000;
      // Add base model. Fable is 1M by default on supported Claude Code surfaces.
      models.push({
        id: ModelIdentifier.create('claude-code', variant).combined,
        name: `Claude Agent · ${CLAUDE_CODE_MODEL_LABELS[variant]} ${CLAUDE_CODE_VARIANT_VERSIONS[variant]}${variant === 'fable' ? ' (1M)' : ''}`,
        provider: 'claude-code' as const,
        maxTokens: 8192,
        contextWindow: baseContextWindow
      });

      // Add 1M context variant if the variant supports it.
      // 1M context is GA at standard pricing (March 2026).
      if ((CLAUDE_CODE_VARIANTS_WITH_1M as readonly string[]).includes(variant)) {
        models.push({
          id: ModelIdentifier.create('claude-code', `${variant}-1m`).combined,
          name: `Claude Agent · ${CLAUDE_CODE_MODEL_LABELS[variant]} ${CLAUDE_CODE_VARIANT_VERSIONS[variant]} (1M)`,
          provider: 'claude-code' as const,
          maxTokens: 8192,
          contextWindow: 1000000
        });
      }

    }

    return models;
  }

  /**
   * Get default model
   */
  static getDefaultModel(): string {
    return this.DEFAULT_MODEL;
  }

  /**
   * Get available slash commands discovered from the SDK.
   * Falls back to static cache from a previous session if this provider hasn't initialized yet.
   */
  getSlashCommands(): string[] {
    const commands = this.slashCommands.length > 0 ? this.slashCommands : ClaudeCodeProvider.cachedSdkSlashCommands;
    return [...commands];
  }

  /**
   * Get available skills discovered from the SDK init payload.
   * Falls back to static cache from a previous session if this provider hasn't initialized yet.
   */
  getSkills(): string[] {
    const skills = this.skills.length > 0 ? this.skills : ClaudeCodeProvider.cachedSdkSkills;
    return [...skills];
  }

  /**
   * Static accessors for the SDK cache - used by AIService when no provider instance exists.
   */
  static getCachedSdkSlashCommands(): string[] {
    return [...ClaudeCodeProvider.cachedSdkSlashCommands];
  }

  static getCachedSdkSkills(): string[] {
    return [...ClaudeCodeProvider.cachedSdkSkills];
  }

  /**
   * Get the known built-in Claude Code slash commands
   * These are always available, even before a session is initialized
   */
  static getKnownSlashCommands(): string[] {
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
   * Get initialization data for analytics tracking
   * Returns counts for MCP servers, slash commands, agents, skills, plugins, tools, and helper method
   */
  getInitData(): {
    mcpServerCount: number;
    slashCommandCount: number;
    agentCount: number;
    skillCount: number;
    pluginCount: number;
    toolCount: number;
    helperMethod: 'native' | 'custom';
  } | null {
    const baseData = (this as any)._initData;
    if (!baseData) return null;
    return {
      ...baseData,
      helperMethod: this.helperMethod
    };
  }

  /**
   * Soft diagnostic: checks whether a session ID appears in ~/.claude/history.jsonl.
   * Not authoritative -- history.jsonl races with SDK writes and may not reflect
   * programmatic sessions at all. Callers must treat a false result as a hint, not
   * a decision. Fails open (returns true) when the file is missing or unreadable.
   */
  private async checkSessionExists(sessionId: string): Promise<boolean> {
    try {
      const os = await import('os');
      const fs = await import('fs/promises');
      const path = await import('path');

      const historyPath = path.join(os.homedir(), '.claude', 'history.jsonl');

      let content: string;
      try {
        content = await fs.readFile(historyPath, 'utf-8');
      } catch {
        // File missing (e.g., Windows uses %APPDATA%\Claude, not ~/.claude) --
        // we can't tell whether the session exists, so fail open.
        return true;
      }

      return content.includes(sessionId);
    } catch (error) {
      console.warn('[CLAUDE-CODE] Failed to check session existence:', error);
      return true; // Assume it exists if we can't check (fail open)
    }
  }
}
