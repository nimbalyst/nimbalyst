/**
 * The tail half of `ClaudeCodeProvider.sendMessage()`: what happens once the
 * chunk loop stops, and what happens when it throws.
 *
 * Both pieces `yield`, so they are async generators the provider drives with
 * `yield*` — a plain function would swallow the chunks with no error.
 *
 * They read almost entirely from `TurnState`. That is the point of the seam:
 * `completeEmitted` decides whether a second `complete` is owed,
 * `fullContent`/`toolCallCount`/`receivedCompactBoundary` decide whether an
 * empty slash command reports an error, and `stderrLines`/`spawnDiagContext`
 * turn a bare `exited with code 139` into something a user can read. Every one
 * of those is written by the chunk loop, which is why the state object is
 * shared rather than copied.
 *
 * The `finally` block stays in the provider: it is teardown of provider-lifetime
 * fields (`leadQuery`, the streaming-instances set, the drain flags) that
 * `abort()` and `interruptCurrentTurn()` also touch from outside the turn, so
 * moving it here would mean re-exposing all of them through accessors.
 */

import type { StreamChunk } from '../../types';
import type { ClaudeCodeTranscriptAdapter } from './ClaudeCodeTranscriptAdapter';
import {
  armAgentSdkDebugLogging,
  collectSpawnCrashDiagnostics,
  isBunRuntimeSpawnCrash,
  readLatestSdkDebugLogTail,
} from './spawnCrashDiagnostics';
import { classifyAbnormalChildExit } from './abnormalExit';
import type { TurnState } from './turnState';

/** The provider members both epilogue paths use. */
export interface TurnEpilogueHost {
  /** Commits the turn's non-blocking DB writes before the consumer sees `complete`. */
  flushPendingWrites(): Promise<void>;
  processTranscriptMessages(sessionId: string): Promise<void>;
  logError(
    sessionId: string | undefined,
    provider: string,
    error: Error,
    source: string,
    errorType: string,
    hidden: boolean,
  ): void;
  /** Files edited this turn get an end-of-turn history snapshot. */
  toolHooksService: { getEditedFiles(): { size: number }; createTurnEndSnapshots(): Promise<void> } | null;
  prepareStreamClosedContinuation(sessionId: string | undefined, hideMessages: boolean): void;
}

export interface FinishTurnParams {
  sessionId?: string;
  transcriptAdapter: ClaudeCodeTranscriptAdapter | null;
}

/**
 * Runs after the chunk loop exits normally: report a slash command that
 * produced nothing, then emit the terminal `complete` if the `result` chunk
 * did not already do it.
 *
 * This is the ONLY place a turn completes, other than the successful `result`
 * chunk (which sets `completeEmitted`) and the error path below. The chunk
 * loop's error branches used to yield their own `complete` without setting the
 * flag, so an errored turn completed twice — and the second one, not the first,
 * was the one that ran the turn-end snapshots and carried usage. They now just
 * break and let this run.
 */
