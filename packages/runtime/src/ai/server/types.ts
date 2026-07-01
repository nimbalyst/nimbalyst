/**
 * Common types for AI provider abstraction
 */

import type { ToolDefinition } from '../tools';
import type { EffortLevel, ThinkingMode } from './effortLevels';
import type { ToolResult } from './protocols/ProtocolInterface';
import { ModelIdentifier } from './ModelIdentifier';
import { CLAUDE_CODE_PINNED_SDK_MODELS } from '../modelConstants';
import type { TranscriptViewMessage } from './transcript/TranscriptProjector';
export type { ToolDefinition } from '../tools';
export { ModelIdentifier } from './ModelIdentifier';
export type { ToolResult } from './protocols/ProtocolInterface';
export type { TranscriptViewMessage } from './transcript/TranscriptProjector';

export interface DocumentContext {
  filePath?: string;
  fileType?: string;
  content?: string;  // Optional: omitted when documentTransition is 'none' (content unchanged)
  cursorPosition?: { line: number; column: number };
  selection?:
    | string
    | {
        text: string;
        filePath: string;
        timestamp: number;
      }
    | {
        start: { line: number; column: number };
        end: { line: number; column: number };
      };
  textSelection?: string;  // Just the selected text (filePath is already on document context)
  textSelectionTimestamp?: number | null;  // For staleness detection

  // AI mode at time of message submission (planning vs agent)
  mode?: 'planning' | 'agent';

  // Worktree context (for isolated AI coding sessions)
  worktreeId?: string;  // ID of the associated worktree
  worktreePath?: string;  // Path to the worktree directory
  worktreeProjectPath?: string;  // Path to the parent project (for permission lookups)

  // Document transition tracking (for prompt optimization)
  documentTransition?: 'none' | 'opened' | 'closed' | 'switched' | 'modified';
  previousFilePath?: string;  // Path of previously viewed file (for switched/closed transitions)
  documentDiff?: string;  // Unified diff patch when document was modified

  // Session context (populated by backend before sending to provider)
  sessionType?: SessionType;
  permissionsPath?: string;  // Path for permission lookups (may differ from worktreePath)
  mcpConfigWorkspacePath?: string;  // Path for MCP config lookup (parent project for worktrees)
  attachments?: ChatAttachment[];
  branchedFromSessionId?: string;  // For session forking
  branchedFromProviderSessionId?: string;

  // Pre-built prompts from DocumentContextService (for user message additions)
  documentContextPrompt?: string;  // File path, cursor, selection, content/diff, transitions
  editingInstructions?: string;    // One-time editing instructions (only first message with doc)

  /** Identifies the origin of this message when it comes from an automated source (e.g. 'wakeup_resume'). */
  promptOrigin?: string;
}

export interface ChatAttachment {
  id: string;
  filename: string;
  filepath: string;
  mimeType: string;
  size: number;
  type: 'image' | 'pdf' | 'document';
  thumbnail?: string;
  addedAt: number;
}

export interface ToolCall {
  id?: string;
  name: string;
  arguments?: Record<string, unknown>;
  result?: ToolResult | string;
  targetFilePath?: string;  // File path this tool call was executed against
  // Sub-agent specific fields
  isSubAgent?: boolean;           // true for Task/Agent tools
  subAgentType?: string;          // e.g., "Explore", "bug-fixer", etc.
  parentToolId?: string;          // ID of parent Task tool
  childToolCalls?: Message[];     // Nested tools executed by sub-agent
  // Agent team teammate fields (set when task is a team spawn)
  teammateName?: string;          // Named teammate (e.g., "security-reviewer")
  teamName?: string;              // Team this teammate belongs to
  teammateMode?: string;          // Permission mode for teammate (e.g., "plan")
  teammateAgentId?: string;       // Full agent ID (e.g., "researcher@myteam")
  teammateColor?: string;         // Color for UI differentiation
  // Tool progress tracking (for long-running tools and background tasks)
  toolProgress?: {
    toolName: string;             // Name of the tool currently executing
    elapsedSeconds: number;       // How long it has been running
  };
}

