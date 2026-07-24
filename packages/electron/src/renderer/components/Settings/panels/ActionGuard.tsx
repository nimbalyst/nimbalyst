import React from 'react';

export function ActionGuard({
  allowed,
  reason,
  children,
}: {
  allowed: boolean;
  reason: string;
  children: React.ReactNode;
}) {
  return (
    <div className="action-guard" data-testid="action-guard" data-allowed={allowed ? 'true' : 'false'}>
      <div className={allowed ? '' : 'pointer-events-none opacity-50'} aria-disabled={!allowed}>
        {children}
      </div>
      {!allowed && <p className="m-0 mt-1 text-[11px] text-[var(--nim-text-faint)]">{reason}</p>}
    </div>
  );
}