export async function* finishTurn(
  host: TurnEpilogueHost,
  state: TurnState,
  params: FinishTurnParams,
): AsyncGenerator<StreamChunk, void> {
  const { sessionId, transcriptAdapter } = params;

  // Check if this was a slash command that returned no output
  // This helps users understand when a command doesn't exist or failed silently
  // Skip this check if we received a compact_boundary (compact outputs via system message, not fullContent)
  if (state.isSlashCommand && state.fullContent.trim().length === 0 && state.toolCallCount === 0 && !state.receivedCompactBoundary) {
    // Extract the command name from the message for the error message
    const commandMatch = state.message.trimStart().match(/^\/(\S+)/);
    const commandName = commandMatch ? commandMatch[1] : 'unknown';

    const errorMessage = `The command "/${commandName}" did not produce any output. This command may not exist or may have failed silently. Try typing "/" to see available commands.`;

    // Log error to database for persistence
    // The logError call saves the message to the database and emits 'message:logged'
    // which triggers a session reload in the UI, displaying the error
    // Do NOT yield an error chunk here - that would cause duplicate display via ai:error IPC
    // Pass hideMessages so /context errors (auto-triggered) stay hidden
    host.logError(sessionId, 'claude-code', new Error(errorMessage), 'slash_command', 'slash_command_error', state.hideMessages);
  }

  // If we already emitted `complete` on the `result` chunk (the common
  // path), all post-turn side effects (flushPendingWrites, snapshots,
  // transcriptAdapter.turnEnded) were already run there. Skip them and the
  // duplicate yield. We only fall through to the legacy end-of-loop path
  // when no `result` chunk was ever seen (e.g. iterator closed early,
  // slash command produced no result).
  if (state.completeEmitted) return;

  // Flush all pending non-blocking DB writes before signaling completion.
  // Without this, the UI receives session:completed and reloads from DB
  // before the final messages (e.g. compact_boundary, continuation, result)
  // have been committed, causing a stale transcript.
  await host.flushPendingWrites();
  if (sessionId) await host.processTranscriptMessages(sessionId);

  // Create snapshots for all files edited during this turn
  if (host.toolHooksService && host.toolHooksService.getEditedFiles().size > 0) {
    await host.toolHooksService.createTurnEndSnapshots();
  }

  const usage = buildTurnCompleteUsage(state);

  // Compute context fill from last assistant message's usage (not cumulative result.usage).
  // CRITICAL: Use lastAssistantUsage, NOT usageData (which gets overwritten by cumulative result.usage).
  const lastMessageContextTokens = state.lastAssistantUsage
    ? (state.lastAssistantUsage.input_tokens || 0)
      + (state.lastAssistantUsage.cache_read_input_tokens || 0)
      + (state.lastAssistantUsage.cache_creation_input_tokens || 0)
    : undefined;

  // Canonical transcript: turn ended with usage
  transcriptAdapter?.turnEnded(state.usageData, state.modelUsageData);
  host.prepareStreamClosedContinuation(sessionId, state.hideMessages);

  yield {
    type: 'complete',
    // Don't send content here - it's already been sent in chunks
    // The AIService accumulates the chunks itself
    isComplete: true,
    ...(usage ? { usage } : {}),
    // Include modelUsage for detailed per-model breakdown and cost tracking
    ...(state.modelUsageData ? { modelUsage: state.modelUsageData } : {}),
    // Context fill from last assistant message (for context window display)
    ...(lastMessageContextTokens !== undefined ? { contextFillTokens: lastMessageContextTokens } : {}),
    ...(state.structuredContextUsage ? { contextReport: state.structuredContextUsage } : {}),
    // Signal that compaction happened so AIService clears stale currentContext
    ...(state.receivedCompactBoundary ? { contextCompacted: true } : {})
  };
}

export interface HandleTurnErrorHost extends TurnEpilogueHost {
  /** Maps a Nimbalyst session id to the CLI session id we asked to resume. */
  getResumeSessionId(sessionId: string): string | null | undefined;
  /** Diagnostic only — a miss in history.jsonl is not authoritative (see below). */
  checkSessionExists(claudeSessionId: string): Promise<boolean>;
  /** Crash-retry budget, per provider instance. Cleared by a completed turn or an abort. */
  getAbnormalExitRetryCount(): number;
  maxAbnormalExitRetries: number;
  consumeAbnormalExitRetry(): void;
}

/**
 * What the caller must do after the error was handled. `retry` is returned
 * rather than performed here because the retry re-enters `sendMessage` itself,
 * which only the provider can delegate to.
 */
export interface TurnErrorOutcome {
  retry: boolean;
}

/**
 * The turn threw. Classify it, log it, and emit whatever the consumer still
 * needs to stop showing a spinner.
 *
 * Three outcomes: a user abort (silent, just `complete`), a retryable native
 * subprocess crash (nothing emitted — the caller replays the turn), or a real
 * error (`error` + `complete`).
 */
