/**
 * SessionContextMenu - Shared context menu for session items across the app.
 *
 * Used by SessionListItem (session history sidebar), SessionKanbanCard (kanban board),
 * and SessionTab (workstream session tabs) to provide a consistent right-click menu.
 *
 * Menu items are shown conditionally based on which callbacks are provided.
 * Internal actions (copy ID, export, share, set phase) are always available.
 */
import React, { useState, useRef, useMemo, useCallback } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { MaterialSymbol, copyToClipboard } from '@nimbalyst/runtime';
import {
  sessionRegistryAtom,
  sessionShareAtom,
  shareKeysAtom,
  removeSessionShareAtom,
  buildShareUrl,
} from '../../store';
import { setSessionPhaseAtom, SESSION_PHASE_COLUMNS } from '../../store/atoms/sessionKanban';
import { errorNotificationService } from '../../services/ErrorNotificationService';
import { dialogRef, DIALOG_IDS } from '../../dialogs';
import type { ShareDialogData } from '../../dialogs';
import { useFloatingMenu, FloatingPortal, virtualElement } from '../../hooks/useFloatingMenu';
import { requestAttentionSupervisorAuthorization } from '../../services/attentionSupervisorAuthorization';

export interface SessionContextMenuProps {
  sessionId: string;
  title: string;
  position: { x: number; y: number };
  onClose: () => void;

  // Session metadata for conditional menu items
  isArchived?: boolean;
  isPinned?: boolean;
  isWorkstream?: boolean;
  isWorktreeSession?: boolean;
  parentSessionId?: string | null;
  phase?: string | null;

  // Optional callbacks - menu items only shown when callback is provided
  onRename?: () => void;
  onPinToggle?: (isPinned: boolean) => void;
  onBranch?: () => void;
  onRemoveFromWorkstream?: () => void;
  onArchive?: () => void;
  onUnarchive?: () => void;
  onDelete?: () => void;
  /** When part of a multiselect, how many items the action applies to */
  selectedCount?: number;
}

