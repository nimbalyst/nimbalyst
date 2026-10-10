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
import { windowFullScreenAtom } from '../../store/atoms/windowFullScreen';
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

/** One Git command the indicator knows is running right now. */
export interface WindowTopBarGitActivityEntry {
  id: string;
  /** Redacted, display-ready command text. */
  command: string;
  source: 'nimbalyst' | 'agent';
  sessionId?: string;
  /** The repository it runs in; set only in a workspace spanning several. */
  repoLabel?: string;
}

export interface WindowTopBarGitActivity {
  running: WindowTopBarGitActivityEntry[];
  latest: WindowTopBarGitActivityEntry | null;
}

/** One repository of a multi-root workspace, as the git menu lists it. */
export interface WindowTopBarGitRepo {
  path: string;
  /** Folder name, disambiguated with a parent segment when two collide. */
  label: string;
  /** Current branch, filled in when the menu opens. */
  branch?: string;
  /** A Git command is running in this repository. */
  busy?: boolean;
}

export interface WindowTopBarGitActions {
  onPull: () => void;
  onPush: () => void;
  onOpenLog: () => void;
  /**
   * Repositories this workspace spans. Fewer than two means an ordinary
   * single-repo project and the menu shows no repository section at all.
   */
  repos?: WindowTopBarGitRepo[];
  /** Repository the indicator is currently reporting on. */
  activeRepoPath?: string | null;
  /** Target a different repository; the indicator and pull/push follow it. */
  onSelectRepo?: (repoPath: string) => void;
  /** Fired when the menu opens, so per-repo branches are read only on demand. */
  onMenuOpen?: () => void;
  /** Open the Git Log panel on its Output tab. Falls back to `onOpenLog`. */
  onOpenActivity?: () => void;
  onOpenExtensionSettings?: () => void;
  gitLogAvailable?: boolean;
  busyAction?: 'pull' | 'push' | null;
  /**
   * Foreground Git activity projected from the main-process journal, covering
   * commands this window did not start (Git panel, agent sessions).
   */
  activity?: WindowTopBarGitActivity;
  feedback?: {
    kind: 'success' | 'error';
    message: string;
  } | null;
}

export interface WindowTopBarCreateMenuItem {
  id: string;
  label: string;
  icon: string;
  onSelect: () => void;
  disabled?: boolean;
  /** Tooltip explaining why the item is unavailable. */
  disabledReason?: string;
  /** Draws a divider above this item, for grouping types vs. containers. */
  separatorBefore?: boolean;
  /** Preserves the testid of a sidebar control this item replaced. */
  testId?: string;
  /** Right-aligned hint: keyboard shortcut, or the extension a type produces. */
  trailing?: string;
}

export interface WindowTopBarCreateControl {
  /**
   * Names the noun this control makes ("New file", "New session"). The bar's
   * two create controls are told apart by position and label, never by mode
   * memory, so a bare "New" is not a valid label here.
   */
  label: string;
  /**
   * Receives the button element so a mode that already owns a correct type
   * menu (Shared Docs) can anchor it here instead of the list rebuilding it.
   */
  onCreate: (anchor?: HTMLElement | null) => void;
  /** Where the new thing lands, surfaced at the top of the menu. */
  destination?: string | null;
  /** Optional section header above the type list, e.g. "Shared with team". */
  menuHeading?: { label: string; icon: string };
  /**
   * Type variants within the same destination. When present the control renders
   * as a split button; the first entry is generated from `label`/`onCreate` so
   * the visible label and menu item #1 cannot disagree.
   */
  menuItems?: WindowTopBarCreateMenuItem[];
  /** Icon for the mirrored primary entry in the menu. Default: description. */
  primaryIcon?: string;
  /** Preserves the testid of a sidebar trigger this caret replaced. */
  menuTestId?: string;
  /** Right-aligned hint on the mirrored primary entry. */
  primaryTrailing?: string;
}

/** @deprecated Use {@link WindowTopBarCreateControl}. */
export type WindowTopBarNewSessionControl = WindowTopBarCreateControl;

export interface WindowTopBarProps {
  workspaceName: string;
  activeModeLabel: string;
  gitStatus: WindowTopBarGitStatus | null;
  gitActions: WindowTopBarGitActions;
  panelControls?: WindowTopBarPanelControls;
  /** Right end of the bar. Starts a session; identical in every mode. */
  newSessionControl?: WindowTopBarCreateControl;
  /** Left end of the bar, over the tree column. Makes a thing in that tree. */
  newInTreeControl?: WindowTopBarCreateControl;
}

const GIT_FEEDBACK_MAX_LINES = 6;
const GIT_FEEDBACK_MAX_CHARS = 300;
const GIT_FEEDBACK_TOOLTIP_MAX_CHARS = 2000;
/**
 * The title bar shares one row with the workspace name and the panel controls,
 * so an agent's chained shell command has to be cut short here. The untruncated
 * (still redacted) text stays in the tooltip and the Output tab.
 */
