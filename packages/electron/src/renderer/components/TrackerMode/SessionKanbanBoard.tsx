/**
 * SessionKanbanBoard - Kanban board view for AI sessions organized by phase.
 *
 * Cards represent standalone sessions, workstreams, or worktrees.
 * Columns represent development phases: Backlog, Planning, Implementing, Validating, Complete.
 * Phase is stored in metadata.phase on each session.
 *
 * Keyboard navigation:
 *   Arrow Up/Down  - move focus between cards within a column
 *   Arrow Left/Right - move focus between columns
 *   Enter          - open the focused session in agent mode
 *   Space          - toggle transcript peek on the focused card
 *   Cmd+Right/Left - move selected card(s) to the next/previous phase column
 *   Cmd+A          - select all visible cards
 *   Escape         - close peek / clear selection / clear focus
 *
 * Multi-select:
 *   Click          - select single card (clears previous selection)
 *   Cmd+Click      - toggle card in/out of selection
 *   Shift+Click    - select range from last-clicked to this card
 *   Drag selected  - moves all selected cards to target column
 *
 * Collapsible columns:
 *   Any phase column can be collapsed to a thin vertical strip.
 *   Collapsed columns still accept drag-and-drop.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAtomValue, useSetAtom } from 'jotai';
import { usePostHog } from 'posthog-js/react';
import { MaterialSymbol, ProviderIcon } from '@nimbalyst/runtime';
import { RichTranscriptView } from '@nimbalyst/runtime/ui/AgentTranscript/components/RichTranscriptView';
import type { SessionMeta } from '@nimbalyst/runtime';
import type { TranscriptViewMessage } from '@nimbalyst/runtime/ai/server/types';
import {
  sessionsByPhaseAtom,
  sessionKanbanFilterAtom,
  sessionKanbanTotalCountAtom,
  sessionKanbanTagsAtom,
  setSessionPhaseAtom,
  childRunStatesAtom,
  getCardType,
  SESSION_PHASE_COLUMNS,
  type SessionPhase,
  type SessionPhaseKey,
  type KanbanCardType,
} from '../../store/atoms/sessionKanban';
import {
  updateSessionStoreAtom,
  removeSessionFullAtom,
  sessionRegistryAtom,
  sessionListWorkspaceAtom,
  sessionIndicatorStateAtom,
  groupIndicatorStateAtom,
} from '../../store/atoms/sessions';
import { transcriptEventSignalAtom } from '../../store/atoms/sessionTranscript';
import { SessionContextMenu } from '../AgenticCoding/SessionContextMenu';
import { ArchiveWorktreeDialog } from '../AgentMode/ArchiveWorktreeDialog';
import { useArchiveWorktreeDialog } from '../../hooks/useArchiveWorktreeDialog';
import { useFloatingMenu, FloatingPortal, virtualElement } from '../../hooks/useFloatingMenu';
import { GroupOperationalIndicator, SessionOperationalIndicator } from '../AgenticCoding/SessionOperationalIndicator';
import type { SessionIndicatorState } from '@nimbalyst/runtime';

// ============================================================
// Keyboard Navigation Types
// ============================================================

/** A position in the board grid: which column and which card index */
interface BoardPosition {
  columnKey: SessionPhaseKey;
  cardIndex: number;
}

/** All column keys in display order (unphased first, then phase columns) */
const ALL_COLUMN_KEYS: SessionPhaseKey[] = [
  'unphased',
  ...SESSION_PHASE_COLUMNS.map(c => c.value),
];

// ============================================================
// ChildRunStateBar
// ============================================================

const RUN_STATE_SEGMENTS = [
  { key: 'running' as const, label: 'running', color: '#60a5fa' },
  { key: 'waiting' as const, label: 'waiting', color: '#f97316' },
  { key: 'review' as const, label: 'review', color: '#a78bfa' },
  { key: 'idle' as const, label: 'idle', color: '#666666' },
  { key: 'done' as const, label: 'done', color: '#4ade80' },
];

function ChildRunStateBar({ sessionId }: { sessionId: string }) {
  const summary = useAtomValue(childRunStatesAtom(sessionId));

  if (summary.total === 0) return null;

  const active = RUN_STATE_SEGMENTS.filter(s => summary[s.key] > 0);
  if (active.length === 0) return null;

  return (
    <div className="flex items-center gap-2 py-0.5">
      {active.map(s => (
        <div key={s.key} className="flex items-center gap-0.5">
          <div
            className="w-[5px] h-[5px] rounded-full shrink-0"
            style={{ background: s.color }}
          />
          <span className="text-[9px] whitespace-nowrap" style={{ color: s.color }}>
            {summary[s.key]} {s.label}
          </span>
        </div>
      ))}
    </div>
  );
}

// ============================================================
// Card Type Icon (inline, matches session history list icons)
// ============================================================

function CardTypeIcon({ type, provider }: { type: KanbanCardType; provider?: string }) {
  if (type === 'worktree') {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" className="shrink-0 mt-px text-[#a78bfa]">
        <rect x="3" y="2" width="3" height="3" rx="0.5" stroke="currentColor" strokeWidth="1.5" fill="none"/>
        <rect x="10" y="2" width="3" height="3" rx="0.5" stroke="currentColor" strokeWidth="1.5" fill="none"/>
        <rect x="3" y="11" width="3" height="3" rx="0.5" stroke="currentColor" strokeWidth="1.5" fill="none"/>
        <path d="M4.5 5v3.5a1.5 1.5 0 0 0 1.5 1.5h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
        <path d="M11.5 5v5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
      </svg>
    );
  }
  if (type === 'workstream') {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" className="shrink-0 mt-px text-[#60a5fa]">
        <circle cx="8" cy="4" r="1.5" fill="currentColor"/>
        <circle cx="4" cy="12" r="1.5" fill="currentColor"/>
        <circle cx="12" cy="12" r="1.5" fill="currentColor"/>
        <line x1="7.5" y1="5.2" x2="4.5" y2="10.8" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
        <line x1="8.5" y1="5.2" x2="11.5" y2="10.8" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
      </svg>
    );
  }
  // Regular session: show provider icon
  return (
    <span className="shrink-0 mt-px flex items-center text-nim-muted">
      <ProviderIcon provider={provider || 'claude'} size={14} />
    </span>
  );
}

// ============================================================
// Card Visual State
// ============================================================

function getCardStateStyle(kind: SessionIndicatorState['kind']): { bg: string; border: string } {
  if (kind === 'working-self' || kind === 'working-child' || kind === 'queued') {
    return { bg: 'rgba(59, 130, 246, 0.06)', border: 'rgba(59, 130, 246, 0.25)' };
  }
  if (kind === 'needs-input' || kind === 'wakeup-attention') {
    return { bg: 'rgba(245, 158, 11, 0.06)', border: 'rgba(245, 158, 11, 0.25)' };
  }
  if (kind === 'error') {
    return { bg: 'rgba(239, 68, 68, 0.05)', border: 'rgba(239, 68, 68, 0.25)' };
  }
  if (kind === 'ready') {
    return { bg: 'rgba(245, 158, 11, 0.04)', border: 'rgba(245, 158, 11, 0.18)' };
  }
  return { bg: 'transparent', border: '' };
}

// ============================================================
// TranscriptPeek - Hover preview using real RichTranscriptView
// ============================================================

/** Global cache for fetched tail messages to avoid refetching on re-hover.
 * Entries are invalidated by the open peek when transcriptEventSignalAtom
 * bumps for the active session; if no peek is open, the next mount-time fetch
 * overwrites whatever is cached, so a stale entry can't be observed. */
const tailMessageCache = new Map<string, TranscriptViewMessage[]>();

const PEEK_SETTINGS = {
  showToolCalls: true,
  compactMode: true,
  collapseTools: true,
  showThinking: false,
  showSessionInit: false,
};

interface TranscriptPeekProps {
  sessionId: string;
  anchorRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
}

