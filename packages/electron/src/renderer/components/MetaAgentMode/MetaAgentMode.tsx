import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { atom } from 'jotai';
import { useAtomValue } from 'jotai';
import { MaterialSymbol } from '@nimbalyst/runtime';
import { store } from '@nimbalyst/runtime/store';
import { defaultAgentModelAtom } from '../../store/atoms/appSettings';
import { sessionRegistryAtom } from '../../store';
import { sessionTokenUsageAtom } from '../../store/atoms/sessions';
import { getRelativeTimeString } from '../../utils/dateFormatting';
import { createMetaAgentSession } from '../../utils/metaAgentUtils';
import { SessionTranscript } from '../UnifiedAI/SessionTranscript';

interface MetaAgentModeProps {
  workspacePath: string;
  isActive?: boolean;
  /** If provided, use this session ID directly instead of finding/creating one */
  sessionId?: string;
  onOpenSessionInAgent?: (sessionId: string) => void;
}

interface SpawnedSessionSummary {
  sessionId: string;
  title: string;
  provider: string;
  model: string | null;
  status: string;
  lastActivity: number | null;
  originalPrompt: string | null;
  lastResponse: string | null;
  editedFiles: string[];
  pendingPrompt: {
    promptId: string;
    promptType: string;
  } | null;
  createdAt: number;
  updatedAt: number;
  worktreeId?: string | null;
}

interface TimelineWindow {
  sessionId: string;
  title: string;
  status: string;
  startedAt: number;
  endedAt: number;
  leftPct: number;
  widthPct: number;
  durationMs: number;
}

function formatAbsoluteTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatDuration(durationMs: number): string {
  const minutes = Math.max(1, Math.round(durationMs / 60000));
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`;
}

function getStatusTone(status: string): string {
  switch (status) {
    case 'running':
      return 'text-[var(--nim-primary)] bg-[rgba(59,130,246,0.12)]';
    case 'waiting_for_input':
      return 'text-[var(--nim-warning)] bg-[rgba(245,158,11,0.16)]';
    case 'error':
    case 'interrupted':
      return 'text-[var(--nim-error)] bg-[rgba(239,68,68,0.14)]';
    default:
      return 'text-[var(--nim-text-muted)] bg-[var(--nim-bg-tertiary)]';
  }
}

function formatTokensShort(tokens: number): string {
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  if (tokens >= 1000) {
    return `${Math.round(tokens / 1000)}k`;
  }
  return tokens.toString();
}

function getBarTone(status: string): string {
  switch (status) {
    case 'running':
      return 'bg-[rgba(59,130,246,0.35)]';
    case 'waiting_for_input':
      return 'bg-[rgba(245,158,11,0.35)]';
    case 'error':
    case 'interrupted':
      return 'bg-[rgba(239,68,68,0.30)]';
    default:
      return 'bg-[var(--nim-bg-tertiary)]';
  }
}

/** Reads per-session token usage from Jotai without causing parent to subscribe */
function TimelineRowLabel({ window }: { window: TimelineWindow }) {
  const tokenUsage = useAtomValue(sessionTokenUsageAtom(window.sessionId));

  const totalTokens = tokenUsage?.totalTokens ?? 0;
  const ctxTokens = tokenUsage?.currentContext?.tokens ?? 0;
  const ctxWindow = tokenUsage?.currentContext?.contextWindow ?? 0;
  const hasCtx = ctxWindow > 0;
  const ctxPct = hasCtx ? Math.round((ctxTokens / ctxWindow) * 100) : 0;

  return (
    <div className="min-w-0 rounded-lg bg-[var(--nim-bg-secondary)] px-3 py-2">
      <div className="truncate text-sm font-medium text-[var(--nim-text)]">{window.title}</div>
      <div className="mt-1 flex items-center gap-2 text-[11px] text-[var(--nim-text-muted)]">
        <span className={`rounded-full px-2 py-0.5 ${getStatusTone(window.status)}`}>
          {window.status}
        </span>
        <span>{formatDuration(window.durationMs)}</span>
      </div>
      <div className="mt-1 flex items-center gap-2 text-[11px] text-[var(--nim-text-faint)]">
        <span>
          {totalTokens > 0 ? `${formatTokensShort(totalTokens)} tokens` : '--'}
        </span>
        {hasCtx && (
          <>
            <span className="text-[var(--nim-border)]">|</span>
            <span className="flex items-center gap-1.5">
              {formatTokensShort(ctxTokens)}/{formatTokensShort(ctxWindow)} ctx
              <span className="inline-flex h-1.5 w-10 rounded-full bg-[var(--nim-bg-tertiary)] overflow-hidden">
                <span
                  className={`h-full rounded-full ${ctxPct > 80 ? 'bg-[var(--nim-warning)]' : 'bg-[var(--nim-primary)]'}`}
                  style={{ width: `${Math.min(ctxPct, 100)}%` }}
                />
              </span>
              <span>{ctxPct}%</span>
            </span>
          </>
        )}
      </div>
      <div className="mt-0.5 text-[11px] text-[var(--nim-text-faint)]">
        {formatAbsoluteTime(window.startedAt)} - {formatAbsoluteTime(window.endedAt)}
      </div>
    </div>
  );
}

/** Reads aggregate token usage for timeline header summary */
function TimelineAggregateSummary({ sessionIds }: { sessionIds: string[] }) {
  // Create a derived atom that aggregates all session token usages reactively
  const aggregateAtom = useMemo(
    () =>
      atom((get) => {
        let totalTokens = 0;
        for (const id of sessionIds) {
          const usage = get(sessionTokenUsageAtom(id));
          if (usage) {
            totalTokens += usage.totalTokens ?? 0;
          }
        }
        return totalTokens;
      }),
    [sessionIds]
  );
  const totalTokens = useAtomValue(aggregateAtom);

  if (totalTokens === 0) return null;

  return (
    <span className="rounded-full bg-[var(--nim-bg-secondary)] px-2.5 py-1 text-[var(--nim-text-muted)]">
      {formatTokensShort(totalTokens)} total tokens
    </span>
  );
}

export function MetaAgentMode({
  workspacePath,
  isActive = false,
  sessionId: externalSessionId,
  onOpenSessionInAgent,
}: MetaAgentModeProps) {
  const defaultModel = useAtomValue(defaultAgentModelAtom);
  const [metaSessionId, setMetaSessionId] = useState<string | null>(externalSessionId ?? null);
  const [loadingSession, setLoadingSession] = useState(!externalSessionId);
  const [loadingChildren, setLoadingChildren] = useState(false);
  const [childSessions, setChildSessions] = useState<SpawnedSessionSummary[]>([]);
  const [showTimeline, setShowTimeline] = useState(false);

  const createMetaSession = useCallback(
    async (): Promise<string | null> => {
      const result = await createMetaAgentSession(workspacePath, defaultModel);
      return result?.id ?? null;
    },
    [defaultModel, workspacePath]
  );

  const ensureMetaSession = useCallback(async () => {
    setLoadingSession(true);
    try {
      const existing = await window.electronAPI.invoke('sessions:list', workspacePath, { includeArchived: false });
      if (existing?.success && Array.isArray(existing.sessions)) {
        const metaSessions = existing.sessions
          .filter((session: any) => session.agentRole === 'meta-agent' && !session.isArchived)
          .sort((a: any, b: any) => b.updatedAt - a.updatedAt);

        if (metaSessions.length > 0) {
          setMetaSessionId(metaSessions[0].id);
          return;
        }
      }

      const createdSessionId = await createMetaSession();
      if (createdSessionId) {
        setMetaSessionId(createdSessionId);
      }
    } catch (error) {
      console.error('[MetaAgentMode] Failed to initialize meta-agent session:', error);
    } finally {
      setLoadingSession(false);
    }
  }, [createMetaSession, workspacePath]);

  const handleClearMetaSession = useCallback(async () => {
    if (!metaSessionId) {
      return;
    }

    setLoadingSession(true);
    setChildSessions([]);

    try {
      const previousSessionId = metaSessionId;
      const nextSessionId = await createMetaSession();
      if (!nextSessionId) {
        throw new Error('Failed to create replacement meta-agent session');
      }

      setMetaSessionId(nextSessionId);

      await window.electronAPI.invoke('sessions:update-metadata', previousSessionId, {
        isArchived: true,
      });
    } catch (error) {
      console.error('[MetaAgentMode] Failed to clear meta-agent session:', error);
    } finally {
      setLoadingSession(false);
    }
  }, [createMetaSession, metaSessionId]);

  const refreshSpawnedSessions = useCallback(async (sessionId: string) => {
    setLoadingChildren(true);
    try {
      const result = await window.electronAPI.invoke('meta-agent:list-spawned-sessions', sessionId, workspacePath);
      if (result?.success && Array.isArray(result.sessions)) {
        setChildSessions(result.sessions);
      }
    } catch (error) {
      console.error('[MetaAgentMode] Failed to refresh spawned sessions:', error);
    } finally {
      setLoadingChildren(false);
    }
  }, [workspacePath]);

  // When an external sessionId is provided, sync it; otherwise find/create one
  useEffect(() => {
    if (externalSessionId) {
      setMetaSessionId(externalSessionId);
      setLoadingSession(false);
      return;
    }
    void ensureMetaSession();
  }, [externalSessionId, ensureMetaSession]);

  useEffect(() => {
    if (!metaSessionId) {
      setChildSessions([]);
      return;
    }
    void refreshSpawnedSessions(metaSessionId);
  }, [metaSessionId, refreshSpawnedSessions]);

  useEffect(() => {
    if (!metaSessionId) return;

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const debouncedRefresh = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        void refreshSpawnedSessions(metaSessionId);
      }, 300);
    };

    const unsubscribe = store.sub(sessionRegistryAtom, debouncedRefresh);

    // Also re-fetch when any session reaches a terminal state. A child's status
    // change (running -> idle on completion) does not reliably rebuild
    // sessionRegistryAtom - e.g. a worktree-resident child that is not part of the
    // main session list - so the registry subscription alone left the delegated
    // count stuck on "running" and the "Waiting for N sessions" text pinned until
    // the user clicked the child. Terminal events are the authoritative signal and
    // (preload keys listeners by callback) coexist with the central listener.
    const handleSessionEvent = (event: { type?: string }) => {
      if (
        event?.type === 'session:completed' ||
        event?.type === 'session:error' ||
        event?.type === 'session:interrupted'
      ) {
        debouncedRefresh();
      }
    };
    window.electronAPI?.sessionState?.onStateChange?.(handleSessionEvent);

    return () => {
      unsubscribe();
      window.electronAPI?.sessionState?.removeStateChangeListener?.(handleSessionEvent);
      if (debounceTimer) clearTimeout(debounceTimer);
    };
  }, [metaSessionId, refreshSpawnedSessions]);

  const summary = useMemo(() => {
    const waitingCount = childSessions.filter((session) => session.status === 'waiting_for_input').length;
    const runningCount = childSessions.filter((session) => session.status === 'running').length;
    return {
      total: childSessions.length,
      waitingCount,
      runningCount,
    };
  }, [childSessions]);

  const activeChildSessionTeammates = useMemo(
    () =>
      childSessions
        .filter((session) => session.status === 'running')
        .map((session) => ({
          agentId: session.sessionId,
          status: 'running' as const,
        })),
    [childSessions]
  );

  const timeline = useMemo(() => {
    if (childSessions.length === 0) {
      return {
        windows: [] as TimelineWindow[],
        ticks: [] as Array<{ label: string; leftPct: number }>,
        peakConcurrency: 0,
        spanLabel: '',
      };
    }

    const now = Date.now();
    const rawWindows = childSessions
      .map((session) => {
        const startedAt = session.createdAt;
        const endedAt = Math.max(
          startedAt,
          session.lastActivity ?? 0,
          session.updatedAt ?? 0,
          session.status === 'running' ? now : 0
        );

        return {
          sessionId: session.sessionId,
          title: session.title,
          status: session.status,
          startedAt,
          endedAt,
          durationMs: endedAt - startedAt,
        };
      })
      .sort((a, b) => a.startedAt - b.startedAt);

    const minStart = Math.min(...rawWindows.map((window) => window.startedAt));
    const maxEnd = Math.max(...rawWindows.map((window) => window.endedAt));
    const totalSpan = Math.max(maxEnd - minStart, 60000);

    const windows = rawWindows.map((window) => {
      const leftPct = ((window.startedAt - minStart) / totalSpan) * 100;
      const widthPct = Math.max(((window.endedAt - window.startedAt) / totalSpan) * 100, 2);

      return {
        ...window,
        leftPct,
        widthPct,
      };
    });

    const concurrencyEvents = rawWindows.flatMap((window) => [
      { at: window.startedAt, delta: 1 },
      { at: window.endedAt, delta: -1 },
    ]);
    concurrencyEvents.sort((a, b) => {
      if (a.at !== b.at) return a.at - b.at;
      return b.delta - a.delta;
    });

    let currentConcurrency = 0;
    let peakConcurrency = 0;
    for (const event of concurrencyEvents) {
      currentConcurrency += event.delta;
      peakConcurrency = Math.max(peakConcurrency, currentConcurrency);
    }

    const tickCount = Math.min(6, Math.max(2, windows.length + 1));
    const ticks = Array.from({ length: tickCount }, (_, index) => {
      const ratio = tickCount === 1 ? 0 : index / (tickCount - 1);
      const timestamp = minStart + totalSpan * ratio;
      return {
        label: formatAbsoluteTime(timestamp),
        leftPct: ratio * 100,
      };
    });

    return {
      windows,
      ticks,
      peakConcurrency,
      spanLabel: `${formatAbsoluteTime(minStart)} - ${formatAbsoluteTime(maxEnd)}`,
    };
  }, [childSessions]);

  if (loadingSession) {
    return <div className="meta-agent-mode flex-1 flex items-center justify-center text-nim-muted">Loading meta-agent session...</div>;
  }

  if (!metaSessionId) {
    return <div className="meta-agent-mode flex-1 flex items-center justify-center text-nim-muted">Unable to initialize meta-agent mode.</div>;
  }

  return (
    <div className="meta-agent-mode relative flex-1 flex min-h-0" data-testid="meta-agent-mode">
      <div className="flex flex-col flex-1 min-w-0 min-h-0 overflow-hidden border-r border-nim">
        <SessionTranscript
          sessionId={metaSessionId}
          workspacePath={workspacePath}
          mode="agent"
          hideSidebar={true}
          additionalTeammates={activeChildSessionTeammates}
          waitingForNoun="session"
        />
      </div>

      <aside className="w-[360px] max-w-[420px] min-w-[320px] flex flex-col min-h-0 bg-[var(--nim-bg-secondary)]" data-testid="meta-agent-dashboard">
        <div className="px-4 py-4 border-b border-nim">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-[var(--nim-text)]">Delegated Sessions</h2>
              <p className="text-xs text-[var(--nim-text-muted)]">Child sessions created by this meta-agent.</p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="nim-btn-secondary text-xs px-2.5 py-1 rounded disabled:opacity-50"
                onClick={() => setShowTimeline(true)}
                disabled={childSessions.length === 0}
                data-testid="meta-agent-open-timeline"
              >
                Timeline
              </button>
              <button
                type="button"
                className="nim-btn-secondary text-xs px-2.5 py-1 rounded"
                onClick={() => void handleClearMetaSession()}
                data-testid="meta-agent-clear"
              >
                Clear
              </button>
              <button
                type="button"
                className="nim-btn-secondary text-xs px-2.5 py-1 rounded"
                onClick={() => void refreshSpawnedSessions(metaSessionId)}
                data-testid="meta-agent-refresh"
              >
                Refresh
              </button>
            </div>
          </div>
          <div className="mt-3 flex gap-2 text-xs">
            <span className="px-2 py-1 rounded-full bg-[var(--nim-bg-tertiary)] text-[var(--nim-text-muted)]">
              {summary.total} total
            </span>
            <span className="px-2 py-1 rounded-full bg-[rgba(59,130,246,0.12)] text-[var(--nim-primary)]">
              {summary.runningCount} running
            </span>
            <span className="px-2 py-1 rounded-full bg-[rgba(245,158,11,0.16)] text-[var(--nim-warning)]">
              {summary.waitingCount} waiting
            </span>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-3">
          {loadingChildren && childSessions.length === 0 ? (
            <div className="text-sm text-[var(--nim-text-muted)] px-2 py-4">Loading child sessions...</div>
          ) : childSessions.length === 0 ? (
            <div className="border border-dashed border-nim rounded-lg p-4 text-sm text-[var(--nim-text-muted)]" data-testid="meta-agent-empty-state">
              No delegated sessions yet. The meta-agent will populate this dashboard as it spawns child sessions.
            </div>
          ) : (
            childSessions.map((session) => (
              <section
                key={session.sessionId}
                className="rounded-xl border border-nim bg-[var(--nim-bg)] p-3 shadow-sm"
                data-testid="meta-agent-child-card"
                data-session-id={session.sessionId}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-[var(--nim-text)] truncate">{session.title}</div>
                    <div className="mt-1 flex items-center gap-2 text-[11px] text-[var(--nim-text-faint)]">
                      <span>{session.provider}</span>
                      {session.model && <span>{session.model}</span>}
                    </div>
                  </div>
                  <span className={`shrink-0 rounded-full px-2 py-1 text-[11px] font-medium ${getStatusTone(session.status)}`}>
                    {session.status}
                  </span>
                </div>

                <div className="mt-3 space-y-2 text-xs text-[var(--nim-text-muted)]">
                  <div className="flex items-center gap-1">
                    <MaterialSymbol icon="schedule" size={14} />
                    <span>Last activity {session.lastActivity ? getRelativeTimeString(session.lastActivity) : 'No activity yet'}</span>
                  </div>
                  {session.originalPrompt && (
                    <p className="line-clamp-2">
                      <span className="text-[var(--nim-text-faint)]">Task:</span> {session.originalPrompt}
                    </p>
                  )}
                  {session.lastResponse && (
                    <p className="line-clamp-3">
                      <span className="text-[var(--nim-text-faint)]">Result:</span> {session.lastResponse}
                    </p>
                  )}
                  {session.pendingPrompt && (
                    <div className="rounded-lg bg-[rgba(245,158,11,0.10)] px-2 py-2 text-[var(--nim-warning)]">
                      Waiting for {session.pendingPrompt.promptType}
                    </div>
                  )}
                  {session.editedFiles.length > 0 && (
                    <p className="line-clamp-2">
                      <span className="text-[var(--nim-text-faint)]">Edited:</span> {session.editedFiles.join(', ')}
                    </p>
                  )}
                </div>

                <div className="mt-3 flex justify-end">
                  <button
                    type="button"
                    className="nim-btn-secondary text-xs px-2.5 py-1 rounded"
                    onClick={() => onOpenSessionInAgent?.(session.sessionId)}
                    data-testid="meta-agent-open-session"
                  >
                    Open In Agent
                  </button>
                </div>
              </section>
            ))
          )}
        </div>
      </aside>

      {showTimeline && (
        <div className="absolute inset-4 z-20 flex flex-col rounded-2xl border border-nim bg-[var(--nim-bg)] shadow-2xl" data-testid="meta-agent-gantt-view">
          <div className="flex items-center justify-between gap-4 border-b border-nim px-5 py-3">
            <div className="flex items-center gap-3 text-xs">
              <h3 className="text-sm font-semibold text-[var(--nim-text)]">Timeline</h3>
              <span className="text-[var(--nim-text-muted)]">
                {timeline.windows.length} sessions
              </span>
              <span className="text-[var(--nim-primary)]" data-testid="meta-agent-gantt-peak">
                Peak {timeline.peakConcurrency}x
              </span>
              {timeline.spanLabel && (
                <span className="text-[var(--nim-text-faint)]">
                  {timeline.spanLabel}
                </span>
              )}
              <TimelineAggregateSummary sessionIds={timeline.windows.map((w) => w.sessionId)} />
            </div>
            <button
              type="button"
              className="nim-btn-secondary text-xs px-2.5 py-1 rounded"
              onClick={() => setShowTimeline(false)}
              data-testid="meta-agent-close-timeline"
            >
              Close
            </button>
          </div>

          <div className="flex-1 overflow-auto px-5 py-4">
            {timeline.windows.length === 0 ? (
              <div className="rounded-lg border border-dashed border-nim px-4 py-6 text-sm text-[var(--nim-text-muted)]">
                No delegated sessions yet.
              </div>
            ) : (
              <div className="min-w-[720px]">
                <div className="grid grid-cols-[220px_minmax(420px,1fr)] items-end gap-3 pb-2">
                  <div className="text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--nim-text-faint)]">
                    Session
                  </div>
                  <div className="relative h-5">
                    {timeline.ticks.map((tick) => (
                      <div
                        key={tick.label}
                        className="absolute bottom-0"
                        style={{ left: `${tick.leftPct}%` }}
                      >
                        <div className="h-2 w-px bg-[var(--nim-border)] opacity-60" />
                        <span className="absolute bottom-2.5 -translate-x-1/2 whitespace-nowrap text-[10px] text-[var(--nim-text-faint)]">
                          {tick.label}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="space-y-1">
                  {timeline.windows.map((window) => (
                    <div
                      key={window.sessionId}
                      className="grid grid-cols-[220px_minmax(420px,1fr)] gap-3 rounded-lg py-1.5 px-1"
                      data-testid="meta-agent-gantt-row"
                    >
                      <TimelineRowLabel window={window} />

                      <div className="relative flex items-center min-h-[52px]">
                        {timeline.ticks.map((tick) => (
                          <div
                            key={`${window.sessionId}-${tick.label}`}
                            className="absolute top-0 h-2"
                            style={{ left: `${tick.leftPct}%` }}
                          >
                            <div className="h-full w-px bg-[var(--nim-border)] opacity-30" />
                          </div>
                        ))}
                        <div
                          className={`absolute h-7 rounded-md px-2 shadow-sm ${getBarTone(window.status)}`}
                          style={{
                            left: `${window.leftPct}%`,
                            width: `${window.widthPct}%`,
                          }}
                          data-testid="meta-agent-gantt-bar"
                        >
                          <div className="truncate pt-1 text-[11px] font-medium text-[var(--nim-text)]">
                            {formatDuration(window.durationMs)}
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
