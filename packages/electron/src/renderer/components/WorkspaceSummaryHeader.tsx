import React from 'react';
import {useAtomValue} from 'jotai';
import {selectedMachineAtom} from '../store/atoms/remoteMachines';
import {RemoteMachineSelector} from './RemoteMachineSelector';
import { getFileName } from '../utils/pathUtils';

import { generateWorkspaceAccentColor } from '../../shared/projectAppearance';
import { projectAppearanceAtom } from '../store/atoms/projectAppearance';
export { generateWorkspaceAccentColor } from '../../shared/projectAppearance';

interface WorkspaceSummaryHeaderProps {
  workspacePath: string;
  showMachineSelector?: boolean;
  workspaceName?: string;
  actions?: React.ReactNode;
  subtitle?: React.ReactNode;
  showAccent?: boolean;
  headerClassName?: string;
  actionsClassName?: string;
}

export function WorkspaceSummaryHeader({
  workspacePath,
  workspaceName,
  showMachineSelector = false,
  actions,
  subtitle,
  showAccent = true,
  headerClassName = '',
  actionsClassName = '',
}: WorkspaceSummaryHeaderProps) {
  const appearance = useAtomValue(projectAppearanceAtom(workspacePath)).snapshot?.appearance;
  const remoteHost = useAtomValue(selectedMachineAtom(workspacePath));
  const displayName = workspaceName || getFileName(workspacePath) || 'Workspace';

  return (
    <>
      {showAccent && (
        <div
          className="workspace-color-accent h-[3px] w-full opacity-90 shrink-0"
          style={{ backgroundColor: appearance?.color || generateWorkspaceAccentColor(workspacePath) }}
        />
      )}
      <div
        className={`workspace-summary-header px-3 pt-2.5 pb-2 border-b border-[var(--nim-border)] bg-[var(--nim-bg)] gap-2 min-h-14 shrink-0 ${headerClassName}`.trim()}
      >
        <div className="workspace-summary-header-top flex items-start gap-2">
          <div className="workspace-summary-header-title-row flex items-baseline gap-2.5 min-w-0 flex-1">
            <h3 className="workspace-summary-header-name m-0 text-[15px] font-bold text-[var(--nim-text)] overflow-hidden text-ellipsis whitespace-nowrap tracking-tight leading-tight">
              {displayName}
            </h3>
            {subtitle ? (
              <span className="workspace-summary-header-subtitle text-[13px] font-medium text-[var(--nim-text-muted)] opacity-70 whitespace-nowrap">
                {subtitle}
              </span>
            ) : null}
          </div>
          {actions ? (
            <div className={`workspace-summary-header-actions flex items-center gap-1.5 shrink-0 ${actionsClassName}`.trim()}>
              {actions}
            </div>
          ) : null}
        </div>
        {showMachineSelector && <RemoteMachineSelector workspacePath={workspacePath} />}
        <div
          className="workspace-summary-header-path mt-0.5 text-[11px] text-[var(--nim-text-muted)] overflow-hidden text-ellipsis whitespace-nowrap opacity-75 font-normal"
          title={workspacePath}
        >
          {showMachineSelector && remoteHost ? "Remote workspace" : workspacePath}
        </div>
      </div>
    </>
  );
}