export async function* handleTurnError(
  host: HandleTurnErrorHost,
  state: TurnState,
  error: any,
  sessionId: string | undefined,
): AsyncGenerator<StreamChunk, TurnErrorOutcome> {
  const errorTime = Date.now() - state.startTime;
  const isAbort = error.name === 'AbortError' || error.message?.includes('aborted');

  // #1361: a native subprocess fault reaches here as a bare
  // `exited with code <wait status>`. Classify it before anything else
  // consumes error.message, so both the transcript and the retry decision
  // work from the fault rather than the integer.
  const abnormalExit = isAbort ? null : classifyAbnormalChildExit({
    errorMessage: error.message,
    stderrLines: state.stderrLines,
    producedOutput: state.sawAssistantOutputThisTurn || state.completeEmitted,
  });

  // Only log details for non-abort errors
  if (!isAbort) {
    console.error(`[CLAUDE-CODE] ========== ERROR in sendMessage ==========`);
    console.error(`[CLAUDE-CODE] Error occurred after ${errorTime}ms`);
    console.error(`[CLAUDE-CODE] Error name: ${error.name}`);
    console.error(`[CLAUDE-CODE] Error message: ${error.message}`);
    console.error(`[CLAUDE-CODE] Error stack:`, error.stack);
    if (state.stderrLines.length > 0) {
      console.error(`[CLAUDE-CODE] Subprocess stderr (${state.stderrLines.length} lines):`);
      for (const line of state.stderrLines) {
        console.error(`[CLAUDE-CODE-STDERR] ${line}`);
      }
    }
    // Enrich the error message with stderr for the UI
    if (state.stderrLines.length > 0) {
      const stderrSummary = state.stderrLines.join('').trim().slice(0, 500);
      if (stderrSummary) {
        error.message = `${error.message}\n\nProcess output:\n${stderrSummary}`;
      }
    }

    // #614: the bundled CLI is a Bun-compiled binary; "An unknown error
    // occurred (Unexpected)" on exit 1 is Bun's native startup failure,
    // emitted before any JS-level logging. Log the process attributes a
    // child inherits from Electron (the prime suspects -- they can't be
    // reproduced by replaying argv/env in a shell), and arm the SDK's
    // debug mode so the next attempt passes --debug-file to the CLI.
    if (isBunRuntimeSpawnCrash(error.message, state.stderrLines)) {
      const diag = collectSpawnCrashDiagnostics(state.spawnDiagContext ?? {});
      console.error(`[CLAUDE-CODE] Native binary startup crash (Bun runtime). Spawn diagnostics: ${JSON.stringify(diag)}`);
      if (armAgentSdkDebugLogging()) {
        console.error('[CLAUDE-CODE] Armed DEBUG_CLAUDE_AGENT_SDK for subsequent attempts in this app run -- retry the message to capture a CLI debug log.');
      } else {
        const debugLog = await readLatestSdkDebugLogTail().catch(() => null);
        if (debugLog) {
          console.error(`[CLAUDE-CODE] SDK/CLI debug log tail (${debugLog.path}):\n${debugLog.tail}`);
        } else {
          console.error('[CLAUDE-CODE] Debug mode was armed but no SDK/CLI debug log was found -- the binary crashed before writing one.');
        }
      }
    }

    // #1361: log the same inherited-process attributes for a native fault,
    // then swap the raw wait status for the readable cause. The transcript,
    // the DB error record and the renderer all read error.message.
    if (abnormalExit) {
      const diag = collectSpawnCrashDiagnostics(state.spawnDiagContext ?? {});
      console.error(
        `[CLAUDE-CODE] Abnormal subprocess exit: kind=${abnormalExit.kind} `
        + `code=${abnormalExit.exitCode} retryable=${abnormalExit.retryable} `
        + `diagnostics=${JSON.stringify(diag)}`
      );
      error.message = abnormalExit.message;
    }
  }

  if (isAbort) {
    // Abort is expected - user cancelled, don't log as error
    await host.flushPendingWrites();
    if (sessionId) await host.processTranscriptMessages(sessionId);
    if (!state.completeEmitted) {
      yield {
        type: 'complete',
        isComplete: true
      };
    }
    return { retry: false };
  }

  if (abnormalExit?.retryable && host.getAbnormalExitRetryCount() < host.maxAbnormalExitRetries) {
    // #1361: the crash killed the subprocess before it produced anything,
    // so nothing has reached the transcript and re-running the turn cannot
    // duplicate output. In the reported case the fault was intermittent at
    // ~80%, which one retry very nearly covers.
    //
    // Re-entry, not a loop: the caller `yield*`s the whole retried turn, and
    // the inner call re-runs setup from the caller's original arguments.
    // The budget is per-provider and is only cleared by a completed turn or
    // an abort, so a binary that crashes every time settles after one extra
    // attempt instead of spinning.
    host.consumeAbnormalExitRetry();
    console.warn(
      `[CLAUDE-CODE] Retrying turn after ${abnormalExit.kind} `
      + `(attempt ${host.getAbnormalExitRetryCount()}/${host.maxAbnormalExitRetries})`
    );
    return { retry: true };
  }

  console.error(`[CLAUDE-CODE] Error occurred`);

  // Diagnostic only: log whether the resumed session was in history.jsonl.
  // We no longer mis-attribute arbitrary SDK errors to "session expired" --
  // history.jsonl lookups race with SDK writes and may not reflect programmatic
  // sessions, so a miss is not authoritative. The SDK's own error handling at
  // the isExpiredSessionError branch in the chunk loop is the source of truth
  // for real expiry.
  const resumeSessionId = sessionId ? host.getResumeSessionId(sessionId) : null;
  if (resumeSessionId) {
    const sessionExists = await host.checkSessionExists(resumeSessionId);
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
    host.logError(sessionId, 'claude-code', error, 'catch_block', 'exception', state.hideMessages);
  }

  yield {
    type: 'error',
    error: error.message,
    // #1361: the `complete` chunk below is emitted purely to clear the
    // renderer's spinner. Without this flag the consumer cannot tell a
    // crashed turn from a finished one and settles the session as a
    // success with an empty response.
    ...(abnormalExit ? { isProcessCrash: true } : {}),
  };

  // CRITICAL: Always send completion after error to clean up UI state.
  // Skip if we already emitted complete on the result chunk -- the UI
  // is already cleaned up; this error was raised after the turn was
  // delivered (e.g. teammate streamInput failure).
  await host.flushPendingWrites();
  if (sessionId) await host.processTranscriptMessages(sessionId);
  if (!state.completeEmitted) {
    host.prepareStreamClosedContinuation(sessionId, state.hideMessages);
    yield {
      type: 'complete'
    };
  }

  return { retry: false };
}

