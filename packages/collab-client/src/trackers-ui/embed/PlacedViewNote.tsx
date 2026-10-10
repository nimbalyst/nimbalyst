import type { JSX, ReactNode } from 'react';

/** What a placed view shows instead of itself: no project, no such type, or a host that cannot draw it. */
export function PlacedViewNote({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div
      className="placed-view-note my-3 rounded-lg border border-nim bg-nim-secondary px-3 py-2 text-xs text-nim-muted"
      contentEditable={false}
      data-testid="placed-view-note"
    >
      {children}
    </div>
  );
}