export interface Message {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  timestamp: number;
  mode?: 'planning' | 'agent';  // AI mode when message was sent (user messages only)
  // Additional fields for rich message types
  edits?: unknown[];
  toolCall?: ToolCall;
  isError?: boolean;
  isAuthError?: boolean; // True when error is an authentication failure (SDK first-class detection)
  errorMessage?: string;
  isUserInput?: boolean; // True for genuine user-initiated messages (typed prompts, superloop/blitz); false for system-generated user-role messages
  isSystem?: boolean; // For system messages like slash command output
  isStreamingStatus?: boolean;
  streamingData?: {
    position: string;
    mode: string;
    content: string;
    isActive: boolean;
  };
  tokenUsage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
  attachments?: ChatAttachment[];
  metadata?: Record<string, unknown>;  // Provider-specific metadata (e.g., Codex raw events)
  isComplete?: boolean; // Internal flag used during transcript assembly to mark finalized messages
}

/**
 * Single source of truth for all AI provider types.
 * Add new providers here -- the type, runtime array, and exhaustiveness
 * checks all derive from this one definition.
 */
export const AI_PROVIDER_TYPES = ['claude', 'claude-code', 'openai', 'openai-codex', 'openai-codex-acp', 'lmstudio', 'opencode', 'copilot-cli'] as const;

export type AIProviderType = typeof AI_PROVIDER_TYPES[number];

/**
 * Exhaustive switch helper. Use in default cases to get a compile error
 * when a new provider is added but not handled:
 *
 *   switch (provider) {
 *     case 'claude': ...
 *     case 'claude-code': ...
 *     // If you miss a case, TypeScript errors here:
 *     default: assertExhaustiveProvider(provider);
 *   }
 */
export function assertExhaustiveProvider(provider: never): never {
  throw new Error(`Unhandled provider: ${provider}`);
}

export function isAgentProvider(provider: string | null | undefined): provider is 'claude-code' | 'openai-codex' | 'openai-codex-acp' | 'opencode' | 'copilot-cli' {
  return provider === 'claude-code' || provider === 'openai-codex' || provider === 'openai-codex-acp' || provider === 'opencode' || provider === 'copilot-cli';
}

/**
 * Started sessions cannot switch away from their original provider when an agent
 * provider is involved. This keeps agent SDK session state coherent.
 */
export function shouldBlockStartedSessionProviderSwitch(
  currentProvider: string | null | undefined,
  targetProvider: string | null | undefined,
  hasMessages: boolean
): boolean {
  if (!hasMessages || !currentProvider || !targetProvider || currentProvider === targetProvider) {
    return false;
  }

  return isAgentProvider(currentProvider) || isAgentProvider(targetProvider);
}

/**
 * Claude Code uses simplified variant names (opus, sonnet, haiku) instead of full model IDs.
 * These are ONLY valid for the claude-code provider.
 *
 * `opus-4-6` is a pinned-version variant retained after bumping the canonical
 * `opus` alias to 4.7, so users can still choose the previous generation.
 * See CLAUDE_CODE_PINNED_SDK_MODELS in modelConstants.ts.
 */
export const CLAUDE_CODE_VARIANTS = ['opus', 'sonnet-5', 'fable-5', 'opus-4-6', 'sonnet', 'haiku'] as const;

/**
 * Resolves a configured model string to the SDK model value.
 *
 * Key behaviors:
 * - Canonical variants (opus, sonnet, haiku) are passed straight through — the
 *   SDK maps these to the current-generation model.
 * - Pinned variants (opus-4-6, ...) are substituted for their full Anthropic
 *   model ID from CLAUDE_CODE_PINNED_SDK_MODELS, so they always resolve to a
 *   specific version regardless of what "latest" becomes.
 * - For -1m variants, appends `[1m]` so the SDK adds the 1M-context beta
 *   header; the SDK strips `[1m]` before sending the model ID to the API.
 */