/**
 * The `complete` chunk's usage for one turn, or undefined when the SDK reported
 * none. Prefers result.usage (deduplicated by Anthropic via message.id).
 * modelUsage over-counts because the agent stream emits each assistant message
 * 2-3x (one event per content block) and modelUsage sums the dupes, so its sum
 * is only a fallback when result.usage is absent. See NIM-689.
 *
 * Anthropic reports input_tokens EXCLUDING cache reads and writes, so the three
 * input counters are disjoint and each is summed over the turn's API calls.
 */
export function buildTurnCompleteUsage(
  state: Pick<TurnState, 'usageData' | 'modelUsageData'>
): NonNullable<StreamChunk['usage']> | undefined {
  if (state.usageData) {
    const input = state.usageData.input_tokens || 0;
    const output = state.usageData.output_tokens || 0;
    return {
      input_tokens: input,
      output_tokens: output,
      cache_read_input_tokens: state.usageData.cache_read_input_tokens || 0,
      cache_creation_input_tokens: state.usageData.cache_creation_input_tokens || 0,
      total_tokens: input + output,
    };
  }
  if (!state.modelUsageData) return undefined;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheCreation = 0;
  for (const stats of Object.values(state.modelUsageData)) {
    input += stats.inputTokens || 0;
    output += stats.outputTokens || 0;
    cacheRead += stats.cacheReadInputTokens || 0;
    cacheCreation += stats.cacheCreationInputTokens || 0;
  }
  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheCreation,
    total_tokens: input + output,
  };
}
