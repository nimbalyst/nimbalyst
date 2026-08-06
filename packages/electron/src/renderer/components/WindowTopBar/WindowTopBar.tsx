import React from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import { MAIN_WINDOW_TITLE_BAR_HEIGHT } from '../../../shared/windowChrome';
import { FloatingPortal, useFloatingMenu } from '../../hooks/useFloatingMenu';
import {
  setTrackerModeLayoutAtom,
  trackerModeDocumentItemIdAtom,
  trackerModeLayoutAtom,
} from '../../store/atoms/trackers';
import { orgInboxUnreadCountAtomFamily } from '../../store/atoms/teamInbox';
import { formatUnreadCount } from '../../store/projectWindowUnreadViewModel';
import { useProjectOrg } from '../../hooks/useProjectOrg';
import { TRACKER_DOCUMENT_PANEL_MODES } from '../TrackerMode/trackerDocumentPanelModes';
import { DRAG_REGION, NO_DRAG_REGION } from './dragRegion';
import { WindowMenuBar } from './WindowMenuBar';

export interface WindowTopBarGitStatus {
  branch: string;
  ahead: number;
  behind: number;
  hasUncommitted: boolean;
}

export interface WindowTopBarPanelControl {
  label: string;
  collapsed: boolean;
  onToggle: () => void;
  options?: WindowTopBarPanelOption[];
}

export interface WindowTopBarPanelOption {
  id: string;
  label: string;
  icon: string;
  selected: boolean;
  onSelect: () => void;
}

export interface WindowTopBarPanelControls {
  left?: WindowTopBarPanelControl;
  right?: WindowTopBarPanelControl;
}

export interface WindowTopBarGitActions {
  onPull: () => void;
  onPush: () => void;
  onOpenLog: () => void;
  onOpenExtensionSettings?: () => void;
  gitLogAvailable?: boolean;
  busyAction?: 'pull' | 'push' | null;
  feedback?: {
    kind: 'success' | 'error';
    message: string;
  } | null;
}

export interface WindowTopBarNewSessionControl {
  label: string;
  onCreate: () => void;
}

export interface WindowTopBarProps {
  workspaceName: string;
  activeModeLabel: string;
  gitStatus: WindowTopBarGitStatus | null;
  gitActions: WindowTopBarGitActions;
  panelControls?: WindowTopBarPanelControls;
  newSessionControl?: WindowTopBarNewSessionControl;
  /** Root project path, used to resolve which organization's inbox to open. */
  workspacePath?: string | null;
}

const GIT_FEEDBACK_MAX_LINES = 6;
const GIT_FEEDBACK_MAX_CHARS = 300;
const GIT_FEEDBACK_TOOLTIP_MAX_CHARS = 2000;

const FOCUS_RING =
  'focus-visible:[outline:2px_solid_var(--nim-border-focus)] focus-visible:[outline-offset:-2px]';
/** Shape shared by every control in the bar; colors are layered per variant. */
const CONTROL_BASE = `inline-flex items-center justify-center h-7 m-0 border-0 rounded-[5px] font-[inherit] cursor-pointer ${FOCUS_RING}`;
const CONTROL_GHOST = 'text-nim-muted bg-transparent hover:text-nim hover:bg-nim-hover';
const CONTROL_PRIMARY = 'text-nim-on-primary bg-nim-primary hover:bg-nim-primary-hover';
/**
 * Open panels tint primary, hover included. The hover pair is not redundant: a
 * bare `data-[collapsed=false]:` ties `hover:text-nim` on specificity, so which
 * one wins would come down to stylesheet order.
 */
const PANEL_OPEN_TINT =
  'data-[collapsed=false]:text-nim-primary data-[collapsed=false]:hover:text-nim-primary';
const MENU_SURFACE =
  'z-[10000] flex flex-col overflow-y-auto p-1 text-nim bg-nim-secondary border border-nim rounded-[7px] shadow-[0_8px_24px_color-mix(in_srgb,var(--nim-text)_16%,transparent)]';
const MENU_ITEM = `flex items-center gap-2 w-full min-h-[30px] px-2 py-[5px] text-left text-xs font-[inherit] text-nim bg-transparent border-0 rounded-[5px] cursor-pointer enabled:hover:bg-nim-hover disabled:text-nim-disabled disabled:cursor-not-allowed data-[selected=true]:text-nim-primary data-[selected=true]:bg-nim-selected [&>:last-child:not(:nth-child(2))]:ml-auto ${FOCUS_RING}`;
const GIT_DETAIL = 'flex-none text-[10px] whitespace-nowrap';

