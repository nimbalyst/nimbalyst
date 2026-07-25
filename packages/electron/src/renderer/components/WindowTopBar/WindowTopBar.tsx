import React from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';
import { MAIN_WINDOW_TITLE_BAR_HEIGHT } from '../../../shared/windowChrome';
import { FloatingPortal, useFloatingMenu } from '../../hooks/useFloatingMenu';
import './WindowTopBar.css';

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
  const selectedOption = control.options?.find((option) => option.selected);

  if (control.options) {
    return (
      <>
        <button
          ref={menu.refs.setReference}
          {...menu.getReferenceProps()}
          type="button"
          className="window-top-bar__panel-button window-top-bar__panel-selector window-top-bar__no-drag"
          data-testid={`window-top-bar-${side}-pane`}
          data-collapsed={control.collapsed}
          aria-label={`Choose ${control.label}: ${selectedOption?.label ?? 'Hidden'}`}
          aria-haspopup="menu"
          aria-expanded={menu.isOpen}
          title={control.label}
          onClick={() => menu.setIsOpen(!menu.isOpen)}
        >
          <MaterialSymbol
            icon={side === 'left' ? 'dock_to_right' : 'dock_to_left'}
            size={18}
          />
          <MaterialSymbol icon="arrow_drop_down" size={16} />
        </button>
        {menu.isOpen && (
          <FloatingPortal>
            <div
              ref={menu.refs.setFloating}
              style={menu.floatingStyles}
              {...menu.getFloatingProps()}
              className="window-top-bar__menu window-top-bar__no-drag"
              data-testid={`window-top-bar-${side}-pane-menu`}
            >
              {control.options.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  role="menuitem"
                  className="window-top-bar__menu-item"
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
      className="window-top-bar__panel-button window-top-bar__no-drag"
      data-testid={`window-top-bar-${side}-pane`}
      data-collapsed={control.collapsed}
      aria-label={`${action} ${control.label}`}
      title={`${action} ${control.label}`}
      onClick={control.onToggle}
    >
      <MaterialSymbol
        icon={side === 'left' ? 'dock_to_right' : 'dock_to_left'}
        size={18}
      />
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
        className="window-top-bar__git window-top-bar__no-drag"
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
            <span className="window-top-bar__branch">{gitStatus.branch}</span>
            {gitStatus.hasUncommitted && (
              <span className="window-top-bar__git-detail window-top-bar__dirty">
                Modified
              </span>
            )}
            {gitStatus.ahead > 0 && (
              <span
                className="window-top-bar__git-detail window-top-bar__git-count"
                title={`${gitStatus.ahead} ahead`}
                aria-label={`${gitStatus.ahead} ahead`}
              >
                <MaterialSymbol icon="arrow_upward" size={14} />
                {gitStatus.ahead}
              </span>
            )}
            {gitStatus.behind > 0 && (
              <span
                className="window-top-bar__git-detail window-top-bar__git-count"
                title={`${gitStatus.behind} behind`}
                aria-label={`${gitStatus.behind} behind`}
              >
                <MaterialSymbol icon="arrow_downward" size={14} />
                {gitStatus.behind}
              </span>
            )}
          </>
        ) : (
          <span className="window-top-bar__git-unavailable">Git unavailable</span>
        )}
        <MaterialSymbol icon="arrow_drop_down" size={16} />
      </button>
      {menu.isOpen && (
        <FloatingPortal>
          <div
            ref={menu.refs.setFloating}
            style={menu.floatingStyles}
            {...menu.getFloatingProps()}
            className="window-top-bar__menu window-top-bar__git-menu window-top-bar__no-drag"
            data-testid="window-top-bar-git-menu"
          >
            <button
              type="button"
              role="menuitem"
              className="window-top-bar__menu-item"
              disabled={!gitStatus || busy}
              onClick={actions.onPull}
            >
              <MaterialSymbol icon="arrow_downward" size={17} />
              <span>{actions.busyAction === 'pull' ? 'Pulling…' : 'Pull'}</span>
            </button>
            <button
              type="button"
              role="menuitem"
              className="window-top-bar__menu-item"
              disabled={!gitStatus || busy}
              onClick={actions.onPush}
            >
              <MaterialSymbol icon="arrow_upward" size={17} />
              <span>{actions.busyAction === 'push' ? 'Pushing…' : 'Push'}</span>
            </button>
            <div className="window-top-bar__menu-separator" />
            <button
              type="button"
              role="menuitem"
              className="window-top-bar__menu-item"
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
                className="window-top-bar__menu-item"
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
                className="window-top-bar__git-feedback"
                data-kind={actions.feedback.kind}
                role={actions.feedback.kind === 'error' ? 'alert' : 'status'}
              >
                {actions.feedback.message}
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
}: WindowTopBarProps) {
  return (
    <header
      className="window-top-bar"
      data-component="WindowTopBar"
      data-testid="window-top-bar"
      style={{
        height: MAIN_WINDOW_TITLE_BAR_HEIGHT,
        minHeight: MAIN_WINDOW_TITLE_BAR_HEIGHT,
      }}
    >
      <div className="window-top-bar__available-area">
        <div className="window-top-bar__left" />

        <div className="window-top-bar__identity">
          <span
            className="window-top-bar__workspace-name"
            data-testid="window-top-bar-workspace-name"
            title={workspaceName}
          >
            {workspaceName}
          </span>
          <span className="window-top-bar__identity-separator" aria-hidden="true">—</span>
          <span
            className="window-top-bar__mode-label"
            data-testid="window-top-bar-mode-label"
          >
            {activeModeLabel}
          </span>
        </div>

        <div className="window-top-bar__right">
          {gitStatus && (
            <div
              className="window-top-bar__git-slot"
              data-testid="window-top-bar-git-slot"
            >
              <GitStatusMenu gitStatus={gitStatus} actions={gitActions} />
            </div>
          )}

          <div
            className="window-top-bar__right-actions"
            data-testid="window-top-bar-right-actions"
          >
            {newSessionControl && (
              <button
                type="button"
                className="window-top-bar__new-session window-top-bar__no-drag"
                data-testid="window-top-bar-new-session"
                title={newSessionControl.label}
                aria-label={newSessionControl.label}
                onClick={newSessionControl.onCreate}
              >
                <MaterialSymbol icon="add" size={17} />
                <span>New</span>
              </button>
            )}
            {panelControls?.left && (
              <PanelButton side="left" control={panelControls.left} />
            )}
            {panelControls?.right && (
              <PanelButton side="right" control={panelControls.right} />
            )}
          </div>
        </div>
      </div>
    </header>
  );
}
