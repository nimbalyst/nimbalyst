import React, { useMemo } from 'react';
import { MaterialSymbol, type NewFileMenuContribution } from '@nimbalyst/runtime';
import { useFloatingMenu, FloatingPortal, virtualElement } from '../hooks/useFloatingMenu';

// Built-in file types
export type BuiltInFileType = 'markdown' | 'mockup' | 'any';

// File type can be built-in or an extension-provided type (by extension string)
export type NewFileType = BuiltInFileType | string;

export interface ExtensionFileType {
  extension: string;
  displayName: string;
  icon: string;
  defaultContent?: string;
  /** 'createFile' (default) writes a file; 'openVirtualTab' opens a fileless tab. */
  action?: 'createFile' | 'openVirtualTab';
  /** For 'openVirtualTab': the virtual:// prefix to open. */
  virtualScheme?: string;
}

interface NewFileMenuProps {
  x: number;
  y: number;
  onSelect: (fileType: NewFileType) => void;
  onClose: () => void;
  /** Extension-contributed file types */
  extensionFileTypes?: ExtensionFileType[];
}

export function NewFileMenu({
  x,
  y,
  onSelect,
  onClose,
  extensionFileTypes = []
}: NewFileMenuProps) {
  const reference = useMemo(() => virtualElement(x, y), [x, y]);
  const menu = useFloatingMenu({
    placement: 'right-start',
    reference,
    open: true,
    onOpenChange: (open) => { if (!open) onClose(); },
  });

  const handleSelect = (fileType: NewFileType) => {
    onSelect(fileType);
    onClose();
  };

  return (
    <FloatingPortal>
      <div
        ref={menu.refs.setFloating}
        style={menu.floatingStyles}
        {...menu.getFloatingProps()}
        className="new-file-menu bg-nim-secondary border border-nim rounded-md shadow-lg p-1 min-w-[180px] z-[10000] text-[13px] backdrop-blur-[10px]"
      >
        <div
          className="new-file-menu-item flex items-center gap-2.5 py-2 px-3 rounded cursor-pointer transition-colors text-nim hover:bg-nim-hover"
          onClick={() => handleSelect('markdown')}
        >
          <MaterialSymbol icon="description" size={18} />
          <span>New Markdown File</span>
        </div>

        <div
          className="new-file-menu-item flex items-center gap-2.5 py-2 px-3 rounded cursor-pointer transition-colors text-nim hover:bg-nim-hover"
          onClick={() => handleSelect('mockup')}
        >
          <MaterialSymbol icon="web" size={18} />
          <span>New Mockup</span>
        </div>

        {/* Extension-contributed file types */}
        {extensionFileTypes.map((extType) => (
          <div
            key={extType.extension}
            className="new-file-menu-item flex items-center gap-2.5 py-2 px-3 rounded cursor-pointer transition-colors text-nim hover:bg-nim-hover"
            onClick={() => handleSelect(`ext:${extType.extension}`)}
          >
            <MaterialSymbol icon={extType.icon} size={18} />
            <span>New {extType.displayName}</span>
          </div>
        ))}

        <div className="new-file-menu-separator h-px bg-[var(--nim-border)] mx-2 my-1" />

        <div
          className="new-file-menu-item flex items-center gap-2.5 py-2 px-3 rounded cursor-pointer transition-colors text-nim hover:bg-nim-hover"
          onClick={() => handleSelect('any')}
        >
          <MaterialSymbol icon="note_add" size={18} />
          <span>New File...</span>
        </div>
      </div>
    </FloatingPortal>
  );
}

/**
 * Convert NewFileMenuContribution from extension to ExtensionFileType
 */
export function contributionToExtensionFileType(
  contribution: NewFileMenuContribution
): ExtensionFileType {
  return {
    extension: contribution.extension,
    displayName: contribution.displayName,
    icon: contribution.icon,
    defaultContent: contribution.defaultContent,
    action: contribution.action,
    virtualScheme: contribution.virtualScheme,
  };
}
