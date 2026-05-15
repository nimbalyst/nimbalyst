// TypeScript types for the codex app-server JSON-RPC v2 protocol.
//
// Derived from `codex app-server generate-json-schema` against codex 0.130.0.
// Only the subset we actually consume is typed. Frozen reference schemas live
// at `design/agents/codex-app-server-schemas/v2/`; regenerate after any codex
// upgrade and compare with this file.

// ---- generic JSON-RPC v2 primitives ----

export type RpcId = string | number;

export interface RpcRequest<P = unknown> {
  jsonrpc: '2.0';
  id: RpcId;
  method: string;
  params?: P;
}

export interface RpcNotification<P = unknown> {
  jsonrpc?: '2.0';
  method: string;
  params?: P;
}

export interface RpcResponseOk<R = unknown> {
  jsonrpc?: '2.0';
  id: RpcId;
  result: R;
}

export interface RpcResponseErr {
  jsonrpc?: '2.0';
  id: RpcId;
  error: { code: number; message: string; data?: unknown };
}

export type RpcResponse<R = unknown> = RpcResponseOk<R> | RpcResponseErr;

// ---- initialize ----

export interface InitializeParams {
  clientInfo: { name: string; version: string; title?: string };
  capabilities?: {
    experimentalApi?: boolean;
    optOutNotificationMethods?: string[];
  };
}

export interface InitializeResponse {
  codexHome: string;
  platformFamily: string;
  platformOs: string;
  userAgent: string;
}

// ---- thread/start ----

export type AskForApproval =
  | 'untrusted'
  | 'on-failure'
  | 'on-request'
  | 'never'
  | {
      granular: {
        mcp_elicitations: boolean;
        request_permissions?: boolean;
        rules: boolean;
        sandbox_approval: boolean;
        skill_approval?: boolean;
      };
    };

export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

export interface ThreadStartParams {
  approvalPolicy?: AskForApproval | null;
  approvalsReviewer?: 'user' | 'auto_review' | 'guardian_subagent' | null;
  baseInstructions?: string | null;
  config?: Record<string, unknown> | null;
  cwd?: string | null;
  developerInstructions?: string | null;
  sandbox?: SandboxMode | null;
  threadSource?: 'user' | 'subagent' | 'memory_consolidation' | null;
  ephemeral?: boolean | null;
  serviceName?: string | null;
  serviceTier?: string | null;
  model?: string | null;
  modelProvider?: string | null;
  personality?: 'none' | 'friendly' | 'pragmatic' | null;
  sessionStartSource?: 'startup' | 'clear' | null;
}

export interface ThreadStartResponse {
  thread: {
    id: string;
    sessionId?: string;
    forkedFromId?: string | null;
    ephemeral?: boolean;
    modelProvider?: string;
    createdAt?: number;
    updatedAt?: number;
    status?: { type: string };
    cwd?: string;
    cliVersion?: string;
    source?: string | null;
    threadSource?: string | null;
    name?: string | null;
  };
  model?: string;
  modelProvider?: string;
  serviceTier?: string | null;
  cwd?: string;
  approvalPolicy?: AskForApproval;
  sandbox?: unknown;
  reasoningEffort?: string;
}

// ---- thread/resume ----

export interface ThreadResumeParams {
  threadId: string;
  cwd?: string | null;
}

export type ThreadResumeResponse = ThreadStartResponse;

// ---- turn/start ----

export type UserInputElement =
  | { type: 'text'; text: string }
  | { type: 'local_image'; path: string }
  | { type: 'image'; path: string };

export interface TurnStartParams {
  threadId: string;
  input: UserInputElement[];
  /** JSON schema for structured output. Optional. */
  outputSchema?: unknown;
}

export interface TurnStartResponse {
  turn: {
    id: string;
    items: unknown[];
    itemsView?: string;
    status: 'inProgress' | 'completed' | 'failed';
    error?: unknown;
    startedAt?: number | null;
    completedAt?: number | null;
    durationMs?: number | null;
  };
}

// ---- turn/interrupt ----

export interface TurnInterruptParams {
  threadId: string;
}

// ---- Notifications we consume ----

export interface ThreadStartedNotification {
  threadId: string;
}

export interface TurnStartedNotification {
  threadId: string;
  turnId: string;
}

export interface TurnCompletedNotification {
  threadId: string;
  turn: {
    id: string;
    status: 'completed' | 'failed';
    error?: { message?: string } | null;
    completedAtMs?: number;
    durationMs?: number;
  };
  usage?: TokenUsage;
}

