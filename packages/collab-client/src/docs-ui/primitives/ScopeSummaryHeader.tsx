import React from 'react';

function basename(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/\/$/, '');
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

export function generateScopeAccentColor(scopeKey: string): string {
  let hash = 0;
  for (let index = 0; index < scopeKey.length; index += 1) {
    hash = ((hash << 5) - hash) + scopeKey.charCodeAt(index);
    hash &= hash;
  }
  return `hsl(${Math.abs(hash) % 360}, 65%, 55%)`;
}

export interface ScopeSummaryHeaderProps {
  scopeKey: string;
  scopeName?: React.ReactNode;
  scopePath?: React.ReactNode;
  actions?: React.ReactNode;
  subtitle?: React.ReactNode;
  showAccent?: boolean;
  headerClassName?: string;
  actionsClassName?: string;
}

export function ScopeSummaryHeader({
  scopeKey,
  scopeName,
  scopePath,
  actions,
  subtitle,
  showAccent = true,
  headerClassName = '',
  actionsClassName = '',
}: ScopeSummaryHeaderProps) {
  const displayName = scopeName ?? (basename(scopeKey) || 'Shared Docs');
  return (
    <>
      {showAccent ? <div className="workspace-color-accent h-[3px] w-full opacity-90 shrink-0" style={{ backgroundColor: generateScopeAccentColor(scopeKey) }} /> : null}
      <div className={`workspace-summary-header px-3 pt-2.5 pb-2 border-b border-[var(--nim-border)] bg-[var(--nim-bg)] gap-2 min-h-14 shrink-0 ${headerClassName}`.trim()}>
        <div className="workspace-summary-header-top flex items-start gap-2">
          <div className="workspace-summary-header-title-row flex items-baseline gap-2.5 min-w-0 flex-1">
            <h3 className="workspace-summary-header-name m-0 text-[15px] font-bold text-[var(--nim-text)] overflow-hidden text-ellipsis whitespace-nowrap tracking-tight leading-tight">{displayName}</h3>
            {subtitle ? <span className="workspace-summary-header-subtitle text-[13px] font-medium text-[var(--nim-text-muted)] opacity-70 whitespace-nowrap">{subtitle}</span> : null}
          </div>
          {actions ? <div className={`workspace-summary-header-actions flex items-center gap-1.5 shrink-0 ${actionsClassName}`.trim()}>{actions}</div> : null}
        </div>
        <div className="workspace-summary-header-path mt-0.5 text-[11px] text-[var(--nim-text-muted)] overflow-hidden text-ellipsis whitespace-nowrap opacity-75 font-normal" title={scopeKey}>{scopePath ?? scopeKey}</div>
      </div>
    </>
  );
}