/**
 * Git failures can carry an entire pre-push hook log (tens of thousands of
 * characters). The menu is a dropdown, not a log viewer — clamp before render so
 * a long error can't blow out the menu's size.
 */
export function clampGitFeedbackMessage(
  message: string,
  maxLines = GIT_FEEDBACK_MAX_LINES,
  maxChars = GIT_FEEDBACK_MAX_CHARS,
): string {
  const lines = message.trim().split('\n');
  let clamped = lines.slice(0, maxLines).join('\n');
  let truncated = lines.length > maxLines;
  if (clamped.length > maxChars) {
    clamped = clamped.slice(0, maxChars).trimEnd();
    truncated = true;
  }
  return truncated ? `${clamped}…` : clamped;
}

/**
 * Entry point to the organization inbox, which lives in the org window.
 *
 * Present whenever the project belongs to an organization, not only when
 * something is unread — before this control the only ways in were a menu item
 * and a footer chip that appeared solely while unread was non-zero, so a user
 * with a quiet inbox had no way to find messaging at all. The count is scoped to
 * this project's organization so the badge never refers to an inbox outside the
 * org being worked in.
 */
function InboxButton({ workspacePath }: { workspacePath?: string | null }) {
  const { org: projectOrg } = useProjectOrg(workspacePath);
  const unreadCount = useAtomValue(
    orgInboxUnreadCountAtomFamily(projectOrg?.orgId ?? ''),
  );

  if (!projectOrg) return null;

  const label = unreadCount > 0 ? `Messages, ${unreadCount} unread` : 'Messages';

  return (
    <button
      type="button"
      className={`window-top-bar__inbox w-7 ${CONTROL_BASE} ${CONTROL_GHOST} ${NO_DRAG_REGION}`}
      data-testid="window-top-bar-inbox"
      aria-label={label}
      title="Open organization inbox"
      onClick={() => {
        void (window as { electronAPI?: any }).electronAPI?.team?.openManagementWindow?.({
          orgId: projectOrg.orgId,
          workspacePath: workspacePath ?? undefined,
        });
      }}
    >
      <span className="relative inline-flex items-center justify-center">
        <MaterialSymbol icon="inbox" size={18} />
        {unreadCount > 0 && (
          <span
            // Ringed in the bar's own background so the count stays legible
            // where it overlaps the glyph.
            className="window-top-bar__inbox-badge absolute -top-1.5 -right-2.5 min-w-[15px] rounded-full px-[3px] text-[9.5px] font-bold leading-[15px] text-white bg-nim-error shadow-[0_0_0_2px_var(--nim-bg-secondary)]"
            data-testid="window-top-bar-inbox-unread"
          >
            {formatUnreadCount(unreadCount)}
          </span>
        )}
      </span>
    </button>
  );
}