export function resolveClaudeCodeModelVariant(configuredModel: string | undefined, defaultModel: string): string {
  type ClaudeCodeVariant = typeof CLAUDE_CODE_VARIANTS[number];
  const fallback: ClaudeCodeVariant = 'sonnet';
  const configured = configuredModel || defaultModel;

  const toSdkBase = (variant: string): string => CLAUDE_CODE_PINNED_SDK_MODELS[variant as ClaudeCodeVariant] ?? variant;

  // Try parsing with ModelIdentifier
  const parsed = ModelIdentifier.tryParse(configured);
  if (parsed && parsed.provider === 'claude-code') {
    // baseVariant strips suffixes like -1m
    const variant = parsed.baseVariant as ClaudeCodeVariant;
    if ((CLAUDE_CODE_VARIANTS as readonly string[]).includes(variant)) {
      const sdkBase = toSdkBase(variant);
      // Append [1m] suffix for extended context so the SDK auto-detects the 1M beta
      return parsed.isExtendedContext ? `${sdkBase}[1m]` : sdkBase;
    }
  }

  // Fallback for non-standard formats
  const raw = parsed ? parsed.model : configured;
  const normalized = raw?.toLowerCase();
  const isExtended = normalized?.endsWith('-1m');
  const withoutContext = normalized?.replace(/-1m$/, '');

  if (withoutContext && (CLAUDE_CODE_VARIANTS as readonly string[]).includes(withoutContext)) {
    const sdkBase = toSdkBase(withoutContext);
    return isExtended ? `${sdkBase}[1m]` : sdkBase;
  }

  return fallback;
}

export interface AIModel {
  id: string;           // e.g., 'gpt-4', 'claude-3-5-sonnet-20241022'
  name: string;         // e.g., 'GPT-4', 'Claude 3.5 Sonnet'
  provider: AIProviderType;
  maxTokens?: number;
  contextWindow?: number;
}

/** Structural type describing what role a session plays in the hierarchy */
export type SessionType = 'session' | 'workstream' | 'blitz' | 'voice';

export type SessionMode = 'planning' | 'agent';

export type AgentRole = 'standard' | 'meta-agent';

export interface QueuedPrompt {
  id: string;           // Unique ID for this queued item
  prompt: string;       // The user's message
  timestamp: number;    // When queued
  documentContext?: DocumentContext; // Optional document context at queue time
  attachments?: ChatAttachment[]; // Optional attachments
}

export interface TokenUsageCategory {
  name: string;
  tokens: number;
  percentage: number;
}

export interface SessionData {
  id: string;  // Our session ID
  provider: AIProviderType | string;  // Provider type
  model?: string;  // Specific model used (e.g., 'gpt-4', 'claude-3-5-sonnet')
  sessionType?: SessionType;  // Structural type: 'session', 'workstream', 'blitz'
  mode?: SessionMode;  // Session behavior mode: 'planning' | 'agent'
  agentRole?: AgentRole;
  createdBySessionId?: string | null;
  messages: TranscriptViewMessage[];
  documentContext?: DocumentContext;
  workspacePath?: string;
  title?: string;
  draftInput?: string;

  // Worktree association
  worktreeId?: string;  // ID of the associated worktree
  worktreePath?: string;  // Path to the worktree directory
  worktreeProjectPath?: string;  // Path to the parent project (for permission lookups)

  // Hierarchical session support (workstreams)
  // parent_session_id = hierarchical containment (child sessions within a workstream)
  parentSessionId?: string | null;  // Parent session ID for hierarchical workstreams

  // Time tracking
  createdAt: number;  // Creation timestamp
  updatedAt: number;  // Last update timestamp

  // Read state tracking
  lastReadMessageTimestamp?: number;  // Timestamp of the last message the user has read

  // Session naming tracking
  hasBeenNamed?: boolean;  // Whether the session has been named by update_session_meta tool

  // Archive state
  isArchived?: boolean;  // Whether the session is archived

  // Pin state
  isPinned?: boolean;  // Whether the session is pinned to the top of the list

  // Branch tracking - SEPARATE from hierarchical parent_session_id
  // branched_from_session_id = session forking (branch off at a message to try different approach)
  branchedFromSessionId?: string;  // ID of the session this was forked from
  branchPointMessageId?: number;  // Message ID where this branch diverged
  branchedAt?: number;  // Timestamp when the branch was created
  branchedFromProviderSessionId?: string;  // Source session's providerSessionId for forking (Claude Code SDK)

