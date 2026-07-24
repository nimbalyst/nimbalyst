import * as path from 'path';
import { createHash } from 'crypto';
import { SessionFilesRepository } from '@nimbalyst/runtime';
import { historyManager } from '../HistoryManager';
import { getSubscriberIds } from '../file/WorkspaceEventBus';
import { logger } from '../utils/logger';
import { pathContainsExcludedDir } from '../utils/fileFilters';
import { sessionEditQuota } from './SessionEditQuota';
import { workspaceAttributionThrottle } from './WorkspaceAttributionThrottle';
import { toolCallMatcher } from './ToolCallMatcher';
import { codexEditWindowRegistry } from './CodexEditWindowRegistry';
import { notifySessionFilesUpdated } from './sessionFilesNotify';
import { workspaceFileAttributionPolicy } from './WorkspaceFileAttributionPolicy';

export interface WorkspaceFileEditEvent {
  workspacePath: string;
  filePath: string;
  timestamp: number;
  beforeContent?: string | null;
}

interface WorkspaceQueueState {
  queue: WorkspaceFileEditEvent[];
  processing: boolean;
  recentByFile: Map<string, { ingestedAt: number; eventTimestamp: number }>;
  processedEventKeys: Map<string, number>;
}

const EVENT_DEDUPE_WINDOW_MS = 250;
const EVENT_TTL_MS = 30_000;
const MAX_QUEUE_SIZE = 500;
const CODEX_WINDOW_SETTLE_MS = 40;

/** Per-workspace attribution counters for observability. */
interface AttributionCounters {
  eventsReceived: number;
  eventsDeduped: number;
  attributedEdits: number;
  unattributedEdits: number;
  tagsCreated: number;
}

/** Interval (ms) between periodic counter summary logs. */
const COUNTER_LOG_INTERVAL_MS = 60_000;

class WorkspaceFileEditAttributionServiceImpl {
  private readonly stateByWorkspace = new Map<string, WorkspaceQueueState>();
  private readonly counters = new Map<string, AttributionCounters>();
  private counterLogTimer: ReturnType<typeof setInterval> | null = null;

  private getCounters(workspacePath: string): AttributionCounters {
    const existing = this.counters.get(workspacePath);
    if (existing) return existing;
    const c: AttributionCounters = { eventsReceived: 0, eventsDeduped: 0, attributedEdits: 0, unattributedEdits: 0, tagsCreated: 0 };
    this.counters.set(workspacePath, c);

    // Start periodic counter logging on first workspace
    if (!this.counterLogTimer) {
      this.counterLogTimer = setInterval(() => this.logCounterSummary(), COUNTER_LOG_INTERVAL_MS);
      // Unref so it doesn't prevent process exit
      if (this.counterLogTimer && typeof this.counterLogTimer === 'object' && 'unref' in this.counterLogTimer) {
        this.counterLogTimer.unref();
      }
    }

    return c;
  }

  private logCounterSummary(): void {
    for (const [workspacePath, c] of this.counters.entries()) {
      if (c.eventsReceived === 0) continue;
      // logger.main.handleSetContentMode
    }
  }

  ingestWatcherEvent(rawEvent: WorkspaceFileEditEvent): void {
    const workspacePath = path.resolve(rawEvent.workspacePath);
    const filePath = path.resolve(rawEvent.filePath);
    if (pathContainsExcludedDir(filePath)) {
      return;
    }
    // Burst guard: if the workspace is producing watcher events faster than
    // a human + AI realistically can, assume it's a build or codegen dump
    // and drop the event before it costs PGLite anything.
    if (!workspaceAttributionThrottle.tryAcquire(workspacePath)) {
      return;
    }
    const event: WorkspaceFileEditEvent = {
      ...rawEvent,
      workspacePath,
      filePath,
    };
    const now = Date.now();
    const counters = this.getCounters(workspacePath);
    counters.eventsReceived++;
    const state = this.getOrCreateState(workspacePath);
    this.cleanupState(state, now);

    const recent = state.recentByFile.get(filePath);
    if (recent) {
      const ingestDiff = now - recent.ingestedAt;
      const eventDiff = Math.abs(event.timestamp - recent.eventTimestamp);
      if (ingestDiff <= EVENT_DEDUPE_WINDOW_MS && eventDiff <= EVENT_DEDUPE_WINDOW_MS) {
        counters.eventsDeduped++;
        logger.main.debug('[WorkspaceFileEditAttributionService] Deduped watcher event:', {
          workspacePath,
          filePath,
          eventTimestamp: event.timestamp,
          previousTimestamp: recent.eventTimestamp,
          ingestDiff,
        });
        return;
      }
    }

    if (state.queue.length >= MAX_QUEUE_SIZE) {
      state.queue.shift();
      logger.main.warn('[WorkspaceFileEditAttributionService] Queue full, dropping oldest event:', {
        workspacePath,
        filePath,
      });
    }

    state.recentByFile.set(filePath, {
      ingestedAt: now,
      eventTimestamp: event.timestamp,
    });
    state.queue.push(event);

    logger.main.debug('[WorkspaceFileEditAttributionService] Ingested watcher event:', {
      workspacePath,
      filePath,
      timestamp: event.timestamp,
      queueLength: state.queue.length,
    });

    void this.processQueue(workspacePath);
  }

