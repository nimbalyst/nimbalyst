/**
 * Per-turn mutable state for `ClaudeCodeProvider.sendMessage()`.
 *
 * `sendMessage` is one async generator whose chunk loop writes a pile of locals
 * that its epilogue then reads: `completeEmitted` / `fullContent` /
 * `toolCallCount` together decide whether an empty slash command reports an
 * error, `sawAssistantOutputThisTurn` gates the crash-retry, `stderrLines`
 * enriches the error message. Splitting the method means those locals have to
 * cross a function boundary, and passing them by value would break the epilogue
 * silently — the turn would still stream text, it would just stop completing
 * correctly.
 *
 * So they live here instead, in one object created at the top of the turn and
 * threaded by reference into every extracted piece.
 *
 * This is deliberately NOT hung off `ClaudeCodeProvider`. A provider instance is
 * reused across turns; anything promoted to instance state leaks into the next
 * turn. Instance fields on the provider (`drainingBackgroundTasks`,
 * `promptEndTimer`, …) are the ones that intentionally outlive a turn or are
 * read by `abort()` from outside it — those stay where they are.
 */

import type { ParsedContextUsage } from '../../utils/contextUsage';
import type { BlockingUsageLimit } from './usageLimit';

/** Token counts as the SDK reports them (snake_case wire shape). */
export interface TurnUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  /** Anthropic's per-lifetime breakdown of cache_creation_input_tokens. */
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  } | null;
}

/** Per-model usage from the SDK's `result` chunk (camelCase, unlike `TurnUsage`). */
export interface TurnModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  /** SDK 0.3.311+; absent on older CLIs. Both are inside cacheCreationInputTokens. */
  cacheCreationEphemeral5mInputTokens?: number;
  cacheCreationEphemeral1hInputTokens?: number;
  costUSD?: number;
  contextWindow?: number;
  webSearchRequests?: number;
}

/** A tool call yielded at `tool_use` and mutated in place when its result lands. */
export interface TurnToolCall {
  id: string;
  name: string;
  arguments?: Record<string, any>;
  /** Attached in place when the matching `tool_result` arrives; shape is tool-specific. */
  result?: any;
  isError?: boolean;
}

/** Process attributes captured after the SDK options are built, for crash diagnostics (#614, #1361). */
export interface SpawnDiagnosticsContext {
  binaryPath?: string;
  cwd?: string;
}

export interface TurnState {
  /** Wall clock at turn entry; the epilogue reports elapsed time from it. */
  readonly startTime: number;
  /** `markMessagesAsHidden` captured and reset at entry, before any await. */
  readonly hideMessages: boolean;
  /**
   * The caller's message before document context and attachment instructions
   * were appended. The crash-retry path re-enters `sendMessage` with it (#1361).
   */
  readonly originalMessage: string;

  /** The message actually sent to the SDK, after context/attachment rewriting. */
  message: string;
  /** Whether the user's prompt started with `/`. Drives the empty-output check. */
  isSlashCommand: boolean;

  /** Rolling tail of subprocess stderr; the writer caps its length. */
  readonly stderrLines: string[];
  /** Set once the SDK options are known, so the catch block can log spawn diagnostics. */
  spawnDiagContext: SpawnDiagnosticsContext | null;

  /** Accumulated assistant text. Empty + no tool calls is how a dead slash command is detected. */
  fullContent: string;
  /** Chunks seen from the SDK this turn (diagnostics only). */
  chunkCount: number;
  /** When the first chunk arrived, for the slow-spawn warning. */
  firstChunkTime: number | undefined;
  /** Tool calls started this turn. Part of the empty-slash-command check. */
  toolCallCount: number;
  /** A `compact_boundary` arrived, so empty `fullContent` is expected. */
  receivedCompactBoundary: boolean;
  /**
   * Tool calls whose result has not come back. While > 0 a tool is running in
   * the subprocess and main-stream silence is legitimate, so the stall watchdog
   * stays disarmed. NIM-1481.
   */
  outstandingToolCalls: number;
  /** When the first real `result` chunk landed; arms the prompt-end grace timer. */
  resultReceivedTime: number | null;
  /** `chunkCount` at that moment, for the stream-closed diagnostics. */
  resultReceivedChunkCount: number | null;
  /**
   * A terminal `complete` has already been yielded. Every later path must check
   * this before yielding another, and the catch block reads it to avoid
   * double-completing a turn that already reached the consumer.
   */
  completeEmitted: boolean;
  /**
   * Any assistant text or tool call reached the transcript. The crash-retry
   * decision needs it: replaying a partially-streamed turn would duplicate it.
   */
  sawAssistantOutputThisTurn: boolean;
  /**
   * A `task_notification` arrived this turn, which makes an immediately
   * following empty `num_turns: 0` result a notification flush rather than the
   * end of the turn. NIM-1470.
   */
  sawTaskNotificationThisTurn: boolean;
  /** A `rate_limit_event` blocked this turn; the terminal error carries its reset. */
  blockingUsageLimit: BlockingUsageLimit | null;

  /** Latest usage seen; overwritten by the cumulative `result.usage`. */
  usageData: TurnUsage | undefined;
  /**
   * The last assistant message's per-step usage. Context fill is computed from
   * this, NOT from `usageData` — that one holds cumulative totals by turn end.
   */
  lastAssistantUsage: TurnUsage | undefined;
  /** Only set on a `/context` turn, from the SDK's structured twin of the report. */
  structuredContextUsage: ParsedContextUsage | undefined;
  /** Per-model usage from the SDK's `result` chunk; the only per-model cost source. */
  modelUsageData: Record<string, TurnModelUsage> | undefined;

  /** `tool_use` id → the call object yielded to the consumer and mutated on result. */
  readonly toolCallsById: Map<string, TurnToolCall>;
}

export function createTurnState(init: {
  startTime: number;
  hideMessages: boolean;
  originalMessage: string;
}): TurnState {
  return {
    startTime: init.startTime,
    hideMessages: init.hideMessages,
    originalMessage: init.originalMessage,

    message: init.originalMessage,
    isSlashCommand: false,

    stderrLines: [],
    spawnDiagContext: null,

    fullContent: '',
    chunkCount: 0,
    firstChunkTime: undefined,
    toolCallCount: 0,
    receivedCompactBoundary: false,
    outstandingToolCalls: 0,
    resultReceivedTime: null,
    resultReceivedChunkCount: null,
    completeEmitted: false,
    sawAssistantOutputThisTurn: false,
    sawTaskNotificationThisTurn: false,
    blockingUsageLimit: null,

    usageData: undefined,
    lastAssistantUsage: undefined,
    structuredContextUsage: undefined,
    modelUsageData: undefined,

    toolCallsById: new Map(),
  };
}
