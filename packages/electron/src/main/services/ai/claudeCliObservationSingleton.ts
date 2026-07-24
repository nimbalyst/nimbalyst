/**
 * Production wiring for the Claude CLI proxy observation backend (NIM-806,
 * Phase 3 / B3). This is the main-process glue that the DI-friendly pieces in
 * `claudeCliObservation/` plug into:
 *
 *   proxy (SSE tee + request body) → ClaudeCliProxyObservation (assemble + dedup)
 *     → bridge (raw `ai_agent_messages` rows) → `ai:message-logged` → transcript reload
 *
 * Exposes `startClaudeCliProxyObservation`, which `ClaudeCliSessionLauncher`
 * calls (via the launcher singleton) to start a per-session proxy before spawn.
 * It returns the `ANTHROPIC_BASE_URL` to point the CLI at and a `stop` to tear
 * the proxy down on PTY exit.
 *
 * What we persist / surface per turn:
 *   - each reassembled ASSISTANT turn (text / thinking / tool_use), deduped by
 *     Anthropic message id inside `ClaudeCliProxyObservation`;
 *   - `tool_result` rows from the next request body, deduped by tool_use_id
 *     (Slice E, `claudeCliToolResultLog.ts`) so the tool cards complete;
 *   - the context-window fill snapshot from each turn's usage (Slice E,
 *     `claudeCliContextUsage.ts`) → `ai:tokenUsageUpdated`.
 *
 * The USER prompt is NOT scraped from the request body — on a real Claude Code
 * turn that trailing user message is the whole injected context (CLAUDE.md,
 * memory, `<system-reminder>`, file context). It's captured at SEND time instead
 * (see `claudeCliUserPromptLog.ts`, fired from `submitClaudeCliPrompt` via the
 * `claude-cli:submit-prompt` IPC).
 */

import { ClaudeCliProxyObservation } from './claudeCliObservation/claudeCliProxyObservation';
import { buildAssistantRawContent } from './claudeCliObservation/claudeCliTranscriptBridge';
import { AgentMessagesRepository } from '@nimbalyst/runtime';
import { broadcastMessageLogged as notifyMessageLogged } from './claudeCliUserPromptLog';
import { logClaudeCliToolResults, loadSeenToolResultIds } from './claudeCliToolResultLog';
import { getSeenToolResultIds, clearSeenToolResultIds } from './claudeCliToolResultSeen';
import { logClaudeCliContextUsage } from './claudeCliContextUsage';
import { classifyClaudeCliUpstreamError } from './claudeCliErrorClassifier';
import { createClaudeCliErrorSurfacePolicy } from './claudeCliErrorSurfacePolicy';
import { logClaudeCliUpstreamError } from './claudeCliErrorLog';
import { extractToolResults } from './claudeCliObservation/claudeApiRequestParser';
import {
  isSubAgentTurnInFlight,
  noteAssistantTaskCalls,
  noteToolResultsCompleteTasks,
  clearSubAgentTracking,
} from './claudeCliSubAgentTracker';
import { trackClaudeCliFileEdits } from './claudeCliFileTracking';
import { sessionFileTracker } from '../SessionFileTracker';
import { findWindowByWorkspace } from '../../window/WindowManager';
import { extractAssistantText, buildTurnNotificationBody } from './claudeCliTurnNotification';
import { buildClaudeCliResponseEvent } from './claudeCliResponseAnalytics';
import {
  recordClaudeCliTurnMessage,
  takeClaudeCliTurnSummary,
  clearClaudeCliTurnSummary,
} from './claudeCliTurnSummary';
import { AnalyticsService } from '../analytics/AnalyticsService';
import { notificationService } from '../NotificationService';
import { SoundNotificationService } from '../SoundNotificationService';
import { getSyncProvider, isDesktopTrulyAway } from '../SyncManager';
import { AISessionsRepository } from '@nimbalyst/runtime';
import { getClaudeCodeApiUpstreamUrl } from '../../utils/store';
import type { AssembledAssistantMessage } from './claudeCliObservation/claudeApiMessageAssembler';

/**
 * Fire the completion sound + "Response Ready" OS notification (+ mobile push when
 * the desktop is truly away) on a CLI turn end, mirroring the SDK path in
 * `MessageStreamingHandler`. Best-effort: never throws into the observation loop.
 */
