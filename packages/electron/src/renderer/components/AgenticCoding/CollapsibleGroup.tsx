import React, { ReactNode } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';

interface CollapsibleGroupProps {
  title: string;
  isExpanded: boolean;
  onToggle: () => void;
  children: ReactNode;
  count?: number;
}

export const CollapsibleGroup: React.FC<CollapsibleGroupProps> = ({
  title,
  isExpanded,
  onToggle,
  children,
  count
}) => {
  return (
    <div className="collapsible-group mb-1">
      <button
        className="collapsible-group-header flex items-center gap-2 w-full py-2 px-3 bg-transparent border-none cursor-pointer text-xs font-semibold text-nim-muted text-left transition-colors duration-150 hover:bg-nim-hover"
        onClick={onToggle}
        aria-expanded={isExpanded}
        aria-label={`${title} group, ${isExpanded ? 'expanded' : 'collapsed'}`}
      >
        <MaterialSymbol
          icon="chevron_right"
          size={12}
          className={`collapsible-group-chevron shrink-0 text-nim-faint transition-transform duration-200 ${isExpanded ? 'rotate-90' : ''}`}
        />
        <span className="collapsible-group-title flex-1 overflow-hidden text-ellipsis whitespace-nowrap uppercase tracking-wide">{title}</span>
        {count !== undefined && (
          <span className="collapsible-group-count shrink-0 text-[0.625rem] text-nim-faint font-normal">{count}</span>
        )}
      </button>
      {isExpanded && (
        <div className="collapsible-group-content p-0 animate-slide-down">
          {children}
        </div>
      )}
    </div>
  );
};