function PanelButton({
  side,
  control,
}: {
  side: 'left' | 'right';
  control: WindowTopBarPanelControl;
}) {
  const menu = useFloatingMenu({ placement: 'bottom-end' });
  const action = control.collapsed ? 'Show' : 'Hide';
  const dockIcon = side === 'left' ? 'dock_to_right' : 'dock_to_left';
  const selectedOption = control.options?.find((option) => option.selected);

  if (control.options) {
    const paneLabel = selectedOption ? `${control.label}: ${selectedOption.label}` : control.label;
    return (
      <>
        {/* Split control: the left half toggles visibility, the caret half picks
            which pane to show. A single button forced a two-step menu trip for
            the far more common "get it out of the way" action. */}
        <div
          className={`window-top-bar__panel-split inline-flex items-center h-7 rounded-[5px] ${NO_DRAG_REGION}`}
          data-collapsed={control.collapsed}
        >
          <button
            type="button"
            className={`window-top-bar__panel-button window-top-bar__panel-split-toggle group w-9 px-1.5 rounded-r-none ${CONTROL_BASE} ${CONTROL_GHOST} ${PANEL_OPEN_TINT} ${NO_DRAG_REGION}`}
            data-testid={`window-top-bar-${side}-pane`}
            data-collapsed={control.collapsed}
            aria-label={`${action} ${paneLabel}`}
            aria-pressed={!control.collapsed}
            title={`${action} ${paneLabel}`}
            onClick={control.onToggle}
          >
            <span className="relative inline-flex items-center justify-center">
              <MaterialSymbol icon={dockIcon} size={18} />
              {selectedOption && (
                <MaterialSymbol
                  className={
                    // Ringed in the bar's own background so the badge stays
                    // legible over the dock glyph's strokes.
                    'window-top-bar__panel-mode-badge absolute -right-1 -bottom-[3px] rounded-full text-nim bg-nim-secondary shadow-[0_0_0_1.5px_var(--nim-bg-secondary)] group-hover:bg-nim-hover group-hover:shadow-[0_0_0_1.5px_var(--nim-bg-hover)] group-data-[collapsed=false]:text-nim-primary'
                  }
                  icon={selectedOption.icon}
                  size={11}
                />
              )}
            </span>
          </button>
          <span
            className="window-top-bar__panel-split-divider flex-none w-px h-4 bg-[var(--nim-border)]"
            aria-hidden="true"
          />
          <button
            ref={menu.refs.setReference}
            {...menu.getReferenceProps()}
            type="button"
            className={`window-top-bar__panel-button window-top-bar__panel-split-caret w-7 px-1 rounded-l-none ${CONTROL_BASE} ${CONTROL_GHOST} ${PANEL_OPEN_TINT} ${NO_DRAG_REGION}`}
            data-testid={`window-top-bar-${side}-pane-menu-button`}
            data-collapsed={control.collapsed}
            aria-label={`Choose ${control.label}: ${selectedOption?.label ?? 'None'}`}
            aria-haspopup="menu"
            aria-expanded={menu.isOpen}
            title={`Choose ${control.label}`}
            onClick={() => menu.setIsOpen(!menu.isOpen)}
          >
            <MaterialSymbol icon="arrow_drop_down" size={16} />
          </button>
        </div>
        {menu.isOpen && (
          <FloatingPortal>
            <div
              ref={menu.refs.setFloating}
              style={menu.floatingStyles}
              {...menu.getFloatingProps()}
              className={`window-top-bar__menu min-w-[180px] max-w-[min(420px,calc(100vw-24px))] ${MENU_SURFACE} ${NO_DRAG_REGION}`}
              data-testid={`window-top-bar-${side}-pane-menu`}
            >
              {control.options.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  role="menuitem"
                  className={`window-top-bar__menu-item ${MENU_ITEM}`}
                  data-selected={option.selected}
                  onClick={() => {
                    option.onSelect();
                    menu.setIsOpen(false);
                  }}
                >
                  <MaterialSymbol icon={option.icon} size={17} />
                  <span>{option.label}</span>
                  {option.selected && (
                    <MaterialSymbol icon="check" size={16} />
                  )}
                </button>
              ))}
            </div>
          </FloatingPortal>
        )}
      </>
    );
  }

  return (
    <button
      type="button"
      className={`window-top-bar__panel-button w-9 px-1.5 ${CONTROL_BASE} ${CONTROL_GHOST} ${PANEL_OPEN_TINT} ${NO_DRAG_REGION}`}
      data-testid={`window-top-bar-${side}-pane`}
      data-collapsed={control.collapsed}
      aria-label={`${action} ${control.label}`}
      title={`${action} ${control.label}`}
      onClick={control.onToggle}
    >
      <MaterialSymbol icon={dockIcon} size={18} />
    </button>
  );
}