const GIT_ACTIVITY_LABEL_MAX_CHARS = 28;

const FOCUS_RING =
  'focus-visible:[outline:2px_solid_var(--nim-border-focus)] focus-visible:[outline-offset:-2px]';
/** Shape shared by every control in the bar; colors are layered per variant. */
const CONTROL_BASE = `inline-flex items-center justify-center h-7 m-0 border-0 rounded-[5px] font-[inherit] cursor-pointer ${FOCUS_RING}`;
const CONTROL_GHOST = 'text-nim-muted bg-transparent hover:text-nim hover:bg-nim-hover';
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

/** Collapse a command to one clipped line; multi-line shell text renders as one. */
export function clampGitActivityCommand(
  command: string,
  maxChars = GIT_ACTIVITY_LABEL_MAX_CHARS,
): string {
  const single = command.trim().replace(/\s+/g, ' ');
  return single.length > maxChars ? `${single.slice(0, maxChars).trimEnd()}…` : single;
}

/**
 * Full-length description for the tooltip and menu row. Attribution comes first
 * because "who started this" is the question the menu bar cannot otherwise
 * answer -- a `git fetch` an agent launched looks identical to one the user did.
 */
export function describeGitActivityEntry(entry: WindowTopBarGitActivityEntry): string {
  const prefix = entry.source === 'agent' ? 'Agent session' : 'Nimbalyst';
  const where = entry.repoLabel ? ` in ${entry.repoLabel}` : '';
  return `${prefix}: ${entry.command.trim().replace(/\s+/g, ' ')}${where}`;
}

