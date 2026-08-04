/**
 * McpSessionStatusChip — in-session MCP visibility (NIM-2272 / GH #1089).
 *
 * When an MCP server blips mid-session the session marks its tools unavailable
 * and never re-registers them, and from inside the session that is completely
 * invisible: a missing tool looks the same whether the cause is auth, a config
 * mismatch, or a server class the app never loaded. This chip answers "what
 * does this session actually have right now" without killing the session.
 *
 * Read-only. Reconnect and re-auth are Slice 2 and are deliberately absent.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import {
  FloatingPortal,
  autoUpdate,
  flip,
  offset,
  shift,
  useClick,
  useDismiss,
  useFloating,
  useInteractions,
  useRole,
} from '@floating-ui/react';
import { windowControlsClearance } from '@nimbalyst/runtime/ui/floating/windowControlsClearance';
import type {
  McpSessionServerRow,
  McpSessionStatusSnapshot,
} from '@nimbalyst/runtime/types/MCPServerConfig';
import { groupMcpSessionServers, mcpSessionStatusAtomFamily } from '../../store/atoms/mcpStatus';
import { sessionStoreAtom } from '../../store/atoms/sessions';
import { settingAtom } from '../../store/atoms/settingAtomFamily';

interface McpSessionStatusChipProps {
  sessionId: string;
  provider: string;
}

/** Providers whose sessions can report MCP status. Mirrors the main-process set. */
const MCP_STATUS_PROVIDERS = new Set(['claude-code']);