export const SessionContextMenu: React.FC<SessionContextMenuProps> = ({
  sessionId,
  title,
  position,
  onClose,
  isArchived = false,
  isPinned = false,
  isWorkstream = false,
  isWorktreeSession = false,
  parentSessionId = null,
  phase,
  onRename,
  onPinToggle,
  onBranch,
  onRemoveFromWorkstream,
  onArchive,
  onUnarchive,
  onDelete,
  selectedCount = 1,
}) => {
  const [showPhaseSubmenu, setShowPhaseSubmenu] = useState(false);
  const [submenuFlipped, setSubmenuFlipped] = useState(false);
  const submenuParentRef = useRef<HTMLDivElement>(null);
  const setSessionPhase = useSetAtom(setSessionPhaseAtom);
  const sessionRegistry = useAtomValue(sessionRegistryAtom);
  const targetSession = sessionRegistry.get(sessionId);

  // Share state
  const shareInfo = useAtomValue(sessionShareAtom(sessionId));
  const shareKeys = useAtomValue(shareKeysAtom);
  const removeShare = useSetAtom(removeSessionShareAtom);
  const reference = useMemo(() => virtualElement(position.x, position.y), [position.x, position.y]);
  const isDevMode = import.meta.env.DEV || window.IS_DEV_MODE;

  const menu = useFloatingMenu({
    placement: 'right-start',
    reference,
    open: true,
    onOpenChange: (open) => { if (!open) onClose(); },
  });

  const menuItemClass = 'session-context-menu-item flex items-center gap-2 w-full px-2.5 py-2 bg-transparent border-none rounded text-[var(--nim-text)] text-[0.8125rem] cursor-pointer text-left transition-colors duration-150 hover:bg-[var(--nim-bg-hover)] [&_svg]:shrink-0';

  const handleAction = useCallback((e: React.MouseEvent, action: () => void) => {
    e.stopPropagation();
    onClose();
    action();
  }, [onClose]);

  const handleCopySessionId = useCallback((e: React.MouseEvent) => {
    handleAction(e, () => copyToClipboard(sessionId));
  }, [handleAction, sessionId]);

  const handleExportHtml = useCallback((e: React.MouseEvent) => {
    handleAction(e, () => {
      (window as any).electronAPI?.exportSessionToHtml({ sessionId });
    });
  }, [handleAction, sessionId]);

  const handleCopyTranscript = useCallback((e: React.MouseEvent) => {
    handleAction(e, () => {
      (window as any).electronAPI?.exportSessionToClipboard({ sessionId });
    });
  }, [handleAction, sessionId]);

  const handleShareLink = useCallback((e: React.MouseEvent) => {
    handleAction(e, () => {
      dialogRef.current?.open<ShareDialogData>(DIALOG_IDS.SHARE, {
        contentType: 'session',
        sessionId,
        title,
      });
    });
  }, [handleAction, sessionId, title]);

  const handleCopyShareLink = useCallback((e: React.MouseEvent) => {
    handleAction(e, () => {
      if (shareInfo) {
        const url = buildShareUrl(shareInfo.shareId, shareKeys.get(sessionId));
        copyToClipboard(url);
        errorNotificationService.showInfo('Share link copied', 'The share link has been copied to your clipboard.', { duration: 3000 });
      }
    });
  }, [handleAction, shareInfo, shareKeys, sessionId]);

  const handleUnshare = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    onClose();
    if (!shareInfo) return;
    try {
      const result = await (window as any).electronAPI?.deleteShare({
        shareId: shareInfo.shareId,
        sessionId,
        owningPersonalOrgId: shareInfo.owningPersonalOrgId,
      });
      if (result?.success) {
        removeShare(sessionId);
        errorNotificationService.showInfo('Session unshared', 'The share link has been removed.', { duration: 3000 });
      } else if (result?.error) {
        errorNotificationService.showError('Unshare failed', result.error);
      }
    } catch (error) {
      errorNotificationService.showError('Unshare failed', error instanceof Error ? error.message : 'An unexpected error occurred');
    }
  }, [onClose, shareInfo, sessionId, removeShare]);

  const handleForceReparseSession = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    onClose();

    try {
      const result = await window.electronAPI.invoke('transcript:force-reparse-session', sessionId);
      if (result?.success) {
        errorNotificationService.showInfo(
          'Transcript reprocessed',
          'Canonical transcript events were rebuilt for this session.',
          { duration: 3000 },
        );
      } else {
        errorNotificationService.showError(
          'Failed to reprocess transcript',
          result?.error || 'An unexpected error occurred',
        );
      }
    } catch (error) {
      errorNotificationService.showError(
        'Failed to reprocess transcript',
        error instanceof Error ? error.message : 'An unexpected error occurred',
      );
    }
  }, [onClose, sessionId]);

  const handleAttentionSupervisorAuthorization = useCallback(async (
    e: React.MouseEvent,
    authorized: boolean,
  ) => {
    e.stopPropagation();
    onClose();
    const workspacePath = targetSession?.workspaceId;
    if (!workspacePath) {
      errorNotificationService.showError(
        'Attention supervisor update failed',
        'The target session workspace is unavailable.',
      );
      return;
    }

    try {
      const result = await requestAttentionSupervisorAuthorization({
        workspacePath,
        targetSessionId: sessionId,
        targetTitle: title,
        authorized,
      });
      if (result.cancelled) return;
      if (!result.success) {
        errorNotificationService.showError(
          'Attention supervisor update failed',
          result.error || 'The authorization was not changed.',
        );
        return;
      }
      errorNotificationService.showInfo(
        authorized ? 'Attention supervisor authorized' : 'Attention supervisor revoked',
        authorized
          ? 'The exact supervisor can now manage attention for this session.'
          : 'The exact supervisor can no longer manage attention for this session.',
        { duration: 4000 },
      );
    } catch (error) {
      errorNotificationService.showError(
        'Attention supervisor update failed',
        error instanceof Error ? error.message : 'An unexpected error occurred',
      );
    }
  }, [onClose, sessionId, targetSession?.workspaceId, title]);

  return (
    <FloatingPortal>
      <div
        ref={menu.refs.setFloating}
        style={menu.floatingStyles}
        {...menu.getFloatingProps()}
        className="session-context-menu z-[1000] min-w-[140px] p-1 bg-[var(--nim-bg)] border border-[var(--nim-border)] rounded-md shadow-[0_4px_12px_rgba(0,0,0,0.15)]"
        onClick={(e) => e.stopPropagation()}
        onMouseLeave={onClose}
      >
        {/* Group 1: Organize (most frequent) */}
        {onRename && (
          <button className={menuItemClass} onClick={(e) => handleAction(e, onRename)}>
            <MaterialSymbol icon="edit" size={14} />
            Rename
          </button>
        )}
        {onPinToggle && (
          <button className={menuItemClass} onClick={(e) => handleAction(e, () => onPinToggle(!isPinned))}>
            <MaterialSymbol icon="push_pin" size={14} />
            {isPinned ? 'Unpin' : 'Pin'}
          </button>
        )}
        {/* Set Phase submenu */}
        <div
          ref={submenuParentRef}
          className="relative"
          onMouseEnter={() => {
            // Check if submenu would overflow right edge
            if (submenuParentRef.current) {
              const rect = submenuParentRef.current.getBoundingClientRect();
              const submenuWidth = 150; // min-w-[140px] + padding
              setSubmenuFlipped(rect.right + submenuWidth > window.innerWidth);
            }
            setShowPhaseSubmenu(true);
          }}
          onMouseLeave={() => setShowPhaseSubmenu(false)}
        >
          <button
            className={menuItemClass}
            onClick={(e) => { e.stopPropagation(); setShowPhaseSubmenu(!showPhaseSubmenu); }}
          >
            <MaterialSymbol icon="view_kanban" size={14} />
            <span className="flex-1">Set Phase</span>
            {phase && (
              <span className="text-[10px] text-[var(--nim-text-faint)] ml-1">{phase}</span>
            )}
            <MaterialSymbol icon="chevron_right" size={12} />
          </button>
          {showPhaseSubmenu && (
            <div className={`absolute top-0 min-w-[140px] p-1 bg-[var(--nim-bg)] border border-[var(--nim-border)] rounded-md shadow-[0_4px_12px_rgba(0,0,0,0.15)] z-[1001] ${submenuFlipped ? 'right-full mr-0.5' : 'left-full ml-0.5'}`}>
              {SESSION_PHASE_COLUMNS.map((col) => (
                <button
                  key={col.value}
                  className={`session-context-menu-item flex items-center gap-2 w-full px-2.5 py-2 bg-transparent border-none rounded text-[0.8125rem] cursor-pointer text-left transition-colors duration-150 hover:bg-[var(--nim-bg-hover)] [&_svg]:shrink-0 ${phase === col.value ? 'text-[var(--nim-primary)]' : 'text-[var(--nim-text)]'}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onClose();
                    setSessionPhase({ sessionId, phase: col.value });
                  }}
                >
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: col.color }} />
                  {col.label}
                  {phase === col.value && <MaterialSymbol icon="check" size={14} className="ml-auto" />}
                </button>
              ))}
              {phase && (
                <>
                  <div className="h-px bg-[var(--nim-border)] my-1" />
                  <button
                    className="session-context-menu-item flex items-center gap-2 w-full px-2.5 py-2 bg-transparent border-none rounded text-[var(--nim-text-faint)] text-[0.8125rem] cursor-pointer text-left transition-colors duration-150 hover:bg-[var(--nim-bg-hover)] [&_svg]:shrink-0"
                    onClick={(e) => {
                      e.stopPropagation();
                      onClose();
                      window.electronAPI.invoke('sessions:update-session-metadata', sessionId, { phase: null });
                    }}
                  >
                    <MaterialSymbol icon="close" size={14} />
                    Remove from board
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        {/* Group 2: Branch / workstream actions */}
        {(onBranch || (onRemoveFromWorkstream && parentSessionId && !isWorktreeSession)) && (
          <div className="h-px bg-[var(--nim-border)] my-1" />
        )}
        {onBranch && (
          <button className={menuItemClass} onClick={(e) => handleAction(e, onBranch)}>
            <MaterialSymbol icon="fork_right" size={14} />
            Branch conversation
          </button>
        )}
        {onRemoveFromWorkstream && parentSessionId && !isWorktreeSession && (
          <button className={menuItemClass} onClick={(e) => handleAction(e, onRemoveFromWorkstream)}>
            <MaterialSymbol icon="drive_file_move_rtl" size={14} />
            Remove from workstream
          </button>
        )}

        {/* Group 3: Copy to clipboard */}
        <div className="h-px bg-[var(--nim-border)] my-1" />
        <button className={menuItemClass} onClick={handleCopyTranscript}>
          <MaterialSymbol icon="assignment" size={14} />
          Copy transcript
        </button>
        <button className={menuItemClass} onClick={handleCopySessionId}>
          <MaterialSymbol icon="content_copy" size={14} />
          Copy Session ID
        </button>

        {/* Explicit target-bound supervisor capability. The renderer only
            selects ids; main performs fresh native confirmation + validation. */}
        {selectedCount === 1 && (
          <>
            <div className="h-px bg-[var(--nim-border)] my-1" />
            <button
              className={menuItemClass}
              onClick={(e) => { void handleAttentionSupervisorAuthorization(e, true); }}
            >
              <MaterialSymbol icon="supervisor_account" size={14} />
              Authorize attention supervisor…
            </button>
            <button
              className={menuItemClass}
              onClick={(e) => { void handleAttentionSupervisorAuthorization(e, false); }}
            >
              <MaterialSymbol icon="person_remove" size={14} />
              Revoke attention supervisor…
            </button>
          </>
        )}

        {/* Group 4: Share / export */}
        <div className="h-px bg-[var(--nim-border)] my-1" />
        {shareInfo ? (
          <>
            <button className={menuItemClass} onClick={handleCopyShareLink}>
              <MaterialSymbol icon="content_copy" size={14} />
              Copy share link
            </button>
            <button className={menuItemClass} onClick={handleUnshare}>
              <MaterialSymbol icon="link_off" size={14} />
              Unshare
            </button>
          </>
        ) : (
          <button className={menuItemClass} onClick={handleShareLink}>
            <MaterialSymbol icon="link" size={14} />
            Share link
          </button>
        )}
        <button className={menuItemClass} onClick={handleExportHtml}>
          <MaterialSymbol icon="download" size={14} />
          Export as HTML
        </button>

        {isDevMode && (
          <>
            <div className="h-px bg-[var(--nim-border)] my-1" />
            <button className={menuItemClass} onClick={handleForceReparseSession}>
              <MaterialSymbol icon="sync" size={14} />
              Reprocess transcript
            </button>
          </>
        )}

        {/* Group 5: Destructive actions */}
        {(onArchive || onUnarchive || onDelete) && (
          <div className="h-px bg-[var(--nim-border)] my-1" />
        )}
        {(onArchive || onUnarchive) && (
          <button
            className={menuItemClass}
            onClick={(e) => handleAction(e, () => {
              if (isArchived && onUnarchive) onUnarchive();
              else if (!isArchived && onArchive) onArchive();
            })}
          >
            {isArchived ? (
              <>
                <MaterialSymbol icon="unarchive" size={14} />
                Unarchive {selectedCount > 1 ? `${selectedCount} Sessions` : isWorkstream ? 'Workstream' : isWorktreeSession ? 'Worktree' : 'Session'}
              </>
            ) : (
              <>
                <MaterialSymbol icon="archive" size={14} />
                Archive {selectedCount > 1 ? `${selectedCount} Sessions` : isWorkstream ? 'Workstream' : isWorktreeSession ? 'Worktree' : 'Session'}
              </>
            )}
          </button>
        )}
        {onDelete && (
          <button
            className="session-context-menu-item destructive flex items-center gap-2 w-full px-2.5 py-2 bg-transparent border-none rounded text-[var(--nim-error)] text-[0.8125rem] cursor-pointer text-left transition-colors duration-150 hover:bg-[var(--nim-error)] hover:text-white [&_svg]:shrink-0"
            onClick={(e) => handleAction(e, onDelete)}
          >
            <MaterialSymbol icon="delete" size={14} />
            Delete
          </button>
        )}
      </div>
    </FloatingPortal>
  );
};