/** The tooltip line for the indicator: the newest command plus how many others. */
export function describeGitActivity(activity: WindowTopBarGitActivity | undefined): string | null {
  const latest = activity?.latest;
  if (!latest) return null;
  const others = Math.max(0, (activity?.running.length ?? 0) - 1);
  const suffix = others > 0 ? ` (+${others} more running)` : '';
  return `${describeGitActivityEntry(latest)}${suffix}`;
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
  const activityDescription = describeGitActivity(actions.activity);
  const branchTitle = gitStatus
    ? [
        gitStatus.branch,
        gitStatus.hasUncommitted ? 'Modified' : null,
        gitStatus.ahead > 0 ? `${gitStatus.ahead} ahead` : null,
        gitStatus.behind > 0 ? `${gitStatus.behind} behind` : null,
        activityDescription,
      ].filter(Boolean).join(' · ')
    : 'Git unavailable';
  // Only this window's own pull/push blocks the menu's actions. Observing an
  // agent's `git status` must not lock the user out of their own Git commands.
  const busy = actions.busyAction != null;
  const runningActivity = actions.activity?.running ?? [];
  const latestActivity = actions.activity?.latest ?? null;
  const additionalRunning = Math.max(0, runningActivity.length - 1);
  // Only a workspace spanning repos gets a repository section; a single-folder
  // project's menu is byte-identical to what it was before multi-root.
  const repos = actions.repos ?? [];
  const showRepos = repos.length > 1;

  const openMenu = () => {
    if (!menu.isOpen) actions.onMenuOpen?.();
    menu.setIsOpen(!menu.isOpen);
  };

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
        onClick={openMenu}
      >
        <MaterialSymbol icon="account_tree" size={16} />
        {showRepos && (
          <span
            className="window-top-bar__git-repo min-w-0 shrink-0 overflow-hidden text-nim-muted text-ellipsis whitespace-nowrap"
            data-testid="window-top-bar-git-repo"
          >
            {repos.find(repo => repo.path === actions.activeRepoPath)?.label ?? ''}
          </span>
        )}
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
        {/* Additive: branch and counts above stay put so the indicator does not
            reflow every time a background-ish command starts and stops. */}
        {latestActivity && (
          <span
            className="window-top-bar__git-activity inline-flex items-center gap-1 min-w-0 text-nim-muted"
            data-testid="window-top-bar-git-activity"
            data-source={latestActivity.source}
            role="status"
          >
            <MaterialSymbol icon="progress_activity" size={13} className="animate-spin" />
            <span className={`window-top-bar__git-activity-command min-w-0 overflow-hidden text-ellipsis ${GIT_DETAIL}`}>
              {clampGitActivityCommand(latestActivity.command)}
            </span>
            {additionalRunning > 0 && (
              <span
                className={`window-top-bar__git-activity-more text-nim-faint ${GIT_DETAIL}`}
                data-testid="window-top-bar-git-activity-more"
              >
                +{additionalRunning}
              </span>
            )}
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
            {showRepos && (
              <>
                <div className="window-top-bar__menu-heading px-2 pt-1 pb-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-nim-faint">
                  Repositories
                </div>
                {repos.map((repo) => (
                  <button
                    key={repo.path}
                    type="button"
                    role="menuitemradio"
                    aria-checked={repo.path === actions.activeRepoPath}
                    className={`window-top-bar__menu-item window-top-bar__git-repo-item ${MENU_ITEM}`}
                    data-testid="window-top-bar-git-repo-item"
                    data-busy={repo.busy ? 'true' : undefined}
                    title={repo.path}
                    onClick={() => {
                      actions.onSelectRepo?.(repo.path);
                      menu.setIsOpen(false);
                    }}
                  >
                    {repo.busy ? (
                      <MaterialSymbol icon="progress_activity" size={17} className="animate-spin" />
                    ) : (
                      <MaterialSymbol
                        icon={repo.path === actions.activeRepoPath ? 'check' : 'folder'}
                        size={17}
                      />
                    )}
                    <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                      {repo.label}
                    </span>
                    {repo.branch && (
                      <span className="shrink-0 text-[11px] text-nim-faint">{repo.branch}</span>
                    )}
                  </button>
                ))}
                <div className="window-top-bar__menu-separator h-px my-1 mx-0.5 bg-[var(--nim-border)]" />
              </>
            )}
            {runningActivity.length > 0 && (
              <>
                {runningActivity.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    role="menuitem"
                    className={`window-top-bar__menu-item window-top-bar__git-activity-item ${MENU_ITEM}`}
                    data-testid="window-top-bar-git-activity-item"
                    data-source={entry.source}
                    disabled={actions.gitLogAvailable === false}
                    title={describeGitActivityEntry(entry)}
                    onClick={() => {
                      (actions.onOpenActivity ?? actions.onOpenLog)();
                      menu.setIsOpen(false);
                    }}
                  >
                    <MaterialSymbol icon="progress_activity" size={17} className="animate-spin" />
                    <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
                      {describeGitActivityEntry(entry)}
                    </span>
                  </button>
                ))}
                <div className="window-top-bar__menu-separator h-px my-1 mx-0.5 bg-[var(--nim-border)]" />
              </>
            )}
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

/**
 * The way back out of fullscreen.
 *
 * Fullscreen removes the OS window controls, and the traffic lights the macOS
 * title-bar accessory would reveal are not reachable while the window carries a
 * custom traffic-light position. Without this the only exits are the menu bar
 * and the accelerator, so the window reads as stuck.
 */
/**
 * The bar's create control, used at both ends.
 *
 * Both ends get the same quiet, chrome-weight treatment on purpose: they are
 * peers in a chrome bar, and a saturated primary pill here competes with the
 * editor for attention. Asymmetry between them would read as a mistake rather
 * than as meaning — the left/right split already carries the meaning.
 */
function CreateSplitButton({
  control,
  side,
}: {
  control: WindowTopBarCreateControl;
  side: 'left' | 'right';
}) {
  const menu = useFloatingMenu({ placement: side === 'left' ? 'bottom-start' : 'bottom-end' });
  const hasMenu = Boolean(control.menuItems && control.menuItems.length > 0);
  const primaryRef = React.useRef<HTMLButtonElement>(null);

  const primaryButton = (
    <button
      ref={primaryRef}
      type="button"
      className={`window-top-bar__create-primary gap-[3px] px-2 text-[11px] font-semibold ${
        hasMenu ? 'rounded-r-none' : ''
      } ${CONTROL_BASE} ${CONTROL_GHOST} ${NO_DRAG_REGION}`}
      data-testid={`window-top-bar-create-${side}`}
      title={control.label}
      aria-label={control.label}
      onClick={() => control.onCreate(primaryRef.current)}
    >
      <MaterialSymbol icon="add" size={17} />
      <span>{control.label}</span>
    </button>
  );

  if (!hasMenu) {
    return (
      <div
        className={`window-top-bar__create inline-flex items-center h-7 rounded-[5px] ${NO_DRAG_REGION}`}
        data-side={side}
      >
        {primaryButton}
      </div>
    );
  }

  return (
    <>
      <div
        className={`window-top-bar__create window-top-bar__create-split inline-flex items-center h-7 rounded-[5px] ${NO_DRAG_REGION}`}
        data-side={side}
      >
        {primaryButton}
        <span
          className="window-top-bar__create-split-divider flex-none w-px h-4 bg-[var(--nim-border)]"
          aria-hidden="true"
        />
        <button
          ref={menu.refs.setReference}
          {...menu.getReferenceProps()}
          type="button"
          className={`window-top-bar__create-caret w-6 px-1 rounded-l-none ${CONTROL_BASE} ${CONTROL_GHOST} ${NO_DRAG_REGION}`}
          data-testid={control.menuTestId ?? `window-top-bar-create-${side}-menu-button`}
          aria-label={`Choose what to create: ${control.label}`}
          aria-haspopup="menu"
          aria-expanded={menu.isOpen}
          title="Choose what to create"
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
            className={`window-top-bar__menu window-top-bar__create-menu min-w-[220px] max-w-[min(420px,calc(100vw-24px))] ${MENU_SURFACE} ${NO_DRAG_REGION}`}
            data-testid={`window-top-bar-create-${side}-menu`}
          >
            {control.destination && (
              <div
                className="window-top-bar__create-destination flex items-center gap-1.5 px-2 py-1.5 mb-0.5 text-[10px] text-nim-faint border-b border-nim"
                data-testid={`window-top-bar-create-${side}-destination`}
              >
                <MaterialSymbol icon="folder_open" size={13} />
                <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
                  in {control.destination}
                </span>
              </div>
            )}
            {control.menuHeading && (
              <div className="window-top-bar__create-heading flex items-center gap-1.5 px-2 pt-1.5 pb-1 text-[10px] font-semibold uppercase tracking-wide text-nim-muted">
                <MaterialSymbol icon={control.menuHeading.icon} size={13} />
                <span>{control.menuHeading.label}</span>
              </div>
            )}
            {/* Menu item #1 is generated from the button's own label and
                handler, not authored separately. The split-button contract is
                that the visible label and the first entry are the same action;
                deriving it is the only way that cannot rot. */}
            <button
              type="button"
              role="menuitem"
              className={`window-top-bar__menu-item ${MENU_ITEM}`}
              data-selected={true}
              data-testid={`window-top-bar-create-${side}-menu-primary`}
              onClick={() => {
                control.onCreate(primaryRef.current);
                menu.setIsOpen(false);
              }}
            >
              <MaterialSymbol icon={control.primaryIcon ?? 'description'} size={17} />
              <span>{control.label}</span>
              {control.primaryTrailing && (
                <span className="window-top-bar__menu-hint flex-none text-[11px] text-nim-muted opacity-70">
                  {control.primaryTrailing}
                </span>
              )}
            </button>
            {control.menuItems!.map((item) => (
              <React.Fragment key={item.id}>
                {item.separatorBefore && (
                  <span
                    className="window-top-bar__create-menu-divider flex-none h-px my-1 mx-1.5 bg-[var(--nim-border)]"
                    aria-hidden="true"
                  />
                )}
                <button
                  type="button"
                  role="menuitem"
                  className={`window-top-bar__menu-item ${MENU_ITEM}`}
                  data-testid={item.testId}
                  disabled={item.disabled}
                  title={item.disabled ? item.disabledReason : undefined}
                  onClick={() => {
                    item.onSelect();
                    menu.setIsOpen(false);
                  }}
                >
                  <MaterialSymbol icon={item.icon} size={17} />
                  <span>{item.label}</span>
                  {item.trailing && (
                    <span className="window-top-bar__menu-hint flex-none text-[11px] text-nim-muted opacity-70">
                      {item.trailing}
                    </span>
                  )}
                </button>
              </React.Fragment>
            ))}
          </div>
        </FloatingPortal>
      )}
    </>
  );
}