export interface TurnFailedNotification {
  threadId: string;
  turn: {
    id: string;
    status: 'failed';
    error: { message?: string; codexErrorInfo?: string; additionalDetails?: unknown } | null;
  };
}

export interface ThreadTokenUsageUpdatedNotification {
  threadId: string;
  usage: TokenUsage;
}

export interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  cached_input_tokens?: number;
  reasoning_output_tokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

// ---- Item notifications ----

export type CodexItemKind =
  | 'userMessage'
  | 'agentMessage'
  | 'reasoning'
  | 'commandExecution'
  | 'fileChange'
  | 'mcpToolCall'
  | 'webSearch'
  | 'todoList'
  | 'error';

export interface BaseItemPayload<T extends CodexItemKind = CodexItemKind> {
  id: string;
  type: T;
  [k: string]: unknown;
}

export interface FileChangeChange {
  path: string;
  kind:
    | { type: 'add' }
    | { type: 'delete' }
    | { type: 'update'; move_path?: string | null };
  diff: string;
}

export interface FileChangeItem extends BaseItemPayload<'fileChange'> {
  changes: FileChangeChange[];
  status: 'inProgress' | 'completed' | 'failed';
}

export interface AgentMessageItem extends BaseItemPayload<'agentMessage'> {
  text: string;
  phase?: string;
  memoryCitation?: unknown;
}

export interface ReasoningItem extends BaseItemPayload<'reasoning'> {
  text: string;
}

export interface UserMessageItem extends BaseItemPayload<'userMessage'> {
  content: Array<{ type: 'text'; text: string; text_elements?: unknown[] }>;
}

export interface CommandExecutionItem extends BaseItemPayload<'commandExecution'> {
  command: string;
  aggregated_output?: string;
  exit_code?: number;
  status: 'in_progress' | 'completed' | 'failed';
}

export interface McpToolCallItem extends BaseItemPayload<'mcpToolCall'> {
  server: string;
  tool: string;
  arguments?: unknown;
  result?: unknown;
  error?: { message: string };
  status: 'in_progress' | 'completed' | 'failed';
}

export type AnyItem =
  | UserMessageItem
  | AgentMessageItem
  | ReasoningItem
  | CommandExecutionItem
  | FileChangeItem
  | McpToolCallItem
  | BaseItemPayload;

export interface ItemStartedNotification {
  item: AnyItem;
  threadId: string;
  turnId: string;
  startedAtMs?: number;
}

export interface ItemCompletedNotification {
  item: AnyItem;
  threadId: string;
  turnId: string;
  completedAtMs?: number;
}

export interface ItemAgentMessageDeltaNotification {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
}

export interface ItemReasoningDeltaNotification {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
}

// turn/diff/updated — full git-style diff for the entire turn so far.
export interface TurnDiffUpdatedNotification {
  threadId: string;
  turnId: string;
  diff: string;
}

// MCP server lifecycle.
export interface McpServerStartupStatusUpdatedNotification {
  name: string;
  status: 'starting' | 'ready' | 'failed';
  error?: string | null;
}

// Generic error notification.
export interface ErrorNotification {
  threadId?: string;
  turnId?: string;
  error: { message: string; codexErrorInfo?: string; additionalDetails?: unknown };
  willRetry?: boolean;
}

// Warning notification.
export interface WarningNotification {
  threadId?: string;
  turnId?: string;
  message: string;
}

// ---- Server-to-client requests (we respond to these) ----

export interface ItemFileChangeRequestApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  changes: FileChangeChange[];
  callId?: string;
  matcher?: string;
}

export interface ItemCommandExecutionRequestApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  command: string;
  cwd?: string;
  reason?: string;
}

export interface ItemPermissionsRequestApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  reason?: string;
}

export interface ApplyPatchApprovalParams {
  /** Legacy approval shape (pre-`turn/start`). */
  threadId?: string;
  turnId?: string;
  changes?: FileChangeChange[];
  reason?: string;
}

// Generic approval response. Codex accepts a decision string.
export interface ApprovalResponse {
  decision: 'approved' | 'denied' | 'abort';
}

// Dynamic tool call (codex asks the host to run a host-registered tool).
export interface DynamicToolCallParams {
  threadId: string;
  turnId: string;
  callId: string;
  tool: string;
  arguments: unknown;
  namespace?: string;
}

export interface DynamicToolCallResponse {
  /** MCP-style content blocks expected back. */
  content?: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
}