async function notifyClaudeCliTurnComplete(
  sessionId: string,
  workspacePath: string,
  text: string,
): Promise<void> {
  try {
    SoundNotificationService.getInstance().playCompletionSound(workspacePath);

    const body = buildTurnNotificationBody(text);
    let title = 'claude-code-cli';
    try {
      const session = await AISessionsRepository.get(sessionId);
      title = session?.title || session?.provider || title;
    } catch {
      // best-effort label
    }

    await notificationService.showNotification({
      title: `${title} -- Response Ready`,
      body,
      sessionId,
      workspacePath,
      provider: 'claude-code-cli',
    });

    // Mobile push only when the user has truly left the machine (screen
    // locked / idle past threshold) — otherwise the OS notification above
    // already covers it and a push would duplicate via Continuity.
    if (isDesktopTrulyAway()) {
      getSyncProvider()?.requestMobilePush?.(sessionId, title, body);
    }
  } catch (err) {
    console.warn('[ClaudeCliObservation] Failed to fire turn-complete notification:', err);
  }
}

/**
 * Fire the turn-completion side effects (notification, sound, mobile push,
 * `ai_response_received`) ONCE for a fully-completed turn. Called by the launcher
 * on the CLI PID `idle` transition — the authoritative whole-turn boundary that,
 * unlike a proxy `end_turn`, accounts for in-process `Task` sub-agents. No-op when
 * there's no observed summary (terminal-only mode / a turn that produced nothing).
 */
export function fireClaudeCliTurnCompletion(sessionId: string, workspacePath: string): void {
  const summary = takeClaudeCliTurnSummary(sessionId);
  if (!summary) return;
  void notifyClaudeCliTurnComplete(sessionId, workspacePath, summary.lastAssistantText);
  try {
    AnalyticsService.getInstance().sendEvent(
      'ai_response_received',
      buildClaudeCliResponseEvent({ toolNames: summary.toolNames, finalText: summary.lastAssistantText }),
    );
  } catch {
    // analytics is best-effort
  }
}

async function persistAssistantTurn(
  sessionId: string,
  workspacePath: string,
  msg: AssembledAssistantMessage,
  hidden: boolean,
): Promise<void> {
  try {
    await AgentMessagesRepository.create({
      sessionId,
      source: 'claude-code',
      direction: 'output',
      // Sub-agent (`Task`) turns are persisted but HIDDEN so they don't pollute
      // the visible transcript (the B3 wire has no parent_tool_use_id to filter
      // on — see claudeCliSubAgentTracker). File-edit attribution below still runs
      // for them, so a sub-agent's edits are tracked.
      content: buildAssistantRawContent(msg),
      hidden,
      createdAt: new Date(),
    });
    notifyMessageLogged(sessionId, workspacePath);
  } catch (err) {
    console.warn('[ClaudeCliObservation] Failed to persist assistant turn:', err);
  }

  // Attribute file edits/reads so the FilesEditedSidebar, context-graph edges,
  // and committed-session detection work for CLI sessions (parity with the SDK,
  // which calls trackToolExecution on every observed tool_call). Result line
  // counts aren't available at tool_use time — that's fine, the SDK tracks here
  // too. Bash-driven edits rely on watcher attribution (not yet wired for CLI).
  try {
    const window = findWindowByWorkspace(workspacePath);
    await trackClaudeCliFileEdits({
      message: msg,
      track: (toolName, input, toolUseId) =>
        sessionFileTracker.trackToolExecution(
          sessionId,
          workspacePath,
          toolName,
          input,
          null,
          toolUseId,
          window,
        ),
    });
  } catch (err) {
    console.warn('[ClaudeCliObservation] Failed to track file edits:', err);
  }
}

/**
 * Start a proxy observation session for one CLI session. Best-effort: the caller
 * (launcher) tolerates a throw and launches the CLI without observation.
 */