function TranscriptPeek({ sessionId, anchorRef, onClose }: TranscriptPeekProps) {
  // Workstream/worktree cards have no transcript of their own. Show the most
  // recently updated child session's transcript so the peek isn't blank.
  const registry = useAtomValue(sessionRegistryAtom);
  const resolvedSessionId = useMemo(() => {
    const meta = registry.get(sessionId);
    if (!meta) return sessionId;
    if (getCardType(meta) === 'session') return sessionId;

    let bestId = sessionId;
    let bestUpdatedAt = -Infinity;
    for (const child of registry.values()) {
      if (child.parentSessionId !== sessionId) continue;
      const ts = child.updatedAt ?? 0;
      if (ts > bestUpdatedAt) {
        bestUpdatedAt = ts;
        bestId = child.id;
      }
    }
    return bestId;
  }, [registry, sessionId]);

  const [messages, setMessages] = useState<TranscriptViewMessage[] | null>(tailMessageCache.get(resolvedSessionId) || null);
  const [loading, setLoading] = useState(!tailMessageCache.has(resolvedSessionId));
  const peekRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  // Always refetch on mount so the peek reflects the latest turn. The cache
  // still seeds initial state for an instant render; the fresh fetch
  // overwrites it. Fetch a generous tail because the projector coalesces
  // adjacent assistant_message events, and legacy codex-acp sessions stored
  // one canonical event per streaming token before the writer started
  // coalescing -- a small tail would only show the last few tokens of those
  // sessions.
  const fetchMessages = useCallback((id: string) => {
    let cancelled = false;
    window.electronAPI.ai
      .getTailMessages(id, 100)
      .then((msgs: TranscriptViewMessage[]) => {
        if (!cancelled) {
          tailMessageCache.set(id, msgs);
          setMessages(msgs);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setMessages((prev) => prev ?? []);
          setLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const cached = tailMessageCache.get(resolvedSessionId);
    if (cached) {
      setMessages(cached);
      setLoading(false);
    } else {
      setLoading(true);
    }
    return fetchMessages(resolvedSessionId);
  }, [resolvedSessionId, fetchMessages]);

  // While the peek is open, re-fetch when new transcript events arrive for
  // this session. Debounced to 1.5 s so rapid streaming chunks don't hammer
  // the IPC channel. Drives off transcriptEventSignalAtom (bumped by
  // sessionTranscriptListeners on every transcript:event) instead of
  // subscribing to IPC directly -- per docs/IPC_LISTENERS.md, components must
  // not call window.electronAPI.on inside React lifecycles.
  const transcriptSignal = useAtomValue(transcriptEventSignalAtom(resolvedSessionId));
  const initialTranscriptSignalRef = useRef(transcriptSignal);
  useEffect(() => {
    // Skip the initial mount: we already kicked off a fetch above. Only react
    // to *new* transcript events that arrive while the peek is open.
    if (transcriptSignal === initialTranscriptSignalRef.current) return;
    const debounceTimer = setTimeout(() => {
      tailMessageCache.delete(resolvedSessionId);
      fetchMessages(resolvedSessionId);
    }, 1500);
    return () => clearTimeout(debounceTimer);
  }, [transcriptSignal, resolvedSessionId, fetchMessages]);

  // Position relative to anchor element
  useEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;

    const rect = anchor.getBoundingClientRect();
    const peekHeight = 350;
    const spaceBelow = window.innerHeight - rect.bottom;
    const above = spaceBelow < peekHeight + 10 && rect.top > peekHeight + 10;

    setPosition({
      top: above ? rect.top - peekHeight - 4 : rect.bottom + 4,
      left: Math.min(rect.left, window.innerWidth - 610),
    });
  }, [anchorRef, messages]);

  // Close on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (peekRef.current && !peekRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [onClose]);

  return createPortal(
    <div
      ref={peekRef}
      className="fixed z-[100] w-[600px] h-[350px] bg-nim-secondary border border-nim rounded-lg shadow-2xl overflow-hidden flex flex-col"
      style={{ top: position?.top ?? 0, left: position?.left ?? 0, visibility: position ? 'visible' : 'hidden' }}
      onMouseLeave={onClose}
    >
      {loading ? (
        <div className="flex-1 flex items-center justify-center text-nim-faint">
          <span className="material-symbols-outlined text-sm animate-spin" style={{ fontSize: '16px' }}>progress_activity</span>
        </div>
      ) : messages && messages.length > 0 ? (
        <div className="flex-1 overflow-hidden">
          <RichTranscriptView
            sessionId={resolvedSessionId}
            messages={messages}
            settings={PEEK_SETTINGS}
            persistScrollState={false}
          />
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center text-[11px] text-nim-disabled italic">
          No messages yet
        </div>
      )}
    </div>,
    document.body,
  );
}

// ============================================================
// SessionKanbanCard
// ============================================================

interface SessionKanbanCardProps {
  session: SessionMeta;
  onSelect: (sessionId: string) => void;
  onArchive?: (sessionId: string) => void;
  onRename?: (sessionId: string, newName: string) => void;
  phaseColor: string;
  isFocused?: boolean;
  isSelected?: boolean;
  selectedCount?: number;
  showPeekOverride?: boolean;
  onPeekToggle?: () => void;
}

function SessionKanbanCard({ session, onSelect, onArchive, onRename, phaseColor, isFocused, isSelected, selectedCount = 1, showPeekOverride, onPeekToggle }: SessionKanbanCardProps) {
  const cardType = useMemo(() => getCardType(session), [session]);
  const registry = useAtomValue(sessionRegistryAtom);
  const childIds = useMemo(
    () => Array.from(registry.values())
      .filter((candidate) => candidate.parentSessionId === session.id)
      .map((candidate) => candidate.id)
      .sort(),
    [registry, session.id],
  );
  const groupKey = useMemo(
    () => JSON.stringify({ parentId: session.id, childIds }),
    [session.id, childIds],
  );
  const indicatorState = useAtomValue(
    cardType === 'session'
      ? sessionIndicatorStateAtom(session.id)
      : groupIndicatorStateAtom(groupKey),
  );
  const stateStyle = getCardStateStyle(indicatorState.kind);
  const tags = session.tags || [];
  const cardRef = useRef<HTMLDivElement>(null);
  const [showPeekLocal, setShowPeekLocal] = useState(false);
  const showPeek = showPeekOverride ?? showPeekLocal;
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const peekIconRef = useRef<HTMLSpanElement>(null);

  // Context menu state
  const [showContextMenu, setShowContextMenu] = useState(false);
  const [contextMenuPosition, setContextMenuPosition] = useState({ x: 0, y: 0 });

  // Inline rename state
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenuPosition({ x: e.clientX, y: e.clientY });
    setShowContextMenu(true);
  }, []);

  const handleRenameSubmit = useCallback(() => {
    const trimmedValue = renameValue.trim();
    if (trimmedValue && trimmedValue !== session.title && onRename) {
      onRename(session.id, trimmedValue);
    }
    setIsRenaming(false);
  }, [renameValue, session.title, session.id, onRename]);

  const handleRenameKeyDown = useCallback((e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      handleRenameSubmit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setIsRenaming(false);
    }
  }, [handleRenameSubmit]);

  // Focus and select input when entering rename mode
  useEffect(() => {
    if (isRenaming && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [isRenaming]);

  // Scroll focused card into view
  useEffect(() => {
    if (isFocused && cardRef.current) {
      cardRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [isFocused]);

  // Relative time display
  const timeAgo = useMemo(() => {
    const diff = Date.now() - session.updatedAt;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days === 1) return 'yesterday';
    return `${days}d ago`;
  }, [session.updatedAt]);

  // Cleanup hover timer on unmount
  useEffect(() => {
    return () => {
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    };
  }, []);

  const handlePeekEnter = useCallback(() => {
    hoverTimerRef.current = setTimeout(() => {
      if (onPeekToggle) {
        onPeekToggle();
      } else {
        setShowPeekLocal(true);
      }
    }, 300);
  }, [onPeekToggle]);

  const handlePeekLeave = useCallback(() => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  }, []);

  return (
    <>
      <div
        ref={cardRef}
        className={`w-full text-left p-2.5 rounded-md border transition-colors cursor-default ${
          isFocused
            ? 'border-[var(--nim-primary)] ring-1 ring-[var(--nim-primary)]'
            : isSelected
              ? 'border-[rgba(96,165,250,0.5)] bg-[rgba(96,165,250,0.06)]'
              : stateStyle.border
                ? ''
                : 'border-nim'
        }`}
        style={{
          borderLeftWidth: '3px',
          borderLeftColor: phaseColor,
          backgroundColor: isFocused ? stateStyle.bg || undefined : isSelected ? undefined : stateStyle.bg || undefined,
          borderColor: isFocused ? undefined : isSelected ? undefined : stateStyle.border || undefined,
        }}
        onDoubleClick={() => onSelect(session.id)}
        onContextMenu={handleContextMenu}
        data-testid="session-kanban-card"
        data-session-id={session.id}
      >
        {/* Title row: type/provider icon + title + unread dot */}
        <div className="flex items-start gap-1.5 mb-1.5">
          <CardTypeIcon type={cardType} provider={session.provider} />
          <div className="flex-1 min-w-0">
            {isRenaming ? (
              <input
                ref={renameInputRef}
                type="text"
                className="w-full px-1 py-0.5 text-xs font-medium border border-[var(--nim-primary)] rounded bg-[var(--nim-bg)] text-[var(--nim-text)] outline-none"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={handleRenameKeyDown}
                onBlur={handleRenameSubmit}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <div className="text-xs font-medium text-nim leading-snug line-clamp-2">
                {session.title}
              </div>
            )}
          </div>
          {cardType === 'session' ? (
            <SessionOperationalIndicator sessionId={session.id} variant="dropdown" />
          ) : (
            <GroupOperationalIndicator groupKey={groupKey} variant="dropdown" />
          )}
        </div>

        {/* Child session count (workstream/worktree only) */}
        {cardType !== 'session' && session.childCount > 0 && (
          <div className="flex items-center gap-1 text-[10px] text-nim-faint mb-1">
            <MaterialSymbol icon="chat_bubble_outline" size={12} />
            {session.childCount} session{session.childCount !== 1 ? 's' : ''}
          </div>
        )}

        {/* Child run states (workstream/worktree only) */}
        {cardType !== 'session' && session.childCount > 0 && (
          <div className="mb-1.5">
            <ChildRunStateBar sessionId={session.id} />
          </div>
        )}

        {/* Tags */}
        {tags.length > 0 && (
          <div className="flex gap-1 flex-wrap mb-1.5">
            {tags.slice(0, 4).map(tag => (
              <span
                key={tag}
                className="text-[10px] font-medium px-1.5 py-px rounded bg-white/[0.06] text-nim-muted"
              >
                {tag}
              </span>
            ))}
            {tags.length > 4 && (
              <span className="text-[10px] text-nim-faint">+{tags.length - 4}</span>
            )}
          </div>
        )}

        {/* Footer: uncommitted + peek + time */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            {session.uncommittedCount > 0 && (
              <span className="flex items-center gap-0.5 text-[10px] text-nim-faint" title={`${session.uncommittedCount} uncommitted file${session.uncommittedCount !== 1 ? 's' : ''}`}>
                <MaterialSymbol icon="edit_note" size={12} />
                {session.uncommittedCount}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <span
              ref={peekIconRef}
              className="w-4 h-4 rounded flex items-center justify-center text-nim-disabled hover:text-nim-muted transition-colors"
              title="Preview transcript"
              data-testid="session-kanban-peek"
              onMouseEnter={handlePeekEnter}
              onMouseLeave={handlePeekLeave}
              onClick={(e) => {
                e.stopPropagation();
                if (onPeekToggle) {
                  onPeekToggle();
                } else {
                  setShowPeekLocal(prev => !prev);
                }
              }}
            >
              <MaterialSymbol icon="chat_bubble_outline" size={12} />
            </span>
            <span className="text-[10px] text-nim-disabled">{timeAgo}</span>
          </div>
        </div>
      </div>

      {/* Transcript peek popup */}
      {showPeek && (
        <TranscriptPeek
          sessionId={session.id}
          anchorRef={cardRef}
          onClose={() => {
            if (onPeekToggle) {
              onPeekToggle();
            } else {
              setShowPeekLocal(false);
            }
          }}
        />
      )}

      {/* Context Menu - portaled to escape opacity-65 on Complete column */}
      {showContextMenu && createPortal(
        <SessionContextMenu
          sessionId={session.id}
          title={session.title}
          position={contextMenuPosition}
          onClose={() => setShowContextMenu(false)}
          isArchived={session.isArchived}
          isWorkstream={cardType === 'workstream'}
          isWorktreeSession={cardType === 'worktree'}
          phase={session.phase}
          onRename={onRename ? () => { setRenameValue(session.title); setIsRenaming(true); } : undefined}
          onArchive={onArchive ? () => onArchive(session.id) : undefined}
          selectedCount={isSelected ? selectedCount : 1}
        />,
        document.body,
      )}
    </>
  );
}

// ============================================================
// SessionKanbanColumn
// ============================================================

interface SessionKanbanColumnProps {
  phase: SessionPhase;
  label: string;
  color: string;
  sessions: SessionMeta[];
  onSelect: (sessionId: string) => void;
  onArchive?: (sessionId: string) => void;
  onRename?: (sessionId: string, newName: string) => void;
  onDrop: (sessionIds: string[], phase: SessionPhase) => void;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  focusedCardId: string | null;
  selectedIds: Set<string>;
  peekCardId: string | null;
  onCardClick: (sessionId: string, e: React.MouseEvent) => void;
  onPeekToggle: (sessionId: string) => void;
  onDragStart: (sessionId: string) => string[];
  onSelectAll: (sessionIds: string[]) => void;
  onHeaderContextMenu: (e: React.MouseEvent, phase: SessionPhaseKey, sessionIds: string[]) => void;
}

function SessionKanbanColumn({ phase, label, color, sessions, onSelect, onArchive, onRename, onDrop, isCollapsed, onToggleCollapse, focusedCardId, selectedIds, peekCardId, onCardClick, onPeekToggle, onDragStart: onDragStartProp, onSelectAll, onHeaderContextMenu }: SessionKanbanColumnProps) {
  const [isDragOver, setIsDragOver] = useState(false);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const raw = e.dataTransfer.getData('text/session-ids');
    if (raw) {
      try {
        const ids: string[] = JSON.parse(raw);
        if (ids.length > 0) onDrop(ids, phase);
      } catch { /* ignore malformed */ }
    }
  }, [onDrop, phase]);

  const handleDragStart = useCallback((e: React.DragEvent, sessionId: string) => {
    const ids = onDragStartProp(sessionId);
    e.dataTransfer.setData('text/session-ids', JSON.stringify(ids));
    e.dataTransfer.effectAllowed = 'move';
    // Custom drag image showing count
    if (ids.length > 1) {
      const badge = document.createElement('div');
      badge.textContent = `${ids.length} sessions`;
      badge.style.cssText = 'position:fixed;left:-1000px;top:-1000px;padding:4px 10px;border-radius:6px;background:#60a5fa;color:#fff;font-size:12px;font-weight:600;white-space:nowrap;';
      document.body.appendChild(badge);
      e.dataTransfer.setDragImage(badge, badge.offsetWidth / 2, badge.offsetHeight / 2);
      requestAnimationFrame(() => document.body.removeChild(badge));
    }
  }, [onDragStartProp]);

  const isComplete = phase === 'complete';

  // Collapsed: thin vertical strip (still accepts drag-drop)
  if (isCollapsed) {
    return (
      <div
        className={`session-kanban-column flex flex-col w-10 shrink-0 rounded-lg bg-nim-secondary cursor-pointer transition-colors ${
          isDragOver ? 'bg-[rgba(96,165,250,0.08)] outline outline-2 outline-dashed outline-[rgba(96,165,250,0.3)] -outline-offset-2' : ''
        }`}
        data-testid="session-kanban-column"
        data-phase={phase}
        onClick={onToggleCollapse}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <div className="flex flex-col items-center gap-1 py-3">
          <span
            className="w-2 h-2 rounded-full shrink-0"
            style={{ backgroundColor: color }}
          />
          <span className="text-[10px] font-semibold text-nim-faint">
            {sessions.length}
          </span>
          <span
            className="text-[10px] font-semibold text-nim-faint uppercase tracking-wide"
            style={{ writingMode: 'vertical-lr', textOrientation: 'mixed' }}
          >
            {label}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="session-kanban-column flex flex-col min-w-[240px] max-w-[300px] flex-1 rounded-lg bg-nim-secondary" data-testid="session-kanban-column" data-phase={phase}>
      {/* Column header */}
      <div
        className="flex items-center gap-2 px-3 py-2 border-b border-nim cursor-pointer hover:bg-[var(--nim-bg-hover)] transition-colors"
        onClick={(e) => {
          if (sessions.length > 0) {
            onSelectAll(sessions.map(s => s.id));
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          onHeaderContextMenu(e, phase, sessions.map(s => s.id));
        }}
      >
        <span
          className="w-2 h-2 rounded-full shrink-0"
          style={{ backgroundColor: color }}
        />
        <span className="text-[11px] font-semibold text-nim uppercase tracking-wide truncate">
          {label}
        </span>
        <span className="text-[10px] font-semibold text-nim-faint ml-auto">
          {sessions.length}
        </span>
        <button
          className="text-nim-disabled hover:text-nim-muted transition-colors"
          onClick={(e) => { e.stopPropagation(); onToggleCollapse(); }}
          title="Collapse column"
        >
          <MaterialSymbol icon="chevron_left" size={16} />
        </button>
      </div>

      {/* Column cards */}
      <div
        className={`flex-1 overflow-y-auto p-1.5 space-y-1.5 transition-colors ${
          isDragOver ? 'bg-[rgba(96,165,250,0.05)] outline outline-2 outline-dashed outline-[rgba(96,165,250,0.3)] -outline-offset-2 rounded' : ''
        }`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {sessions.length === 0 ? (
          <div className="flex items-center justify-center py-6 text-nim-disabled text-[11px] italic">
            No sessions
          </div>
        ) : (
          sessions.map(session => (
            <div
              key={session.id}
              draggable
              onDragStart={(e) => handleDragStart(e, session.id)}
              className={isComplete ? 'opacity-65' : ''}
              onClick={(e) => onCardClick(session.id, e)}
            >
              <SessionKanbanCard
                session={session}
                onSelect={onSelect}
                onArchive={onArchive}
                onRename={onRename}
                phaseColor={color}
                isFocused={focusedCardId === session.id}
                isSelected={selectedIds.has(session.id)}
                selectedCount={selectedIds.size}
                showPeekOverride={peekCardId === session.id ? true : undefined}
                onPeekToggle={() => onPeekToggle(session.id)}
              />
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ============================================================
// UnphasedColumn (collapsible, leftmost)
// ============================================================

interface UnphasedColumnProps {
  sessions: SessionMeta[];
  onSelect: (sessionId: string) => void;
  onArchive?: (sessionId: string) => void;
  onRename?: (sessionId: string, newName: string) => void;
  onDropToPhase: (sessionIds: string[], phase: SessionPhase) => void;
  onRemovePhase: (sessionIds: string[]) => void;
  focusedCardId: string | null;
  selectedIds: Set<string>;
  peekCardId: string | null;
  onCardClick: (sessionId: string, e: React.MouseEvent) => void;
  onPeekToggle: (sessionId: string) => void;
  onDragStart: (sessionId: string) => string[];
  onSelectAll: (sessionIds: string[]) => void;
  onHeaderContextMenu: (e: React.MouseEvent, phase: SessionPhaseKey, sessionIds: string[]) => void;
}

function UnphasedColumn({ sessions, onSelect, onArchive, onRename, onDropToPhase, onRemovePhase, focusedCardId, selectedIds, peekCardId, onCardClick, onPeekToggle, onDragStart: onDragStartProp, onSelectAll, onHeaderContextMenu }: UnphasedColumnProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const raw = e.dataTransfer.getData('text/session-ids');
    if (raw) {
      try {
        const ids: string[] = JSON.parse(raw);
        if (ids.length > 0) onRemovePhase(ids);
      } catch { /* ignore malformed */ }
    }
  }, [onRemovePhase]);

  const handleDragStart = useCallback((e: React.DragEvent, sessionId: string) => {
    const ids = onDragStartProp(sessionId);
    e.dataTransfer.setData('text/session-ids', JSON.stringify(ids));
    e.dataTransfer.effectAllowed = 'move';
    if (ids.length > 1) {
      const badge = document.createElement('div');
      badge.textContent = `${ids.length} sessions`;
      badge.style.cssText = 'position:fixed;left:-1000px;top:-1000px;padding:4px 10px;border-radius:6px;background:#60a5fa;color:#fff;font-size:12px;font-weight:600;white-space:nowrap;';
      document.body.appendChild(badge);
      e.dataTransfer.setDragImage(badge, badge.offsetWidth / 2, badge.offsetHeight / 2);
      requestAnimationFrame(() => document.body.removeChild(badge));
    }
  }, [onDragStartProp]);

  if (sessions.length === 0) return null;

  // Collapsed: vertical strip with count
  if (!isExpanded) {
    return (
      <div
        className={`session-kanban-column flex flex-col w-10 shrink-0 rounded-lg bg-nim-secondary cursor-pointer transition-colors ${
          isDragOver ? 'bg-[rgba(96,165,250,0.08)] outline outline-2 outline-dashed outline-[rgba(96,165,250,0.3)] -outline-offset-2' : ''
        }`}
        data-testid="session-kanban-column"
        data-phase="unphased"
        onClick={() => setIsExpanded(true)}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <div className="flex flex-col items-center gap-1 py-3">
          <span
            className="w-2 h-2 rounded-full shrink-0 bg-neutral-600"
          />
          <span className="text-[10px] font-semibold text-nim-faint">
            {sessions.length}
          </span>
          <span
            className="text-[10px] font-semibold text-nim-faint uppercase tracking-wide"
            style={{ writingMode: 'vertical-lr', textOrientation: 'mixed' }}
          >
            Inbox
          </span>
        </div>
      </div>
    );
  }

  // Expanded: full column
  return (
    <div
      className="session-kanban-column flex flex-col min-w-[240px] max-w-[300px] flex-1 rounded-lg bg-nim-secondary"
      data-testid="session-kanban-column"
      data-phase="unphased"
    >
      {/* Column header */}
      <div
        className="flex items-center gap-2 px-3 py-2 border-b border-nim cursor-pointer hover:bg-[var(--nim-bg-hover)] transition-colors"
        onClick={(e) => {
          if (sessions.length > 0) {
            onSelectAll(sessions.map(s => s.id));
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          onHeaderContextMenu(e, 'unphased', sessions.map(s => s.id));
        }}
      >
        <span className="w-2 h-2 rounded-full shrink-0 bg-neutral-600" />
        <span className="text-[11px] font-semibold text-nim uppercase tracking-wide truncate">
          Inbox
        </span>
        <span className="text-[10px] font-semibold text-nim-faint ml-auto">
          {sessions.length}
        </span>
        <button
          className="text-nim-faint hover:text-nim transition-colors"
          onClick={(e) => { e.stopPropagation(); setIsExpanded(false); }}
          title="Collapse"
        >
          <MaterialSymbol icon="chevron_left" size={16} />
        </button>
      </div>

      {/* Column cards */}
      <div
        className={`flex-1 overflow-y-auto p-1.5 space-y-1.5 transition-colors ${
          isDragOver ? 'bg-[rgba(96,165,250,0.05)] outline outline-2 outline-dashed outline-[rgba(96,165,250,0.3)] -outline-offset-2 rounded' : ''
        }`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {sessions.map(session => (
          <div
            key={session.id}
            draggable
            onDragStart={(e) => handleDragStart(e, session.id)}
            onClick={(e) => onCardClick(session.id, e)}
          >
            <SessionKanbanCard
              session={session}
              onSelect={onSelect}
              onArchive={onArchive}
              onRename={onRename}
              phaseColor="#525252"
              isFocused={focusedCardId === session.id}
              isSelected={selectedIds.has(session.id)}
              selectedCount={selectedIds.size}
              showPeekOverride={peekCardId === session.id ? true : undefined}
              onPeekToggle={() => onPeekToggle(session.id)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

// ============================================================
// SessionKanbanToolbar
// ============================================================

function SessionKanbanToolbar({ selectedCount, onClearSelection }: { selectedCount: number; onClearSelection: () => void }) {
  const posthog = usePostHog();
  const filter = useAtomValue(sessionKanbanFilterAtom);
  const setFilter = useSetAtom(sessionKanbanFilterAtom);
  const totalCount = useAtomValue(sessionKanbanTotalCountAtom);
  const allTags = useAtomValue(sessionKanbanTagsAtom);
  const [showTagDropdown, setShowTagDropdown] = useState(false);
  const [tagQuery, setTagQuery] = useState('');
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const dropdownRef = React.useRef<HTMLDivElement>(null);
  const searchDebounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // Filter tags for the dropdown: match query, exclude already-active tags
  const filteredTags = useMemo(() => {
    const activeSet = new Set(filter.tags);
    return allTags
      .filter(t => !activeSet.has(t.name))
      .filter(t => !tagQuery || t.name.toLowerCase().includes(tagQuery.toLowerCase()));
  }, [allTags, filter.tags, tagQuery]);

  const addTag = useCallback((tag: string) => {
    if (!filter.tags.includes(tag)) {
      const newTags = [...filter.tags, tag];
      setFilter({ ...filter, tags: newTags });
      posthog?.capture('kanban_filter_applied', {
        filterType: 'tag',
        activeTagCount: newTags.length,
      });
    }
    setTagQuery('');
    setShowTagDropdown(false);
    setHighlightedIndex(0);
  }, [filter, setFilter, posthog]);

  const removeTag = useCallback((tag: string) => {
    setFilter({ ...filter, tags: filter.tags.filter(t => t !== tag) });
  }, [filter, setFilter]);

  // Handle input changes: detect # prefix for tag mode
  const handleSearchChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    // Check if the user is typing a tag filter (starts with # or contains #)
    const hashIndex = value.lastIndexOf('#');
    if (hashIndex >= 0) {
      const query = value.slice(hashIndex + 1);
      setTagQuery(query);
      setShowTagDropdown(true);
      setHighlightedIndex(0);
      // Keep the text before # as the search text
      setFilter({ ...filter, search: value.slice(0, hashIndex).trim() });
    } else {
      setFilter({ ...filter, search: value });
      setShowTagDropdown(false);
      setTagQuery('');
      // Debounced search tracking
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
      if (value.trim()) {
        searchDebounceRef.current = setTimeout(() => {
          posthog?.capture('kanban_filter_applied', {
            filterType: 'search',
            activeTagCount: filter.tags.length,
          });
        }, 1000);
      }
    }
  }, [filter, setFilter, posthog]);

  // Keyboard navigation for tag dropdown
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!showTagDropdown || filteredTags.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightedIndex(i => Math.min(i + 1, filteredTags.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightedIndex(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      addTag(filteredTags[highlightedIndex].name);
      // Clear the # from the input
      if (inputRef.current) {
        inputRef.current.value = filter.search;
      }
    } else if (e.key === 'Escape') {
      setShowTagDropdown(false);
      setTagQuery('');
    }
  }, [showTagDropdown, filteredTags, highlightedIndex, addTag, filter.search]);

  // Close dropdown on outside click
  React.useEffect(() => {
    if (!showTagDropdown) return;
    const handleClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node) &&
          inputRef.current && !inputRef.current.contains(e.target as Node)) {
        setShowTagDropdown(false);
        setTagQuery('');
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showTagDropdown]);

  // Compute display value: search text + any in-progress tag query
  const inputValue = showTagDropdown
    ? (filter.search ? filter.search + ' ' : '') + '#' + tagQuery
    : filter.search;

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 border-b border-nim bg-nim shrink-0" data-testid="kanban-toolbar">
      {/* Search with tag typeahead */}
      <div className="relative flex-1 max-w-[280px]">
        <MaterialSymbol
          icon="search"
          size={14}
          className="absolute left-2 top-1/2 -translate-y-1/2 text-nim-faint pointer-events-none"
        />
        <input
          ref={inputRef}
          type="text"
          placeholder="Search or type # to filter by tag..."
          value={inputValue}
          onChange={handleSearchChange}
          onKeyDown={handleKeyDown}
          onFocus={() => {
            if (tagQuery || inputValue.includes('#')) {
              setShowTagDropdown(true);
            }
          }}
          data-testid="kanban-search"
          className="w-full pl-7 pr-2 py-1 text-[11px] bg-nim-secondary border border-nim rounded text-nim placeholder:text-nim-faint focus:outline-none focus:border-[var(--nim-primary)]"
        />

        {/* Tag typeahead dropdown */}
        {showTagDropdown && filteredTags.length > 0 && (
          <div
            ref={dropdownRef}
            className="absolute left-0 right-0 top-full mt-1 bg-nim-secondary border border-nim rounded shadow-lg z-50 max-h-[200px] overflow-y-auto"
          >
            {filteredTags.slice(0, 15).map((tag, i) => (
              <button
                key={tag.name}
                className={`w-full text-left px-2.5 py-1.5 text-[11px] flex items-center justify-between cursor-pointer transition-colors ${
                  i === highlightedIndex ? 'bg-nim-tertiary text-nim' : 'text-nim-muted hover:bg-nim-tertiary'
                }`}
                onMouseEnter={() => setHighlightedIndex(i)}
                onClick={() => addTag(tag.name)}
              >
                <span>#{tag.name}</span>
                <span className="text-nim-faint text-[10px]">{tag.count}</span>
              </button>
            ))}
          </div>
        )}
        {showTagDropdown && filteredTags.length === 0 && tagQuery && (
          <div
            ref={dropdownRef}
            className="absolute left-0 right-0 top-full mt-1 bg-nim-secondary border border-nim rounded shadow-lg z-50"
          >
            <div className="px-2.5 py-2 text-[11px] text-nim-faint italic">
              No matching tags
            </div>
          </div>
        )}
      </div>

      {/* Active tag filter chips */}
      {filter.tags.map(tag => (
        <button
          key={tag}
          className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] border cursor-pointer shrink-0 bg-blue-400/[0.12] border-blue-400/30 text-blue-400"
          onClick={() => removeTag(tag)}
        >
          #{tag}
          <MaterialSymbol icon="close" size={12} />
        </button>
      ))}

      {/* Selection indicator */}
      {selectedCount > 0 && (
        <button
          className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] border border-[rgba(96,165,250,0.4)] text-[#60a5fa] bg-[rgba(96,165,250,0.08)] cursor-pointer shrink-0"
          onClick={onClearSelection}
          title="Clear selection (Esc)"
        >
          {selectedCount} selected
          <MaterialSymbol icon="close" size={12} />
        </button>
      )}

      <div className="flex-1" />

      {/* Count */}
      <span className="text-[11px] text-nim-faint shrink-0">
        {totalCount} session{totalCount !== 1 ? 's' : ''}
      </span>

      {/* Show completed toggle */}
      <button
        className={`flex items-center gap-1 px-2 py-0.5 rounded text-[11px] border transition-colors shrink-0 ${
          filter.showComplete
            ? 'border-[rgba(96,165,250,0.4)] text-[#60a5fa] bg-[rgba(96,165,250,0.08)]'
            : 'border-nim text-nim-faint hover:text-nim'
        }`}
        onClick={() => setFilter({ ...filter, showComplete: !filter.showComplete })}
        data-testid="kanban-toggle-complete"
      >
        <MaterialSymbol icon="visibility" size={13} />
        Complete
      </button>
    </div>
  );
}

// ============================================================
// ColumnHeaderContextMenu - context menu for batch column ops
// ============================================================

interface ColumnHeaderContextMenuProps {
  phase: SessionPhaseKey;
  sessionIds: string[];
  position: { x: number; y: number };
  onClose: () => void;
  onSelectAll: (ids: string[]) => void;
  onArchiveAll: (ids: string[]) => void;
  onMoveAll: (ids: string[], phase: SessionPhase) => void;
  onRemovePhase: (ids: string[]) => void;
}

function ColumnHeaderContextMenu({ phase, sessionIds, position, onClose, onSelectAll, onArchiveAll, onMoveAll, onRemovePhase }: ColumnHeaderContextMenuProps) {
  const reference = useMemo(() => virtualElement(position.x, position.y), [position.x, position.y]);
  const menu = useFloatingMenu({
    placement: 'right-start',
    reference,
    open: true,
    onOpenChange: (open) => { if (!open) onClose(); },
  });

  const menuItemClass = 'flex items-center gap-2 w-full px-2.5 py-2 bg-transparent border-none rounded text-[var(--nim-text)] text-[0.8125rem] cursor-pointer text-left transition-colors duration-150 hover:bg-[var(--nim-bg-hover)] [&_svg]:shrink-0';
  const count = sessionIds.length;

  const [showMoveSubmenu, setShowMoveSubmenu] = useState(false);
  const [submenuFlipped, setSubmenuFlipped] = useState(false);
  const submenuParentRef = useRef<HTMLDivElement>(null);

  if (count === 0) {
    return (
      <FloatingPortal>
        <div
          ref={menu.refs.setFloating}
          style={menu.floatingStyles}
          {...menu.getFloatingProps()}
          className="z-[1000] min-w-[160px] p-1 bg-[var(--nim-bg)] border border-[var(--nim-border)] rounded-md shadow-[0_4px_12px_rgba(0,0,0,0.15)]"
          onMouseLeave={onClose}
        >
          <div className="px-2.5 py-2 text-[0.8125rem] text-[var(--nim-text-faint)] italic">
            No sessions in column
          </div>
        </div>
      </FloatingPortal>
    );
  }

  return (
    <FloatingPortal>
      <div
        ref={menu.refs.setFloating}
        style={menu.floatingStyles}
        {...menu.getFloatingProps()}
        className="z-[1000] min-w-[180px] p-1 bg-[var(--nim-bg)] border border-[var(--nim-border)] rounded-md shadow-[0_4px_12px_rgba(0,0,0,0.15)]"
        onClick={(e) => e.stopPropagation()}
        onMouseLeave={onClose}
      >
        {/* Select all in column */}
        <button
          className={menuItemClass}
          onClick={(e) => { e.stopPropagation(); onClose(); onSelectAll(sessionIds); }}
        >
          <MaterialSymbol icon="select_all" size={14} />
          Select All ({count})
        </button>

        <div className="h-px bg-[var(--nim-border)] my-1" />

        {/* Move all to phase submenu */}
        <div
          ref={submenuParentRef}
          className="relative"
          onMouseEnter={() => {
            if (submenuParentRef.current) {
              const rect = submenuParentRef.current.getBoundingClientRect();
              setSubmenuFlipped(rect.right + 150 > window.innerWidth);
            }
            setShowMoveSubmenu(true);
          }}
          onMouseLeave={() => setShowMoveSubmenu(false)}
        >
          <button
            className={menuItemClass}
            onClick={(e) => { e.stopPropagation(); setShowMoveSubmenu(!showMoveSubmenu); }}
          >
            <MaterialSymbol icon="drive_file_move" size={14} />
            <span className="flex-1">Move All to...</span>
            <MaterialSymbol icon="chevron_right" size={12} />
          </button>
          {showMoveSubmenu && (
            <div className={`absolute top-0 min-w-[140px] p-1 bg-[var(--nim-bg)] border border-[var(--nim-border)] rounded-md shadow-[0_4px_12px_rgba(0,0,0,0.15)] z-[1001] ${submenuFlipped ? 'right-full mr-0.5' : 'left-full ml-0.5'}`}>
              {SESSION_PHASE_COLUMNS.filter(col => col.value !== phase).map((col) => (
                <button
                  key={col.value}
                  className={`flex items-center gap-2 w-full px-2.5 py-2 bg-transparent border-none rounded text-[var(--nim-text)] text-[0.8125rem] cursor-pointer text-left transition-colors duration-150 hover:bg-[var(--nim-bg-hover)]`}
                  onClick={(e) => { e.stopPropagation(); onClose(); onMoveAll(sessionIds, col.value); }}
                >
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: col.color }} />
                  {col.label}
                </button>
              ))}
              {phase !== 'unphased' && (
                <>
                  <div className="h-px bg-[var(--nim-border)] my-1" />
                  <button
                    className={`flex items-center gap-2 w-full px-2.5 py-2 bg-transparent border-none rounded text-[var(--nim-text-faint)] text-[0.8125rem] cursor-pointer text-left transition-colors duration-150 hover:bg-[var(--nim-bg-hover)]`}
                    onClick={(e) => { e.stopPropagation(); onClose(); onRemovePhase(sessionIds); }}
                  >
                    <MaterialSymbol icon="close" size={14} />
                    Remove from board
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        <div className="h-px bg-[var(--nim-border)] my-1" />

        {/* Archive all */}
        <button
          className="flex items-center gap-2 w-full px-2.5 py-2 bg-transparent border-none rounded text-[var(--nim-error)] text-[0.8125rem] cursor-pointer text-left transition-colors duration-150 hover:bg-[var(--nim-error)] hover:text-white [&_svg]:shrink-0"
          onClick={(e) => { e.stopPropagation(); onClose(); onArchiveAll(sessionIds); }}
        >
          <MaterialSymbol icon="archive" size={14} />
          Archive All ({count})
        </button>
      </div>
    </FloatingPortal>
  );
}

// ============================================================
// ArchiveGutter - Right-side drop zone to archive sessions
// ============================================================

function ArchiveGutter({ onArchive }: { onArchive: (sessionIds: string[]) => void }) {
  const [isDragOver, setIsDragOver] = useState(false);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const raw = e.dataTransfer.getData('text/session-ids');
    // console.log('[ArchiveGutter] drop raw:', raw, 'types:', Array.from(e.dataTransfer.types));
    if (raw) {
      try {
        const ids: string[] = JSON.parse(raw);
        // console.log('[ArchiveGutter] parsed ids:', ids);
        if (ids.length > 0) onArchive(ids);
      } catch { /* ignore malformed */ }
    }
  }, [onArchive]);

  return (
    <div
      className={`flex flex-col items-center justify-center w-10 shrink-0 rounded-lg transition-all ${
        isDragOver
          ? 'bg-[rgba(239,68,68,0.1)] outline outline-2 outline-dashed outline-[rgba(239,68,68,0.4)] -outline-offset-2'
          : 'bg-nim-secondary'
      }`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      data-testid="kanban-archive-gutter"
    >
      <MaterialSymbol
        icon="archive"
        size={16}
        className={`transition-colors ${isDragOver ? 'text-[#ef4444]' : 'text-nim-disabled'}`}
      />
      <span
        className={`text-[10px] font-semibold uppercase tracking-wide mt-1 transition-colors ${
          isDragOver ? 'text-[#ef4444]' : 'text-nim-disabled'
        }`}
        style={{ writingMode: 'vertical-lr', textOrientation: 'mixed' }}
      >
        Archive
      </span>
    </div>
  );
}

// ============================================================
// SessionKanbanBoard (Main Export)
// ============================================================

interface SessionKanbanBoardProps {
  onSessionSelect?: (sessionId: string) => void;
  /** Called on double-click to open a session (select + navigate to it) */
  onSessionOpen?: (sessionId: string) => void;
}

export const SessionKanbanBoard: React.FC<SessionKanbanBoardProps> = ({ onSessionSelect, onSessionOpen }) => {
  const posthog = usePostHog();
  const grouped = useAtomValue(sessionsByPhaseAtom);
  const setPhase = useSetAtom(setSessionPhaseAtom);
  const updateSessionStore = useSetAtom(updateSessionStoreAtom);
  const registry = useAtomValue(sessionRegistryAtom);
  const removeSession = useSetAtom(removeSessionFullAtom);
  const workspacePath = useAtomValue(sessionListWorkspaceAtom);

  // Worktree archive dialog
  const {
    dialogState: archiveWorktreeDialogState,
    showDialog: showArchiveWorktreeDialog,
    closeDialog: closeArchiveWorktreeDialog,
    confirmArchive: confirmArchiveWorktree,
  } = useArchiveWorktreeDialog();

  // Keyboard navigation state
  const [focusedCardId, setFocusedCardId] = useState<string | null>(null);
  const [peekCardId, setPeekCardId] = useState<string | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);

  // Multi-selection state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const lastClickedIdRef = useRef<string | null>(null);

  // Collapsible column state
  const [collapsedColumns, setCollapsedColumns] = useState<Set<SessionPhaseKey>>(new Set());

  // Column header context menu state
  const [columnContextMenu, setColumnContextMenu] = useState<{
    phase: SessionPhaseKey;
    sessionIds: string[];
    position: { x: number; y: number };
  } | null>(null);

  const toggleCollapse = useCallback((columnKey: SessionPhaseKey) => {
    setCollapsedColumns(prev => {
      const next = new Set(prev);
      const willCollapse = !next.has(columnKey);
      if (next.has(columnKey)) {
        next.delete(columnKey);
      } else {
        next.add(columnKey);
      }
      posthog?.capture('kanban_column_collapsed', {
        action: willCollapse ? 'collapsed' : 'expanded',
        column: columnKey,
      });
      return next;
    });
  }, [posthog]);

  // Flat list of all visible session IDs in board order (for shift-select ranges)
  const flatSessionIds = useMemo(() => {
    const ids: string[] = [];
    const unphasedSessions = grouped.get('unphased') || [];
    for (const s of unphasedSessions) ids.push(s.id);
    for (const col of SESSION_PHASE_COLUMNS) {
      const sessions = grouped.get(col.value) || [];
      for (const s of sessions) ids.push(s.id);
    }
    return ids;
  }, [grouped]);

  // Build a flat ordered list of [columnKey, sessionId] for keyboard navigation
  const navigationGrid = useMemo(() => {
    const grid: { columnKey: SessionPhaseKey; sessions: SessionMeta[] }[] = [];

    const unphasedSessions = grouped.get('unphased') || [];
    if (unphasedSessions.length > 0 && !collapsedColumns.has('unphased')) {
      grid.push({ columnKey: 'unphased', sessions: unphasedSessions });
    }

    for (const col of SESSION_PHASE_COLUMNS) {
      const sessions = grouped.get(col.value) || [];
      if (!collapsedColumns.has(col.value)) {
        grid.push({ columnKey: col.value, sessions });
      }
    }

    return grid;
  }, [grouped, collapsedColumns]);

  // Find the current position in the grid
  const findPosition = useCallback((cardId: string): BoardPosition | null => {
    for (const col of navigationGrid) {
      const idx = col.sessions.findIndex(s => s.id === cardId);
      if (idx !== -1) {
        return { columnKey: col.columnKey, cardIndex: idx };
      }
    }
    return null;
  }, [navigationGrid]);

  // Get the session ID at a grid position
  const getSessionAtPosition = useCallback((colIdx: number, cardIdx: number): string | null => {
    if (colIdx < 0 || colIdx >= navigationGrid.length) return null;
    const col = navigationGrid[colIdx];
    if (col.sessions.length === 0) return null;
    const clamped = Math.min(cardIdx, col.sessions.length - 1);
    return col.sessions[clamped]?.id ?? null;
  }, [navigationGrid]);

  // Find column index in the grid by key
  const findColumnIndex = useCallback((key: SessionPhaseKey): number => {
    return navigationGrid.findIndex(c => c.columnKey === key);
  }, [navigationGrid]);

  const handleSelect = useCallback((sessionId: string) => {
    posthog?.capture('kanban_card_opened', {
      cardType: getCardType(registry.get(sessionId)),
    });
    if (onSessionOpen) {
      onSessionOpen(sessionId);
    } else {
      onSessionSelect?.(sessionId);
    }
  }, [onSessionSelect, onSessionOpen, posthog, registry]);

  const handleDrop = useCallback((sessionIds: string[], phase: SessionPhase) => {
    for (const id of sessionIds) {
      setPhase({ sessionId: id, phase });
    }
    posthog?.capture('kanban_card_phase_changed', {
      method: 'drag',
      toPhase: phase,
      cardCount: sessionIds.length,
      cardType: sessionIds.length === 1 ? getCardType(registry.get(sessionIds[0])) : 'mixed',
    });
    setSelectedIds(new Set());
  }, [setPhase, posthog, registry]);

  const handleRemovePhase = useCallback((sessionIds: string[]) => {
    for (const id of sessionIds) {
      setPhase({ sessionId: id, phase: null });
    }
    posthog?.capture('kanban_card_phase_changed', {
      method: 'drag',
      toPhase: 'unphased',
      cardCount: sessionIds.length,
      cardType: sessionIds.length === 1 ? getCardType(registry.get(sessionIds[0])) : 'mixed',
    });
    setSelectedIds(new Set());
  }, [setPhase, posthog, registry]);

  const cleanupWorktreeSessions = useCallback((worktreeId: string) => {
    const worktreeSessions = Array.from(registry.values()).filter(s => s.worktreeId === worktreeId);
    worktreeSessions.forEach(session => {
      removeSession(session.id);
    });
  }, [registry, removeSession]);

  // Archive sessions, routing worktree sessions to the worktree archive dialog
  const handleArchive = useCallback(async (sessionIds: string[]) => {
    posthog?.capture('kanban_card_archived', {
      cardCount: sessionIds.length,
      cardType: sessionIds.length === 1 ? getCardType(registry.get(sessionIds[0])) : 'mixed',
    });
    for (const sessionId of sessionIds) {
      const session = registry.get(sessionId);
      if (session?.worktreeId) {
        // Only trigger full worktree archive if this is the last non-archived session in the worktree
        const siblingCount = Array.from(registry.values()).filter(
          s => s.worktreeId === session.worktreeId && !s.isArchived && s.id !== sessionId
        ).length;

        if (siblingCount === 0 && workspacePath) {
          // Last session in worktree - trigger full worktree archive flow
          const worktreeResult = await window.electronAPI.worktreeGet(session.worktreeId);
          const worktree = worktreeResult.worktree;
          const worktreeName = worktree?.name || worktree?.path?.split('/').pop() || 'worktree';
          const worktreePath = worktree?.path || '';

          const autoArchived = await showArchiveWorktreeDialog({
            worktreeId: session.worktreeId,
            worktreeName,
            worktreePath,
            workspacePath,
          });

          if (autoArchived) {
            cleanupWorktreeSessions(session.worktreeId);
          }
          return;
        } else {
          // Still other sessions in this worktree - just archive this session
          try {
            const result = await window.electronAPI.invoke('sessions:update-metadata', sessionId, { isArchived: true });
            if (result.success) {
              updateSessionStore({ sessionId, updates: { isArchived: true } });
              setPhase({ sessionId, phase: null });
            }
          } catch (err) {
            console.error('[SessionKanbanBoard] Failed to archive session:', err);
          }
        }
        continue;
      }
      try {
        // Archive AND clear phase so the session leaves the board entirely
        const result = await window.electronAPI.invoke('sessions:update-metadata', sessionId, { isArchived: true });
        if (result.success) {
          updateSessionStore({ sessionId, updates: { isArchived: true } });
          setPhase({ sessionId, phase: null });
        }
      } catch (err) {
        console.error('[SessionKanbanBoard] Failed to archive session:', err);
      }
    }

    setSelectedIds(new Set());
  }, [updateSessionStore, setPhase, registry, showArchiveWorktreeDialog, workspacePath, cleanupWorktreeSessions, posthog]);

  // Archive wrapper for context menu: if the session is part of a multiselect, archive all selected
  const handleArchiveSingle = useCallback((sessionId: string) => {
    if (selectedIds.has(sessionId) && selectedIds.size > 1) {
      handleArchive(Array.from(selectedIds));
    } else {
      handleArchive([sessionId]);
    }
  }, [handleArchive, selectedIds]);

  const handleRename = useCallback(async (sessionId: string, newName: string) => {
    try {
      await window.electronAPI.invoke('sessions:update-session-metadata', sessionId, { title: newName });
      updateSessionStore({ sessionId, updates: { title: newName } });
    } catch (err) {
      console.error('[SessionKanbanBoard] Failed to rename session:', err);
    }
  }, [updateSessionStore]);

  const handleConfirmArchiveWorktree = useCallback(async () => {
    if (!archiveWorktreeDialogState || !workspacePath) return;

    const worktreeId = archiveWorktreeDialogState.worktreeId;

    await confirmArchiveWorktree(workspacePath, () => {
      cleanupWorktreeSessions(worktreeId);
    });
  }, [archiveWorktreeDialogState, workspacePath, confirmArchiveWorktree, cleanupWorktreeSessions]);

  // Click on a card: plain = select one, Cmd = toggle, Shift = range
  const handleCardClick = useCallback((sessionId: string, e: React.MouseEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    const shift = e.shiftKey;

    if (mod) {
      // Toggle this card in/out of selection
      setSelectedIds(prev => {
        const next = new Set(prev);
        if (next.has(sessionId)) {
          next.delete(sessionId);
        } else {
          next.add(sessionId);
        }
        return next;
      });
    } else if (shift && lastClickedIdRef.current) {
      // Select range from lastClicked to this card
      const anchorIdx = flatSessionIds.indexOf(lastClickedIdRef.current);
      const targetIdx = flatSessionIds.indexOf(sessionId);
      if (anchorIdx !== -1 && targetIdx !== -1) {
        const start = Math.min(anchorIdx, targetIdx);
        const end = Math.max(anchorIdx, targetIdx);
        const rangeIds = flatSessionIds.slice(start, end + 1);
        setSelectedIds(new Set(rangeIds));
      } else {
        setSelectedIds(new Set([sessionId]));
      }
    } else {
      // Plain click: select just this card
      setSelectedIds(new Set([sessionId]));
    }

    lastClickedIdRef.current = sessionId;
    setFocusedCardId(sessionId);

    // Close peek if clicking a different card
    if (peekCardId && peekCardId !== sessionId) {
      setPeekCardId(null);
    }
  }, [peekCardId, flatSessionIds]);

  // Called by columns when a drag starts. Returns the set of IDs being dragged.
  // If the dragged card is part of the selection, drag the whole selection.
  // Otherwise, select just the dragged card.
  const handleDragStart = useCallback((sessionId: string): string[] => {
    if (selectedIds.has(sessionId)) {
      return Array.from(selectedIds);
    }
    setSelectedIds(new Set([sessionId]));
    lastClickedIdRef.current = sessionId;
    return [sessionId];
  }, [selectedIds]);

  // Select all sessions in a column
  const handleSelectAllInColumn = useCallback((sessionIds: string[]) => {
    setSelectedIds(new Set(sessionIds));
    if (sessionIds.length > 0) {
      lastClickedIdRef.current = sessionIds[0];
      setFocusedCardId(sessionIds[0]);
    }
  }, []);

  // Open column header context menu
  const handleHeaderContextMenu = useCallback((e: React.MouseEvent, phase: SessionPhaseKey, sessionIds: string[]) => {
    setColumnContextMenu({ phase, sessionIds, position: { x: e.clientX, y: e.clientY } });
  }, []);

  // Batch move all sessions in a column to a new phase
  const handleMoveAllToPhase = useCallback((sessionIds: string[], phase: SessionPhase) => {
    for (const id of sessionIds) {
      setPhase({ sessionId: id, phase });
    }
    posthog?.capture('kanban_column_batch_move', {
      toPhase: phase,
      cardCount: sessionIds.length,
    });
    setSelectedIds(new Set());
  }, [setPhase, posthog]);

  // Toggle peek for a specific card
  const handlePeekToggle = useCallback((sessionId: string) => {
    const willOpen = peekCardId !== sessionId;
    setPeekCardId(prev => prev === sessionId ? null : sessionId);
    posthog?.capture('kanban_card_peeked', {
      action: willOpen ? 'opened' : 'closed',
    });
  }, [peekCardId, posthog]);

  // Move focus (and peek if peek is open) to a new card
  const moveFocusTo = useCallback((nextId: string) => {
    setFocusedCardId(nextId);
    // If peek is open, move it to the new card
    if (peekCardId) {
      setPeekCardId(nextId);
    }
  }, [peekCardId]);

  // Get IDs to act on for keyboard commands: selection if non-empty, else focused card
  const getActionIds = useCallback((): string[] => {
    if (selectedIds.size > 0) return Array.from(selectedIds);
    if (focusedCardId) return [focusedCardId];
    return [];
  }, [selectedIds, focusedCardId]);

  // Keyboard handler
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Don't handle if the search input is focused
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;

    const { key, metaKey, ctrlKey } = e;
    const mod = metaKey || ctrlKey;

    // Cmd+A: select all visible cards
    if (key === 'a' && mod) {
      e.preventDefault();
      setSelectedIds(new Set(flatSessionIds));
      return;
    }

    // Escape: close peek, then clear selection, then clear focus
    if (key === 'Escape') {
      e.preventDefault();
      if (peekCardId) {
        setPeekCardId(null);
      } else if (selectedIds.size > 0) {
        setSelectedIds(new Set());
      } else {
        setFocusedCardId(null);
      }
      return;
    }

    // If no card focused, focus the first card on any arrow key
    if (!focusedCardId) {
      if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'ArrowLeft' || key === 'ArrowRight') {
        e.preventDefault();
        const firstCard = getSessionAtPosition(0, 0);
        if (firstCard) moveFocusTo(firstCard);
      }
      return;
    }

    const pos = findPosition(focusedCardId);
    if (!pos) return;

    const colIdx = findColumnIndex(pos.columnKey);
    if (colIdx === -1) return;

    // Arrow navigation
    if (key === 'ArrowDown' && !mod) {
      e.preventDefault();
      const next = getSessionAtPosition(colIdx, pos.cardIndex + 1);
      if (next) moveFocusTo(next);
      return;
    }
    if (key === 'ArrowUp' && !mod) {
      e.preventDefault();
      if (pos.cardIndex > 0) {
        const prev = getSessionAtPosition(colIdx, pos.cardIndex - 1);
        if (prev) moveFocusTo(prev);
      }
      return;
    }
    if (key === 'ArrowRight' && !mod) {
      e.preventDefault();
      // Move to same row index in next non-empty column
      for (let i = colIdx + 1; i < navigationGrid.length; i++) {
        const next = getSessionAtPosition(i, pos.cardIndex);
        if (next) {
          moveFocusTo(next);
          break;
        }
      }
      return;
    }
    if (key === 'ArrowLeft' && !mod) {
      e.preventDefault();
      for (let i = colIdx - 1; i >= 0; i--) {
        const prev = getSessionAtPosition(i, pos.cardIndex);
        if (prev) {
          moveFocusTo(prev);
          break;
        }
      }
      return;
    }

    // Enter: open the focused session
    if (key === 'Enter') {
      e.preventDefault();
      handleSelect(focusedCardId);
      return;
    }

    // Space: toggle transcript peek
    if (key === ' ') {
      e.preventDefault();
      handlePeekToggle(focusedCardId);
      return;
    }

    // Cmd+Right: move selected cards to next phase
    if (key === 'ArrowRight' && mod) {
      e.preventDefault();
      const phaseKeys = SESSION_PHASE_COLUMNS.map(c => c.value);
      const currentPhaseIdx = pos.columnKey === 'unphased' ? -1 : phaseKeys.indexOf(pos.columnKey as SessionPhase);
      const nextPhaseIdx = currentPhaseIdx + 1;
      if (nextPhaseIdx < phaseKeys.length) {
        const ids = getActionIds();
        for (const id of ids) {
          setPhase({ sessionId: id, phase: phaseKeys[nextPhaseIdx] });
        }
        posthog?.capture('kanban_card_phase_changed', {
          method: 'keyboard',
          toPhase: phaseKeys[nextPhaseIdx],
          cardCount: ids.length,
          cardType: ids.length === 1 ? getCardType(registry.get(ids[0])) : 'mixed',
        });
      }
      return;
    }

    // Cmd+Left: move selected cards to previous phase
    if (key === 'ArrowLeft' && mod) {
      e.preventDefault();
      const phaseKeys = SESSION_PHASE_COLUMNS.map(c => c.value);
      const currentPhaseIdx = pos.columnKey === 'unphased' ? -1 : phaseKeys.indexOf(pos.columnKey as SessionPhase);
      if (currentPhaseIdx > 0) {
        const ids = getActionIds();
        for (const id of ids) {
          setPhase({ sessionId: id, phase: phaseKeys[currentPhaseIdx - 1] });
        }
        posthog?.capture('kanban_card_phase_changed', {
          method: 'keyboard',
          toPhase: phaseKeys[currentPhaseIdx - 1],
          cardCount: ids.length,
          cardType: ids.length === 1 ? getCardType(registry.get(ids[0])) : 'mixed',
        });
      } else if (currentPhaseIdx === 0) {
        const ids = getActionIds();
        for (const id of ids) {
          setPhase({ sessionId: id, phase: null });
        }
        posthog?.capture('kanban_card_phase_changed', {
          method: 'keyboard',
          toPhase: 'unphased',
          cardCount: ids.length,
          cardType: ids.length === 1 ? getCardType(registry.get(ids[0])) : 'mixed',
        });
      }
      return;
    }
  }, [focusedCardId, peekCardId, selectedIds, flatSessionIds, findPosition, findColumnIndex, getSessionAtPosition, navigationGrid, handleSelect, handlePeekToggle, setPhase, moveFocusTo, getActionIds, posthog, registry]);

  // Clear focus/peek/selection when grouped data changes and cards are gone
  useEffect(() => {
    if (focusedCardId && !findPosition(focusedCardId)) {
      setFocusedCardId(null);
      setPeekCardId(null);
    }
    // Prune selected IDs that no longer exist
    if (selectedIds.size > 0) {
      const allIds = new Set(flatSessionIds);
      let changed = false;
      const pruned = new Set<string>();
      for (const id of selectedIds) {
        if (allIds.has(id)) {
          pruned.add(id);
        } else {
          changed = true;
        }
      }
      if (changed) setSelectedIds(pruned);
    }
  }, [focusedCardId, findPosition, selectedIds, flatSessionIds]);

  const unphasedSessions = grouped.get('unphased') || [];

  // Check if board is empty (exclude unphased from empty check - phased columns must have content)
  let hasAnyPhasedSessions = false;
  for (const [key, sessions] of grouped) {
    if (key !== 'unphased' && sessions.length > 0) {
      hasAnyPhasedSessions = true;
      break;
    }
  }

  const isEmpty = !hasAnyPhasedSessions && unphasedSessions.length === 0;

  return (
    <div
      ref={boardRef}
      className="flex-1 flex flex-col overflow-hidden min-h-0 outline-none"
      data-testid="session-kanban-board"
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      <SessionKanbanToolbar selectedCount={selectedIds.size} onClearSelection={() => setSelectedIds(new Set())} />

      {isEmpty ? (
        <div className="flex-1 flex items-center justify-center text-nim-muted" data-testid="kanban-empty-state">
          <div className="text-center max-w-[300px]">
            <MaterialSymbol icon="view_kanban" size={48} className="opacity-30" />
            <p className="mt-2 text-sm">No sessions on the board</p>
            <p className="mt-1 text-xs text-nim-faint">
              Sessions appear here when an AI agent sets a phase, or you can drag sessions from the history sidebar.
            </p>
          </div>
        </div>
      ) : (
        <div className="flex-1 flex gap-2 p-2 overflow-x-auto overflow-y-hidden">
          <UnphasedColumn
            sessions={unphasedSessions}
            onSelect={handleSelect}
            onArchive={handleArchiveSingle}
            onRename={handleRename}
            onDropToPhase={handleDrop}
            onRemovePhase={handleRemovePhase}
            focusedCardId={focusedCardId}
            selectedIds={selectedIds}
            peekCardId={peekCardId}
            onCardClick={handleCardClick}
            onPeekToggle={handlePeekToggle}
            onDragStart={handleDragStart}
            onSelectAll={handleSelectAllInColumn}
            onHeaderContextMenu={handleHeaderContextMenu}
          />
          {SESSION_PHASE_COLUMNS.map(col => (
            <SessionKanbanColumn
              key={col.value}
              phase={col.value}
              label={col.label}
              color={col.color}
              sessions={grouped.get(col.value) || []}
              onSelect={handleSelect}
              onArchive={handleArchiveSingle}
              onRename={handleRename}
              onDrop={handleDrop}
              isCollapsed={collapsedColumns.has(col.value)}
              onToggleCollapse={() => toggleCollapse(col.value)}
              focusedCardId={focusedCardId}
              selectedIds={selectedIds}
              peekCardId={peekCardId}
              onCardClick={handleCardClick}
              onPeekToggle={handlePeekToggle}
              onDragStart={handleDragStart}
              onSelectAll={handleSelectAllInColumn}
              onHeaderContextMenu={handleHeaderContextMenu}
            />
          ))}
          <ArchiveGutter onArchive={handleArchive} />
        </div>
      )}

      {/* Column header context menu */}
      {columnContextMenu && (
        <ColumnHeaderContextMenu
          phase={columnContextMenu.phase}
          sessionIds={columnContextMenu.sessionIds}
          position={columnContextMenu.position}
          onClose={() => setColumnContextMenu(null)}
          onSelectAll={handleSelectAllInColumn}
          onArchiveAll={handleArchive}
          onMoveAll={handleMoveAllToPhase}
          onRemovePhase={handleRemovePhase}
        />
      )}

      {/* Archive worktree confirmation dialog */}
      {archiveWorktreeDialogState && (
        <ArchiveWorktreeDialog
          worktreeName={archiveWorktreeDialogState.worktreeName}
          onArchive={handleConfirmArchiveWorktree}
          onKeep={closeArchiveWorktreeDialog}
          hasUncommittedChanges={archiveWorktreeDialogState.hasUncommittedChanges}
          uncommittedFileCount={archiveWorktreeDialogState.uncommittedFileCount}
          hasUnmergedChanges={archiveWorktreeDialogState.hasUnmergedChanges}
          unmergedCommitCount={archiveWorktreeDialogState.unmergedCommitCount}
        />
      )}
    </div>
  );
};
