/** One row of a shared-docs context menu: icon, label, an optional faint trailing note. */
import React from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';

export const CollabMenuButton: React.FC<{
  icon: string;
  label: string;
  trailing?: string;
  disabled?: boolean;
  danger?: boolean;
  /** Draws the icon filled (a set favorite star). */
  fill?: boolean;
  className?: string;
  title?: string;
  onClick: () => void;
}> = ({ icon, label, trailing, disabled, danger, fill, className, title, onClick }) => (
  <button
    type="button"
    className={`${className ?? ''} w-full flex items-center gap-2.5 px-3 py-1.5 rounded border-none bg-transparent cursor-pointer transition-colors text-left hover:bg-nim-hover disabled:opacity-50 disabled:cursor-not-allowed ${danger ? 'text-[var(--nim-error)]' : 'text-nim'}`}
    disabled={disabled}
    title={title}
    onClick={onClick}
  >
    <MaterialSymbol icon={icon} size={18} fill={fill} />
    <span className="flex-1">{label}</span>
    {trailing && <span className="ml-3 text-[11px] text-[var(--nim-text-faint)]">{trailing}</span>}
  </button>
);