  // Token usage tracking (for providers that support it)
  tokenUsage?: {
    inputTokens: number;      // Cumulative input tokens across session lifetime
    outputTokens: number;     // Cumulative output tokens across session lifetime
    totalTokens: number;      // Total tokens (input + output)
    // Internal Codex baseline tracking for cumulative SDK snapshots.
    // Not user-facing; used to convert provider-cumulative usage into per-session deltas.
    providerCumulativeInputTokens?: number;
    providerCumulativeOutputTokens?: number;
    contextWindow?: number;   // Max context window size for the model (legacy, use currentContext)
    categories?: TokenUsageCategory[]; // Breakdown parsed from /context output (legacy, use currentContext)
    costUSD?: number;         // Total cost in USD (from SDK modelUsage)
    webSearchRequests?: number; // Number of web searches performed (from SDK modelUsage)
    // Current context window snapshot (from SDK modelUsage for Claude Code)
    // This is separate from cumulative tokens - resets on compaction
    currentContext?: {
      tokens: number;         // Current tokens in context window
      contextWindow: number;  // Max context window size
      categories?: TokenUsageCategory[]; // Category breakdown from /context
      rawResponse?: string;   // Raw markdown from /context for display on session reload
    };
  };

  // Additional metadata
  metadata?: Record<string, unknown>;

  // Document context optimization - tracks what was last sent to AI
  // Used to compute diffs/unchanged flags for prompt optimization
  lastDocumentState?: {
    filePath: string;
    contentHash: string;
    // Note: We don't persist full content to save space - only hash for comparison
  };

  // Provider-specific data
  providerSessionId?: string;  // For Claude Code's internal session ID
  providerConfig?: {
    model?: string;
    apiKey?: string;  // If using per-session keys
  };
}

export interface ProviderConfig {
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  baseUrl?: string;
  allowedTools?: string[];  // List of allowed tool names, ['*'] for all tools
  effortLevel?: EffortLevel;  // Effort level for Opus 4.6 adaptive reasoning (low/medium/high/max)
  thinkingMode?: ThinkingMode;  // Claude Code extended thinking mode; disabled maps to SDK options.thinking
  responseFormat?: ProviderResponseFormat;  // Response format constraint (extension chat completions)
  skipLogging?: boolean;  // Skip message logging to DB (extension stateless completions)
  agent?: string;  // OpenCode agent (role) to activate for this session
  /**
   * Claude Code only: id of a non-Anthropic backend (see CLAUDE_CODE_BACKENDS in
   * providers/claudeCode/customBackends.ts) to run THIS session on. Per-session
   * brain swap -- no global effect. Absent = default Anthropic wiring.
   */
  customBackend?: string;
}

/**
 * Response format constraint passed to providers.
 * Maps to provider-specific API format in each provider implementation.
 * Normalized from extension SDK format in resolveExtensionChatProvider.
 */
export type ProviderResponseFormat =
  | { type: 'text' }
  | { type: 'json_object' }
  | { type: 'json_schema'; schema: Record<string, unknown>; name?: string; strict?: boolean };

export interface ProviderCapabilities {
  streaming: boolean;
  tools: boolean;
  mcpSupport: boolean;
  edits: boolean;
  resumeSession: boolean;
  /**
   * If true, this provider uses tools to read files when @ referenced
   * If false, files are automatically attached as context to the message
   * Agent models (Claude Code) should set this to true
   * Non-agent models (Claude, OpenAI, LM Studio) should set this to false
   */
  supportsFileTools: boolean;
}

export interface ProviderSettings {
  enabled: boolean;
  apiKey?: string;
  models?: string[];  // List of enabled model IDs for this provider
  defaultModel?: string;
  baseUrl?: string;  // For custom endpoints
}