function ExitFullScreenButton() {
  const fullScreen = useAtomValue(windowFullScreenAtom);
  if (!fullScreen) return null;

  return (
    <button
      type="button"
      className={`window-top-bar__exit-full-screen px-1.5 ${CONTROL_BASE} ${CONTROL_GHOST} ${NO_DRAG_REGION}`}
      data-testid="window-top-bar-exit-full-screen"
      title="Exit Full Screen"
      aria-label="Exit Full Screen"
      onClick={() => window.electronAPI?.exitWindowFullScreen?.()}
    >
      <MaterialSymbol icon="fullscreen_exit" size={18} />
    </button>
  );
}

export function WindowTopBar({
  workspaceName,
  activeModeLabel,
  gitStatus,
  gitActions,
  panelControls,
  newSessionControl,
  newInTreeControl,
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
        {/* The exit-fullscreen control takes the space the OS window controls
            vacate. WindowMenuBar is Windows/Linux only — macOS keeps the menu in
            the system menu bar and it renders nothing there. */}
        <div className="window-top-bar__left flex items-center gap-1 min-w-0 overflow-hidden">
          <ExitFullScreenButton />
          <WindowMenuBar />
          {/* Sits over the tree column, so what it makes is whatever that tree
              is made of. Absent in modes with no tree of creatable things. */}
          {newInTreeControl && <CreateSplitButton control={newInTreeControl} side="left" />}
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
            {newSessionControl && (
              <CreateSplitButton control={newSessionControl} side="right" />
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
