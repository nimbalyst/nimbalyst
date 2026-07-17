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

  // Markdown is pinned to the top; every other file type is listed
  // alphabetically. Labels drop the "New " prefix — the menu title already
  // implies "new", so we just name the file type.
  const items = useMemo(() => {
    const rest: { key: string; label: string; icon: string; fileType: NewFileType }[] = [
      // NOTE: Mockup is not listed here — it's contributed by the mockuplm
      // extension's newFileMenu (.mockup.html). A hardcoded built-in entry
      // here would duplicate it.
      ...extensionFileTypes.map((extType) => ({
        key: `ext:${extType.extension}`,
        label: extType.displayName,
        icon: extType.icon,
        fileType: `ext:${extType.extension}` as NewFileType,
      })),
    ];
    rest.sort((a, b) => a.label.localeCompare(b.label));
    return [
      { key: 'markdown', label: 'Markdown File', icon: 'description', fileType: 'markdown' as NewFileType },
      ...rest,
    ];
  }, [extensionFileTypes]);

  return (
    <FloatingPortal>
      <div
        ref={menu.refs.setFloating}
        style={menu.floatingStyles}
        {...menu.getFloatingProps()}
        className="new-file-menu bg-nim-secondary border border-nim rounded-md shadow-lg p-1 min-w-[180px] max-h-[min(70vh,480px)] overflow-y-auto z-[10000] text-[13px] backdrop-blur-[10px]"
      >
        {items.map((item) => (
          <div
            key={item.key}
            className="new-file-menu-item flex items-center gap-2.5 py-2 px-3 rounded cursor-pointer transition-colors text-nim hover:bg-nim-hover"
            onClick={() => handleSelect(item.fileType)}
          >
            <MaterialSymbol icon={item.icon} size={18} />
            <span>{item.label}</span>
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