export interface StreamChunk {
  type: 'text' | 'tool_call' | 'tool_error' | 'error' | 'complete' | 'stream_edit_start' | 'stream_edit_content' | 'stream_edit_end' | 'pre_edit_snapshot' | 'post_edit_snapshot';
  content?: string;
  isSystem?: boolean; // For system messages like slash command output
  toolCall?: {
    id?: string;
    name: string;
    arguments?: Record<string, any>;
    result?: ToolResult | string;
    /**
     * Stable provider-agnostic edit-group ID stamped by the provider so file
     * trackers and pre-edit history tags can dedupe and attribute file
     * changes to the exact tool invocation. For Codex this carries the
     * synthetic `nimtc|<encoded>|<ts>|<idx>` ID minted by
     * OpenAICodexProvider; for Claude Code this is the SDK's tool_use_id.
     */
    toolUseId?: string;
  };
  toolError?: {
    name: string;
    arguments?: Record<string, any>;
    error: string;
    result?: ToolResult | string;
  };
  error?: string;
  isAuthError?: boolean; // True when error is an authentication failure (SDK first-class detection)
  isBedrockToolError?: boolean; // True when error is a Bedrock tool search error
  isServerError?: boolean; // True when error is a 500/internal server error (Claude may be down)
  isCodexAuthRequired?: boolean; // True when a Codex app-server session was blocked because the user is not signed in to OpenAI
  isComplete?: boolean;
  config?: unknown; // For stream_edit_start
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  // Per-model usage breakdown from SDK (available on 'complete' chunks from claude-code)
  modelUsage?: Record<string, {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
    costUSD?: number;
    contextWindow?: number;
    webSearchRequests?: number;
  }>;
  // Actual tokens in context window from last assistant message (input + cacheRead + cacheCreation).
  // Unlike modelUsage which is cumulative, this reflects the real context fill level per turn.
  contextFillTokens?: number;
  // Model context window for context fill calculations (when provider emits a per-turn snapshot).
  contextWindow?: number;
  // Set to true when context was compacted this turn. Signals AIService to clear stale currentContext.
  contextCompacted?: boolean;
  /**
   * Pre-edit snapshot delivered by providers that have a clean
   * tool-lifecycle signal (currently OpenAICodex `file_change` via
   * `item.started`). Carries the on-disk content of each affected path,
   * read BEFORE the agent applies its patch. The host writes a
   * local-history pre-edit tag with that exact content so the diff
   * renderer always has a real baseline -- gitignored files,
   * never-snapshotted files, and post-boot-created files all work.
   * Replaces the watcher/cache/recoverBaseline fallback chain for
   * this provider.
   */
  preEditSnapshot?: {
    toolUseId: string;
    entries: Array<{
      path: string;
      content: string | null;
      kind?: string;
    }>;
    /**
     * When true, `MessageStreamingHandler` must use `entries[].content` as the
     * pre-edit baseline VERBATIM and skip its `FileSnapshotCache` fallback
     * lookup. Used by the codex app-server transport, where the pre-edit
     * content is computed deterministically by reverse-applying the patch
     * diff text against the post-edit disk state -- a cache lookup at that
     * point would clobber correct content with whatever chokidar happened to
     * observe (often the post-edit body for fresh gitignored files).
     *
     * The legacy SDK transport leaves this undefined (false), preserving its
     * cache-prefers behavior for the race-prone item.started disk-read path.
     */
    authoritative?: boolean;
  };
  /**
   * Post-edit snapshot delivered by providers that have a clean tool-completion
   * signal (currently OpenAICodex `file_change` via `item.completed`). Carries
   * the on-disk content of each affected path AFTER the agent applied its
   * patch. The host writes a local-history `ai-edit` snapshot with this
   * content so the session-aware diff can show a stable AI-output baseline
   * even after the user later modifies the file. Mirrors Claude's
   * `createTurnEndSnapshots` for the Codex provider.
   */
  postEditSnapshot?: {
    toolUseId: string;
    entries: Array<{
      path: string;
      content: string;
      kind?: string;
    }>;
  };
}

export interface DiffArgs {
  replacements: Array<{
    oldText: string;
    newText: string;
  }>;
}

export interface DiffResult {
  success: boolean;
  error?: string;
  appliedCount?: number;
}

export interface ToolHandler {
  // All methods are optional - handlers can implement any subset
  applyDiff?(args: DiffArgs): Promise<DiffResult>;
  // Stream content tool for real-time streaming
  streamContent?(args: unknown): Promise<unknown>;
  // File search tool
  searchFiles?(args: unknown): Promise<unknown>;
  // List files tool
  listFiles?(args: unknown): Promise<unknown>;
  // Read file tool
  readFile?(args: unknown): Promise<unknown>;
  // Write file tool
  writeFile?(args: unknown): Promise<unknown>;
  // Get document content
  getDocumentContent?(args: unknown): Promise<unknown>;
  // Update frontmatter
  updateFrontmatter?(args: unknown): Promise<unknown>;
  // Dynamic tool execution - for any other tool
  // Note: executeTool has different signature (name, args) so we handle it separately
  executeTool?(name: string, args: unknown): Promise<unknown>;
  // Dynamic property access for other tools
  [key: string]: ((args: unknown) => Promise<unknown>) | ((args: DiffArgs) => Promise<DiffResult>) | ((name: string, args: unknown) => Promise<unknown>) | undefined;
}

/**
 * File link types for tracking file interactions in AI sessions
 */
export type FileLinkType = 'edited' | 'referenced' | 'read';