  private getOrCreateState(workspacePath: string): WorkspaceQueueState {
    const existing = this.stateByWorkspace.get(workspacePath);
    if (existing) return existing;

    const state: WorkspaceQueueState = {
      queue: [],
      processing: false,
      recentByFile: new Map(),
      processedEventKeys: new Map(),
    };
    this.stateByWorkspace.set(workspacePath, state);
    return state;
  }

  private cleanupState(state: WorkspaceQueueState, now: number): void {
    for (const [filePath, recent] of state.recentByFile.entries()) {
      if (now - recent.ingestedAt > EVENT_TTL_MS) {
        state.recentByFile.delete(filePath);
      }
    }

    for (const [eventKey, seenAt] of state.processedEventKeys.entries()) {
      if (now - seenAt > EVENT_TTL_MS) {
        state.processedEventKeys.delete(eventKey);
      }
    }
  }

  private makeEventKey(event: WorkspaceFileEditEvent, sessionId: string): string {
    const timestampBucket = Math.floor(event.timestamp / EVENT_DEDUPE_WINDOW_MS);
    const hash = createHash('sha1')
      .update(`${event.filePath}|${timestampBucket}`)
      .digest('hex')
      .slice(0, 16);
    return `${sessionId}:${hash}`;
  }

  private makeWatcherToolUseId(event: WorkspaceFileEditEvent): string {
    const hash = createHash('sha1')
      .update(`${event.filePath}|${event.timestamp}`)
      .digest('hex')
      .slice(0, 12);
    return `watcher-${hash}`;
  }

  private findCodexWindowMatch(
    candidateSessionIds: string[],
    event: WorkspaceFileEditEvent,
  ): { sessionId: string; editGroupId: string; toolName: string } | null {
    for (const sessionId of candidateSessionIds) {
      const window = codexEditWindowRegistry.findWindowForEdit({
        sessionId,
        workspacePath: event.workspacePath,
        filePath: event.filePath,
        fileTimestamp: event.timestamp,
      });
      if (window) {
        return {
          sessionId: window.sessionId,
          editGroupId: window.editGroupId,
          toolName: window.toolName,
        };
      }
    }
    return null;
  }

  private async processQueue(workspacePath: string): Promise<void> {
    const state = this.stateByWorkspace.get(workspacePath);
    if (!state || state.processing) return;
    state.processing = true;

    try {
      while (state.queue.length > 0) {
        const event = state.queue.shift();
        if (!event) continue;
        await this.processEvent(event, state);
      }
    } finally {
      state.processing = false;
    }
  }

