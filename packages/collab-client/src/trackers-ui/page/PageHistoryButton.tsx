/** The "Page history" control at the end of a typed page's or type page's crumb row. */
import React from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';

export const PageHistoryButton: React.FC<{ onClick: () => void }> = ({ onClick }) => (
  <button
    type="button"
    className="page-history-button flex shrink-0 items-center rounded border-none bg-transparent px-1.5 py-0.5 text-nim-faint cursor-pointer hover:bg-nim-hover hover:text-nim"
    title="Page history"
    aria-label="Page history"
    onClick={onClick}
    data-testid="page-history-button"
  >
    <MaterialSymbol icon="history" size={15} />
  </button>
);