/**
 * File link metadata structures for each link type
 */
export interface EditedFileMetadata {
  operation?: 'edit' | 'create' | 'delete' | 'rename' | 'bash';
  linesAdded?: number;
  linesRemoved?: number;
  toolName?: string;
  bashCommand?: string;  // For bash operations, stores the command (truncated)
  toolUseId?: string;  // Tool call identifier for matching edits to tool calls
}

export interface ReferencedFileMetadata {
  mentionContext?: string;
  messageIndex?: number;
}

export interface ReadFileMetadata {
  toolName?: string;
  bytesRead?: number;
  wasPartial?: boolean;
}

/**
 * Link between a file and an AI session
 */
export interface FileLink {
  id: string;
  sessionId: string;
  workspaceId: string;
  filePath: string;
  linkType: FileLinkType;
  timestamp: number;
  metadata?: EditedFileMetadata | ReferencedFileMetadata | ReadFileMetadata | Record<string, unknown>;
}

/**
 * Direction of an AI agent message
 */
export type AgentMessageDirection = 'input' | 'output';

/**
 * Raw AI agent message record
 * Write-only audit log for AI interactions
 */
export interface AgentMessage {
  id?: number;  // Auto-generated by database
  sessionId: string;
  createdAt?: Date;  // Auto-set by database
  source: string;  // AI provider (e.g., 'claude-code', 'claude', 'openai')
  direction: AgentMessageDirection;  // 'input' (user/system to AI) or 'output' (AI response)
  content: string;  // Raw message content
  metadata?: Record<string, unknown>;  // Optional provider-specific metadata
  hidden?: boolean;  // Whether to hide this message from UI (e.g., /context commands)
  providerMessageId?: string;  // Provider-assigned message ID (e.g., SDK uuid) for deduplication
}

/**
 * Input type for creating an agent message
 */
export interface CreateAgentMessageInput {
  sessionId: string;
  source: string;
  direction: AgentMessageDirection;
  content: string;
  metadata?: Record<string, unknown>;
  hidden?: boolean;  // Whether to hide this message from UI (e.g., /context commands)
  createdAt?: Date | string;  // Optional timestamp for imported messages (defaults to NOW())
  providerMessageId?: string;  // Provider-assigned message ID (e.g., SDK uuid) for deduplication
  searchable?: boolean;  // Whether to include in FTS index (user prompts and assistant text only)
}

// ============================================================================
// Interactive Prompt Message Types
// These message types support mobile-compatible permission and question flows.
// Requests are persisted as messages, allowing any device to render the UI and respond.
// Responses are also persisted, allowing the provider to poll for completion.
// ============================================================================

/**
 * Status of an interactive prompt (permission request or user question)
 */
export type InteractivePromptStatus = 'pending' | 'resolved' | 'cancelled';

/**
 * Permission request message - persisted when SDK needs tool approval
 */
export interface PermissionRequestContent {
  type: 'permission_request';
  requestId: string;
  toolName: string;
  rawCommand: string;           // The command/tool description shown to user
  pattern: string;              // Pattern for "Allow Session/Always" (e.g., 'Bash(git commit:*)')
  patternDisplayName: string;   // Human-readable pattern description
  isDestructive: boolean;
  warnings: string[];
  timestamp: number;
  status: InteractivePromptStatus;
}

/**
 * Permission response message - created when user responds to a permission request
 */
export interface PermissionResponseContent {
  type: 'permission_response';
  requestId: string;            // Links to the permission_request
  decision: 'allow' | 'deny';
  scope: 'once' | 'session' | 'always' | 'always-all';
  respondedAt: number;
  respondedBy: 'desktop' | 'mobile';
}

/**
 * AskUserQuestion request message - persisted when Claude needs user input
 */
export interface AskUserQuestionRequestContent {
  type: 'ask_user_question_request';
  questionId: string;
  questions: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description: string }>;
    multiSelect: boolean;
  }>;
  timestamp: number;
  status: InteractivePromptStatus;
}

/**
 * AskUserQuestion response message - created when user answers questions
 */
export interface AskUserQuestionResponseContent {
  type: 'ask_user_question_response';
  questionId: string;           // Links to the ask_user_question_request
  answers: Record<string, string>;
  cancelled?: boolean;          // True if user cancelled instead of answering
  respondedAt: number;
  respondedBy: 'desktop' | 'mobile';
}