function formatRelativeTime(timestamp: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

function rowDetail(row: McpSessionServerRow): string {
  switch (row.state) {
    case 'absent':
      return 'Configured but never reached this session';
    case 'needs-auth':
      return 'Needs authorization';
    case 'pending':
      return row.error ? `Connecting - ${row.error}` : 'Connecting';
    case 'disabled':
      return 'Disabled';
    case 'failed':
      return row.error ? `Failed - ${row.error}` : 'Failed';
    default:
      return row.toolCount === undefined
        ? 'Connected'
        : `${row.toolCount} ${row.toolCount === 1 ? 'tool' : 'tools'}`;
  }
}

const DOT_CLASS: Record<McpSessionServerRow['state'], string> = {
  connected: 'bg-green-500',
  failed: 'bg-red-500',
  absent: 'bg-red-500',
  'needs-auth': 'bg-amber-500',
  pending: 'bg-amber-500',
  disabled: 'bg-[var(--nim-text-faint)]',
};

function ServerRow({ row }: { row: McpSessionServerRow }) {
  const isError = row.state === 'failed' || row.state === 'absent';
  const isWarn = row.state === 'needs-auth' || row.state === 'pending';
  return (
    <div className="mcp-session-status-row flex items-start gap-2 px-3 py-1.5">
      <span className={`mcp-session-status-row-dot mt-1.5 shrink-0 w-1.5 h-1.5 rounded-full ${DOT_CLASS[row.state]}`} />
      <div className="mcp-session-status-row-body min-w-0 flex-1">
        <div className="mcp-session-status-row-top flex items-baseline gap-2">
          <span className="mcp-session-status-row-name text-xs font-medium text-[var(--nim-text)] truncate">{row.name}</span>
          {row.scope && (
            <span className="mcp-session-status-row-scope text-[0.625rem] uppercase tracking-wide text-[var(--nim-text-faint)]">{row.scope}</span>
          )}
        </div>
        <div
          className={
            isError
              ? 'mcp-session-status-row-detail text-[0.6875rem] text-red-500'
              : isWarn
                ? 'mcp-session-status-row-detail text-[0.6875rem] text-amber-500'
                : 'mcp-session-status-row-detail text-[0.6875rem] text-[var(--nim-text-muted)]'
          }
        >
          {rowDetail(row)}
        </div>
      </div>
    </div>
  );
}

export function McpSessionStatusChip({ sessionId, provider }: McpSessionStatusChipProps) {
  const supported = MCP_STATUS_PROVIDERS.has(provider);
  const status = useAtomValue(mcpSessionStatusAtomFamily(sessionId));
  const setStatus = useSetAtom(mcpSessionStatusAtomFamily(sessionId));
  const [open, setOpen] = useState(false);

  const refresh = useCallback(async () => {
    if (!supported) return;
    const api = (window as any).electronAPI;
    if (!api?.aiGetMcpSessionStatus) return;
    try {
      const next: McpSessionStatusSnapshot = await api.aiGetMcpSessionStatus(sessionId, provider);
      if (next?.sessionId) setStatus(next);
    } catch {
      // A pull failure leaves whatever the push path last delivered in place;
      // showing a stale-but-real list beats blanking the surface.
    }
  }, [supported, sessionId, provider, setStatus]);

  // Pull on mount: no push listener exists until a message has been sent, so
  // this is the only path that populates a session the user just opened.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const floating = useFloating({
    open,
    onOpenChange: setOpen,
    placement: 'bottom-end',
    whileElementsMounted: autoUpdate,
    middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 }), windowControlsClearance()],
  });
  const click = useClick(floating.context);
  const dismiss = useDismiss(floating.context);
  const role = useRole(floating.context, { role: 'dialog' });
  const { getReferenceProps, getFloatingProps } = useInteractions([click, dismiss, role]);

  const groups = useMemo(
    () => groupMcpSessionServers(status?.servers ?? []),
    [status?.servers],
  );

  // Re-pull when the popover opens so "refreshed Ns ago" reflects the provider's
  // real last poll. The push event only fires on transitions, by design.
  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  // Hidden, not empty, for providers with no MCP status support — an empty list
  // on a Codex session would read as "this session has no MCP servers".
  if (!supported) return null;
  // Nothing known yet, or a session that has not run a turn. Rendering a "0
  // servers" chip here would be a claim we can't back.
  if (!status || !status.active) return null;

  const total = status.servers.length;
  if (total === 0) return null;

  const problemCount = groups.problem.length + groups.absent.length;
  const hasAbsent = groups.absent.length > 0;
  const hasFailure = hasAbsent || groups.problem.some((s) => s.state === 'failed');

  const chipClass = problemCount === 0
    ? 'border-[var(--nim-border)] text-[var(--nim-text-muted)]'
    : hasFailure
      ? 'border-red-500/45 bg-red-500/10 text-red-500'
      : 'border-amber-500/45 bg-amber-500/10 text-amber-500';
  const chipDot = problemCount === 0
    ? 'bg-green-500'
    : hasFailure
      ? 'bg-red-500'
      : 'bg-amber-500';
  const chipLabel = problemCount === 0
    ? `MCP ${total}`
    : `MCP ${groups.connected.length}/${total}`;

  return (
    <>
      <button
        ref={floating.refs.setReference}
        {...getReferenceProps()}
        className={`mcp-session-status-chip shrink-0 inline-flex items-center gap-1.5 h-6 px-2 rounded-full border text-[0.6875rem] font-medium bg-transparent cursor-pointer transition-colors duration-150 hover:bg-[var(--nim-bg-hover)] ${chipClass}`}
        title="MCP servers for this session"
        data-testid="mcp-session-status-chip"
      >
        <span className={`mcp-session-status-chip-dot w-1.5 h-1.5 rounded-full ${chipDot}`} />
        {chipLabel}
      </button>

      {open && (
        <FloatingPortal>
          <div
            ref={floating.refs.setFloating}
            style={floating.floatingStyles}
            {...getFloatingProps()}
            className="mcp-session-status-popover z-50 w-80 max-h-96 overflow-y-auto rounded-lg border border-[var(--nim-border)] bg-[var(--nim-bg-elevated,var(--nim-bg))] shadow-lg py-1"
            data-testid="mcp-session-status-popover"
          >
            <div className="mcp-session-status-popover-head flex items-baseline justify-between px-3 py-1.5">
              <span className="mcp-session-status-popover-title text-xs font-semibold text-[var(--nim-text)]">MCP servers</span>
              <span className="mcp-session-status-popover-sub text-[0.625rem] text-[var(--nim-text-faint)]">
                {status.lastCheckedAt === null
                  ? 'not checked yet'
                  : `refreshed ${formatRelativeTime(status.lastCheckedAt)}`}
              </span>
            </div>

            {problemCount > 0 && (
              <>
                <div className="mcp-session-status-section-label px-3 pt-1 pb-0.5 text-[0.625rem] uppercase tracking-wide text-[var(--nim-text-faint)]">
                  Not available
                </div>
                {groups.absent.map((row) => <ServerRow key={row.name} row={row} />)}
                {groups.problem.map((row) => <ServerRow key={row.name} row={row} />)}
              </>
            )}

            {groups.connected.length > 0 && (
              <>
                <div className="mcp-session-status-section-label px-3 pt-1 pb-0.5 text-[0.625rem] uppercase tracking-wide text-[var(--nim-text-faint)]">
                  Connected
                </div>
                {groups.connected.map((row) => <ServerRow key={row.name} row={row} />)}
              </>
            )}

            {/* The comparison set is what Nimbalyst passed to the SDK, not the
                full universe of configured servers — a server the CLI reads
                from its own settings can be healthy and still not listed. Say
                so rather than implying the list is exhaustive. */}
            <div className="mcp-session-status-popover-foot mt-1 px-3 py-2 border-t border-[var(--nim-border)] text-[0.625rem] leading-snug text-[var(--nim-text-faint)]">
              Reflects the servers Nimbalyst passed to this session. Servers the CLI reads from its own settings may not appear here.
            </div>
          </div>
        </FloatingPortal>
      )}
    </>
  );
}

/**
 * Chip for whichever session the workstream header is currently showing.
 *
 * Off by default; turned on with "Show MCP Server Status" in Settings ->
 * Agent Features.
 *
 * The provider is resolved here rather than threaded through the header, so
 * the header stays unaware of MCP entirely. A workstream can hold sessions on
 * different providers, so the chip has to follow the active one — a Codex tab
 * must not inherit the claude-code tab's server list.
 *
 * The setting is checked before the inner chip mounts, so turning it off also
 * skips the status pull rather than merely hiding its result.
 */
export function ActiveSessionMcpStatusChip({ sessionId }: { sessionId: string }) {
  const enabled = useAtomValue(settingAtom('ai.showMcpSessionStatus')) as boolean;
  const session = useAtomValue(sessionStoreAtom(sessionId));
  const provider = session?.provider;
  if (!enabled || !provider) return null;
  return <McpSessionStatusChip sessionId={sessionId} provider={provider} />;
}