export async function startClaudeCliProxyObservation(opts: {
  sessionId: string;
  workspacePath: string;
}): Promise<{ baseUrl: string; stop: () => void } | null> {
  const { sessionId, workspacePath } = opts;

  // tool_result blocks re-appear in every subsequent request body — dedup so each
  // is persisted once for the lifetime of this observation session (Slice E).
  // Use the SHARED per-session registry so the MCP interactive-prompt settle's
  // synthetic write (which marks the same registry) is already deduped before the
  // proxy scrapes the CLI's echoed tool_result (NIM-806 Defect B). Pre-seed from
  // already-persisted rows so a RESUMED session (`--resume`, BUG 3) doesn't re-log
  // the prior tool_results its first request body replays.
  const seenToolResultIds = getSeenToolResultIds(sessionId);
  for (const id of await loadSeenToolResultIds(sessionId)) {
    seenToolResultIds.add(id);
  }

  // Failed-turn surfacing policy (NIM-808 / NIM-815): collapses retry storms
  // into one transcript row per episode and swallows transient startup errors
  // (cold-connection 429/529 plus a small budget of api_error/generic) until
  // the first visible assistant output. See claudeCliErrorSurfacePolicy.ts.
  const errorSurfacePolicy = createClaudeCliErrorSurfacePolicy();

  // Advanced opt-in: route the CLI's `/v1/messages` through a user-configured
  // loopback upstream (token-compression / gateway / cache) before Anthropic.
  // Undefined → direct to api.anthropic.com (unchanged default). Observation of
  // the ORIGINAL request body / response SSE is unaffected — we only change where
  // the bytes are forwarded.
  const apiUpstreamUrl = getClaudeCodeApiUpstreamUrl();

  const observation = new ClaudeCliProxyObservation({
    sessionId,
    upstreamUrl: apiUpstreamUrl,
    onAssistantMessage: (msg) => {
      // Is this turn a `Task` sub-agent's? (A Task was in flight BEFORE this
      // message.) The parent message that CARRIES the Task call is itself still
      // a visible parent turn — we note its Task calls only after this check.
      const isSubAgentTurn = isSubAgentTurnInFlight(sessionId);
      // A produced turn means the session is unblocked: allow the next failure
      // episode to surface, and (for visible turns) mark that startup is past so
      // a mid-session rate-limit/overload can surface.
      errorSurfacePolicy.noteAssistantMessage(!isSubAgentTurn);
      void persistAssistantTurn(sessionId, workspacePath, msg, isSubAgentTurn);
      noteAssistantTaskCalls(sessionId, msg);
      // Refresh the context-window fill indicator from this turn's usage (Slice E).
      void logClaudeCliContextUsage({ sessionId, usage: msg.usage });
      // Accumulate the turn summary (text + tool names) for the completion
      // notification — VISIBLE (parent) turns only, so a sub-agent's text/tools
      // don't surface in the "Response Ready" body. The side effects fire from the
      // launcher's PID `idle` transition (the whole-turn boundary), NOT per message.
      if (!isSubAgentTurn) {
        const toolNames = msg.content
          .filter((b): b is Extract<typeof b, { type: 'tool_use' }> => b.type === 'tool_use')
          .map((b) => b.name);
        recordClaudeCliTurnMessage(sessionId, { text: extractAssistantText(msg), toolNames });
      }
    },
    onRequestBody: (body) => {
      // The tee'd SSE only carries the assistant's tool_use calls; the matching
      // tool_results ride in the next request body's trailing user message.
      const results = extractToolResults(body);
      if (results.length > 0) {
        // A `Task` tool_result here ends that sub-agent's in-flight window. Mark
        // completions FIRST, then decide whether this body is still sub-agent
        // traffic: a sub-agent's own intermediate tool_results (Bash/Read) keep
        // the window open and are NOT logged (they'd orphan against hidden rows);
        // the parent's Task result closes it and IS logged (attaches to the
        // visible parent Task tool_use).
        noteToolResultsCompleteTasks(sessionId, results.map((r) => r.toolUseId));
        if (!isSubAgentTurnInFlight(sessionId)) {
          void logClaudeCliToolResults({ sessionId, workspacePath, results, seen: seenToolResultIds });
        }
      }
    },
    onError: (err) => {
      console.warn('[ClaudeCliObservation] proxy error:', err.message);
    },
    onRateLimit: ({ statusCode, retryAfter }) => {
      // The SDK path surfaces 429/529 in-stream; the CLI's own TUI shows it too,
      // but the user may be looking at the rich transcript, so raise an OS
      // notification (self-guards on focus/settings).
      console.warn(`[ClaudeCliObservation] upstream rate-limit ${statusCode} for ${sessionId}`, retryAfter ?? '');
      const body =
        statusCode === 529
          ? 'Anthropic is overloaded. Claude will retry shortly.'
          : `Rate limited by Anthropic${retryAfter ? ` (retry after ${retryAfter}s)` : ''}.`;
      void notificationService
        .showNotification({ title: 'Claude CLI -- paused', body, sessionId, workspacePath, provider: 'claude-code-cli' })
        .catch(() => {});
    },
    onUpstreamError: ({ statusCode, body, retryAfter }) => {
      // Render a failed turn IN the rich transcript so a rate-limited / failed
      // turn is a visible "paused"/"failed" state, not a silent hang (NIM-808).
      const failure = classifyClaudeCliUpstreamError({ statusCode, body, retryAfter });
      if (!failure) return;

      if (!errorSurfacePolicy.shouldSurface(failure)) {
        console.warn(
          `[ClaudeCliObservation] suppressed upstream ${failure.kind} (${failure.statusCode}) for ${sessionId} (startup-transient or same-episode retry)`
        );
        return;
      }

      void logClaudeCliUpstreamError({ sessionId, workspacePath, failure });
    },
  });

  const { baseUrl } = await observation.start();
  console.log(`[ClaudeCliObservation] proxy started for ${sessionId} at ${baseUrl}`);
  return {
    baseUrl,
    stop: () => {
      observation.stop();
      // Drop the per-session seen-set so a later relaunch re-seeds from the DB.
      clearSeenToolResultIds(sessionId);
      clearClaudeCliTurnSummary(sessionId);
      clearSubAgentTracking(sessionId);
    },
  };
}