/**
 * Union type for all interactive prompt content types
 */
export type InteractivePromptContent =
  | PermissionRequestContent
  | PermissionResponseContent
  | AskUserQuestionRequestContent
  | AskUserQuestionResponseContent;

/**
 * Type guard to check if content is an interactive prompt
 */
export function isInteractivePromptContent(content: unknown): content is InteractivePromptContent {
  if (typeof content !== 'object' || content === null) return false;
  const type = (content as { type?: string }).type;
  return type === 'permission_request' ||
         type === 'permission_response' ||
         type === 'ask_user_question_request' ||
         type === 'ask_user_question_response';
}

/**
 * Type guard to check if content is a pending permission request
 */
export function isPendingPermissionRequest(content: unknown): content is PermissionRequestContent {
  if (typeof content !== 'object' || content === null) return false;
  const c = content as { type?: string; status?: string };
  return c.type === 'permission_request' && c.status === 'pending';
}

/**
 * Type guard to check if content is a pending AskUserQuestion request
 */
export function isPendingAskUserQuestion(content: unknown): content is AskUserQuestionRequestContent {
  if (typeof content !== 'object' || content === null) return false;
  const c = content as { type?: string; status?: string };
  return c.type === 'ask_user_question_request' && c.status === 'pending';
}

/**
 * Helper to parse message content as interactive prompt content
 * Returns undefined if content is not valid JSON or not an interactive prompt
 */
export function parseInteractivePromptContent(content: string): InteractivePromptContent | undefined {
  try {
    const parsed = JSON.parse(content);
    if (isInteractivePromptContent(parsed)) {
      return parsed;
    }
  } catch {
    // Not valid JSON or not an interactive prompt
  }
  return undefined;
}

/**
 * Check if a list of messages contains any pending interactive prompts.
 * Used to show "waiting for response" indicator in session lists.
 */
export function hasPendingInteractivePrompts(messages: Array<{ content: string }>): boolean {
  for (const msg of messages) {
    try {
      const content = JSON.parse(msg.content);
      if ((content.type === 'permission_request' || content.type === 'ask_user_question_request') &&
          content.status === 'pending') {
        // Check if there's a corresponding response
        const requestId = content.requestId || content.questionId;
        const responseType = content.type === 'permission_request' ? 'permission_response' : 'ask_user_question_response';

        // Look for a response with matching requestId/questionId
        const hasResponse = messages.some(m => {
          try {
            const c = JSON.parse(m.content);
            return c.type === responseType && (c.requestId === requestId || c.questionId === requestId);
          } catch {
            return false;
          }
        });

        if (!hasResponse) {
          return true; // Found a pending prompt without a response
        }
      }
    } catch {
      // Not valid JSON, skip
    }
  }
  return false;
}

/**
 * Get a human-readable display name for a tool permission pattern.
 * Used both when persisting permission requests and in the UI.
 */
export function getPatternDisplayName(pattern: string): string {
  // Handle compound commands - these get unique patterns and shouldn't be cached
  if (pattern.startsWith('Bash:compound:')) {
    return 'this compound command (one-time only)';
  }

  // Handle Bash patterns like 'Bash(git commit:*)' or 'Bash(npm run:*)'
  const bashMatch = pattern.match(/^Bash\(([^:]+):\*\)$/);
  if (bashMatch) {
    return `${bashMatch[1]} commands`;
  }

  // Handle tool patterns like 'WebFetch(https://docs.anthropic.com:*)'
  const toolMatch = pattern.match(/^(\w+)\(([^:]+):\*\)$/);
  if (toolMatch) {
    const [, toolName, target] = toolMatch;
    if (toolName === 'WebFetch') {
      try {
        const url = new URL(target);
        return `Fetch from ${url.hostname}`;
      } catch {
        return `Fetch from ${target}`;
      }
    }
    return `${toolName}: ${target}`;
  }

  // Handle wildcard patterns like 'WebFetch' (all WebFetch calls)
  if (pattern === 'WebFetch') {
    return 'all web fetches';
  }

  // Handle simple Bash patterns like 'Bash(ls:*)'
  const simpleBashMatch = pattern.match(/^Bash\((\w+):\*\)$/);
  if (simpleBashMatch) {
    return `${simpleBashMatch[1]} commands`;
  }

  // Default: return the pattern as-is
  return pattern;
}