function GitStatusMenu({
  gitStatus,
  actions,
}: {
  gitStatus: WindowTopBarGitStatus | null;
  actions: WindowTopBarGitActions;
}) {
  const menu = useFloatingMenu({ placement: 'bottom-end' });
  const branchTitle = gitStatus
    ? [
        gitStatus.branch,
        gitStatus.hasUncommitted ? 'Modified' : null,
        gitStatus.ahead > 0 ? `${gitStatus.ahead} ahead` : null,
        gitStatus.behind > 0 ? `${gitStatus.behind} behind` : null,
      ].filter(Boolean).join(' · ')
    : 'Git unavailable';
  const busy = actions.busyAction != null;

  return (
    <>
      <button
        ref={menu.refs.setReference}
        {...menu.getReferenceProps()}
        type="button"
        className={`window-top-bar__git min-w-0 max-w-full gap-1.5 px-[7px] text-[11px] ${CONTROL_BASE} ${CONTROL_GHOST} ${NO_DRAG_REGION}`}
        data-testid="window-top-bar-git-status"
        data-state={gitStatus ? 'available' : 'unavailable'}
        title={branchTitle}
        aria-label={`Git actions: ${branchTitle}`}
        aria-haspopup="menu"
        aria-expanded={menu.isOpen}
        onClick={() => menu.setIsOpen(!menu.isOpen)}
      >
        <MaterialSymbol icon="account_tree" size={16} />
        {gitStatus ? (
          <>
            <span className="window-top-bar__branch min-w-0 overflow-hidden text-nim text-ellipsis whitespace-nowrap">
              {gitStatus.branch}
            </span>
            {gitStatus.hasUncommitted && (
              <span className={`window-top-bar__git-detail window-top-bar__dirty text-nim-warning ${GIT_DETAIL}`}>
                Modified
              </span>
            )}
            {gitStatus.ahead > 0 && (
              <span
                className={`window-top-bar__git-detail window-top-bar__git-count inline-flex items-center gap-px text-nim-faint ${GIT_DETAIL}`}
                title={`${gitStatus.ahead} ahead`}
                aria-label={`${gitStatus.ahead} ahead`}
              >
                <MaterialSymbol icon="arrow_upward" size={14} />
                {gitStatus.ahead}
              </span>
            )}
            {gitStatus.behind > 0 && (
              <span
                className={`window-top-bar__git-detail window-top-bar__git-count inline-flex items-center gap-px text-nim-faint ${GIT_DETAIL}`}
                title={`${gitStatus.behind} behind`}
                aria-label={`${gitStatus.behind} behind`}
              >
                <MaterialSymbol icon="arrow_downward" size={14} />
                {gitStatus.behind}
              </span>
            )}
          </>
        ) : (
          <span className={`window-top-bar__git-unavailable text-nim-faint ${GIT_DETAIL}`}>
            Git unavailable
          </span>
        )}
        <MaterialSymbol icon="arrow_drop_down" size={16} />
      </button>
      {menu.isOpen && (
        <FloatingPortal>
          <div
            ref={menu.refs.setFloating}
            style={menu.floatingStyles}
            {...menu.getFloatingProps()}
            className={`window-top-bar__menu window-top-bar__git-menu min-w-[210px] max-w-[min(420px,calc(100vw-24px))] ${MENU_SURFACE} ${NO_DRAG_REGION}`}
            data-testid="window-top-bar-git-menu"
          >
            <button
              type="button"
              role="menuitem"
              className={`window-top-bar__menu-item ${MENU_ITEM}`}
              disabled={!gitStatus || busy}
              onClick={actions.onPull}
            >
              <MaterialSymbol icon="arrow_downward" size={17} />
              <span>{actions.busyAction === 'pull' ? 'Pulling…' : 'Pull'}</span>
            </button>
            <button
              type="button"
              role="menuitem"
              className={`window-top-bar__menu-item ${MENU_ITEM}`}
              disabled={!gitStatus || busy}
              onClick={actions.onPush}
            >
              <MaterialSymbol icon="arrow_upward" size={17} />
              <span>{actions.busyAction === 'push' ? 'Pushing…' : 'Push'}</span>
            </button>
            <div className="window-top-bar__menu-separator h-px my-1 mx-0.5 bg-[var(--nim-border)]" />
            <button
              type="button"
              role="menuitem"
              className={`window-top-bar__menu-item ${MENU_ITEM}`}
              disabled={!gitStatus || actions.gitLogAvailable === false}
              onClick={actions.onOpenLog}
            >
              <MaterialSymbol icon="history" size={17} />
              <span>Open Git Log</span>
            </button>
            {actions.gitLogAvailable === false && actions.onOpenExtensionSettings && (
              <button
                type="button"
                role="menuitem"
                className={`window-top-bar__menu-item ${MENU_ITEM}`}
                onClick={() => {
                  actions.onOpenExtensionSettings?.();
                  menu.setIsOpen(false);
                }}
              >
                <MaterialSymbol icon="extension" size={17} />
                <span>Enable Git Extension…</span>
              </button>
            )}
            {actions.feedback && (
              <div
                className={`window-top-bar__git-feedback flex-none max-h-[132px] mt-1 mx-1 mb-0.5 p-1.5 overflow-y-auto border-t border-nim text-[11px] leading-[1.35] whitespace-pre-wrap [overflow-wrap:anywhere] ${
                  actions.feedback.kind === 'error' ? 'text-nim-error' : 'text-nim-muted'
                }`}
                data-testid="window-top-bar-git-feedback"
                data-kind={actions.feedback.kind}
                role={actions.feedback.kind === 'error' ? 'alert' : 'status'}
                title={clampGitFeedbackMessage(
                  actions.feedback.message,
                  Number.POSITIVE_INFINITY,
                  GIT_FEEDBACK_TOOLTIP_MAX_CHARS,
                )}
              >
                {clampGitFeedbackMessage(actions.feedback.message)}
              </div>
            )}
          </div>
        </FloatingPortal>
      )}
    </>
  );
}