  private async processEvent(event: WorkspaceFileEditEvent, state: WorkspaceQueueState): Promise<void> {
    try {
      const candidateSessionIds = getSubscriberIds(event.workspacePath);
      if (candidateSessionIds.length === 0) {
        logger.main.debug('[WorkspaceFileEditAttributionService] No active sessions for event:', {
          workspacePath: event.workspacePath,
          filePath: event.filePath,
          timestamp: event.timestamp,
        });
        return;
      }

      // App-server fileChange items are the authoritative edit stream. Disable
      // pooled listener attribution for the entire workspace while any such
      // session is active: a filesystem event has no reliable origin, so
      // assigning it to a concurrent listener-backed session would merely move
      // the same cross-session race to that session.
      if (workspaceFileAttributionPolicy.hasDisabledSession(event.workspacePath)) {
        logger.main.debug('[WorkspaceFileEditAttributionService] Listener attribution disabled for workspace:', {
          workspacePath: event.workspacePath,
          filePath: event.filePath,
          timestamp: event.timestamp,
        });
        return;
      }

      // Codex edit windows take precedence over the fuzzy time-based matcher.
      // If a write-capable Codex tool call is open (or recently closed within
      // the grace window) for one of the candidate sessions and its window
      // covers `event.timestamp`, attribute to that canonical synthetic
      // edit-group ID directly. This guarantees the same `nimtc|...` ID lands
      // on the session_files row, the pre-edit history tag, and the canonical
      // tool_call event.
      let codexWindowMatch = this.findCodexWindowMatch(candidateSessionIds, event);
      if (!codexWindowMatch) {
        // MCP writes can hit disk a few milliseconds before the parsed tool
        // call opens its exact edit window. Give that path a brief chance
        // before consulting the attribution policy below.
        await new Promise((resolve) => setTimeout(resolve, CODEX_WINDOW_SETTLE_MS));
        codexWindowMatch = this.findCodexWindowMatch(candidateSessionIds, event);
      }

      const matchResult = codexWindowMatch
        ? null
        : await toolCallMatcher.matchWorkspaceFileEdit({
            workspacePath: event.workspacePath,
            filePath: event.filePath,
            fileTimestamp: event.timestamp,
            candidateSessionIds,
          });

      const counters = this.getCounters(event.workspacePath);

      if (!codexWindowMatch && (!matchResult || !matchResult.winner)) {
        counters.unattributedEdits++;
        logger.main.debug('[WorkspaceFileEditAttributionService] No attribution winner for event:', {
          workspacePath: event.workspacePath,
          filePath: event.filePath,
          timestamp: event.timestamp,
          candidateCount: matchResult?.candidates.length ?? 0,
          reason: matchResult?.reason ?? 'no-codex-window',
        });
        return;
      }

      const winner = codexWindowMatch
        ? {
            sessionId: codexWindowMatch.sessionId,
            toolUseId: codexWindowMatch.editGroupId,
            toolName: codexWindowMatch.toolName,
            score: 1,
            reasons: ['codex-edit-window'],
            messageId: null as number | null,
            toolCallItemId: null as string | null,
          }
        : matchResult!.winner!;
      const eventKey = this.makeEventKey(event, winner.sessionId);
      if (state.processedEventKeys.has(eventKey)) {
        logger.main.debug('[WorkspaceFileEditAttributionService] Skipping already-processed event key:', {
          eventKey,
          sessionId: winner.sessionId,
          filePath: event.filePath,
        });
        return;
      }
      state.processedEventKeys.set(eventKey, Date.now());

      if (!(await sessionEditQuota.tryReserve(winner.sessionId, event.filePath))) {
        return;
      }

      const toolUseId = winner.toolUseId || this.makeWatcherToolUseId(event);

      if (codexWindowMatch) {
        codexEditWindowRegistry.recordObservation(codexWindowMatch.editGroupId, event.filePath);
      }

      // Skip the watcher-attribution session_files insert when the matched
      // tool already has its own pre-edit hook that writes a session_files
      // row with the correct operation (`create` / `edit` / `delete`).
      // OpenAICodexProvider emits a `pre_edit_snapshot` chunk on
      // item.started for `file_change`, which routes through
      // sessionFileTracker.trackToolExecution -- BEFORE the file is written
      // and well before chokidar fires. A redundant watcher-attribution row
      // here would clobber the create/delete kind with a hardcoded
      // `operation: 'edit'` (different signature -> new row), and the
      // ai_tool_call_file_edits matcher would then link against the wrong
      // row in the renderer.
      const skipWatcherAttribution = winner.toolName === 'file_change';
      if (!skipWatcherAttribution) {
        await SessionFilesRepository.addFileLink({
          sessionId: winner.sessionId,
          workspaceId: event.workspacePath,
          filePath: event.filePath,
          linkType: 'edited',
          timestamp: event.timestamp,
          metadata: {
            toolName: winner.toolName,
            operation: winner.toolName === 'Bash' ? 'bash' : 'edit',
            toolUseId,
            watcherAttribution: {
              score: winner.score,
              reasons: winner.reasons,
              messageId: winner.messageId,
              toolCallItemId: winner.toolCallItemId,
              fileTimestamp: event.timestamp,
            },
          },
        });
      }

      counters.attributedEdits++;

      if (event.beforeContent == null) {
        // Don't create a tag with empty baseline - the proactive file_change handler
        // or trackBashFileEditsFromCommand will create one with correct content shortly.
        logger.main.info('[WorkspaceFileEditAttributionService] Skipping tag creation - no baseline available (cache miss):', {
          filePath: event.filePath,
          sessionId: winner.sessionId,
          toolUseId,
        });
      } else {
        const tagId = `ai-edit-pending-${winner.sessionId}-${toolUseId}`;
        await historyManager.createTag(
          event.workspacePath,
          event.filePath,
          tagId,
          event.beforeContent,
          winner.sessionId,
          toolUseId,
        );
        counters.tagsCreated++;
      }

      // logger.main.info('[WorkspaceFileEditAttributionService] Attributed file edit:', {
      //   workspacePath: event.workspacePath,
      //   filePath: event.filePath,
      //   sessionId: winner.sessionId,
      //   score: winner.score,
      //   reasons: winner.reasons,
      //   messageId: winner.messageId,
      // });

      // NIM-816: route through the shared notifier so the session-files IPC
      // cache is invalidated too — broadcasting without invalidating let the
      // renderer re-query into a stale empty cache entry.
      notifySessionFilesUpdated(winner.sessionId);
    } catch (error) {
      logger.main.error('[WorkspaceFileEditAttributionService] Failed to process event:', {
        filePath: event.filePath,
        workspacePath: event.workspacePath,
        error,
      });
    }
  }
}

export const workspaceFileEditAttributionService = new WorkspaceFileEditAttributionServiceImpl();