export function WindowTopBar({
  workspaceName,
  activeModeLabel,
  gitStatus,
  gitActions,
  panelControls,
  newSessionControl,
  workspacePath,
}: WindowTopBarProps) {
  const trackerDocumentItemId = useAtomValue(trackerModeDocumentItemIdAtom);
  const trackerLayout = useAtomValue(trackerModeLayoutAtom);
  const setTrackerLayout = useSetAtom(setTrackerModeLayoutAtom);
  const trackerDocumentActive = activeModeLabel === 'Tracker' && trackerDocumentItemId !== null;
  const visiblePanelControls: WindowTopBarPanelControls | undefined = trackerDocumentActive
    ? {
        left: {
          label: 'Tracker list',
          collapsed: !trackerLayout.documentListPaneVisible,
          onToggle: () => {
            setTrackerLayout({
              documentListPaneVisible: !trackerLayout.documentListPaneVisible,
            });
          },
        },
        right: {
          label: 'Tracker document panel',
          collapsed: !trackerLayout.documentRightPanelVisible,
          onToggle: () => {
            setTrackerLayout({
              documentRightPanelVisible: !trackerLayout.documentRightPanelVisible,
            });
          },
          options: TRACKER_DOCUMENT_PANEL_MODES.map((option) => ({
            ...option,
            selected: trackerLayout.documentRightPanelMode === option.id,
            onSelect: () => {
              setTrackerLayout({
                documentRightPanelMode: option.id,
                documentRightPanelVisible: true,
              });
            },
          })),
        },
      }
    : panelControls;

  return (
    <header
      className={`window-top-bar relative flex-none overflow-hidden text-nim bg-nim-secondary border-b border-nim ${DRAG_REGION}`}
      data-component="WindowTopBar"
      data-testid="window-top-bar"
      style={{
        height: MAIN_WINDOW_TITLE_BAR_HEIGHT,
        minHeight: MAIN_WINDOW_TITLE_BAR_HEIGHT,
      }}
    >
      {/* The env() inset keeps the bar clear of the OS window controls: the
          traffic lights on macOS, the caption buttons on Windows. */}
      <div className="window-top-bar__available-area absolute top-0 bottom-0 left-[env(titlebar-area-x,0px)] w-[env(titlebar-area-width,100%)] box-border grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 pl-2 pr-3.5">
        {/* Windows/Linux only: macOS keeps the menu in the system menu bar and
            WindowMenuBar renders nothing there. */}
        <div className="window-top-bar__left flex items-center min-w-0 overflow-hidden">
          <WindowMenuBar />
        </div>

        <div className="window-top-bar__identity flex items-baseline justify-center gap-1.5 min-w-0 max-w-[min(42vw,520px)] whitespace-nowrap pointer-events-none">
          <span
            className="window-top-bar__workspace-name min-w-0 overflow-hidden text-ellipsis text-nim text-xs font-semibold"
            data-testid="window-top-bar-workspace-name"
            title={workspaceName}
          >
            {workspaceName}
          </span>
          <span className="window-top-bar__identity-separator text-nim-muted text-[11px]" aria-hidden="true">—</span>
          <span
            className="window-top-bar__mode-label min-w-0 overflow-hidden text-ellipsis text-nim-muted text-[11px]"
            data-testid="window-top-bar-mode-label"
          >
            {activeModeLabel}
          </span>
        </div>

        <div className="window-top-bar__right grid grid-cols-[minmax(0,1fr)_auto] items-center self-stretch min-w-0">
          {gitStatus && (
            <div
              className="window-top-bar__git-slot flex items-center justify-center min-w-0 overflow-hidden"
              data-testid="window-top-bar-git-slot"
            >
              <GitStatusMenu gitStatus={gitStatus} actions={gitActions} />
            </div>
          )}

          <div
            className="window-top-bar__right-actions flex items-center justify-end gap-1"
            data-testid="window-top-bar-right-actions"
          >
            <InboxButton workspacePath={workspacePath} />
            {newSessionControl && (
              <button
                type="button"
                className={`window-top-bar__new-session gap-[3px] px-2 text-[11px] font-semibold ${CONTROL_BASE} ${CONTROL_PRIMARY} ${NO_DRAG_REGION}`}
                data-testid="window-top-bar-new-session"
                title={newSessionControl.label}
                aria-label={newSessionControl.label}
                onClick={newSessionControl.onCreate}
              >
                <MaterialSymbol icon="add" size={17} />
                <span>New</span>
              </button>
            )}
            {visiblePanelControls?.left && (
              <PanelButton side="left" control={visiblePanelControls.left} />
            )}
            {visiblePanelControls?.right && (
              <PanelButton side="right" control={visiblePanelControls.right} />
            )}
          </div>
        </div>
      </div>
    </header>
  );
}
