import React, { useMemo } from 'react';
import { FloatingFocusManager } from '@floating-ui/react';
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
  /** When provided, a "New Folder" item is appended below the file types. */
  onNewFolder?: () => void;
}

export function NewFileMenu({
  x,
  y,
  onSelect,
  onClose,
  extensionFileTypes = [],
  onNewFolder
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

  // Menu rows are focusable buttons (role="menuitem") so the menu is fully
  // keyboard-operable: FloatingFocusManager moves focus in on open, Tab/Shift+Tab
  // cycle the items, Enter/Space activate, and useDismiss handles Escape.
  const itemClass =
    'new-file-menu-item flex items-center gap-2.5 w-full py-2 px-3 rounded cursor-pointer transition-colors text-nim bg-transparent border-0 text-left hover:bg-nim-hover focus:bg-nim-hover focus:outline-none';

  return (
    <FloatingPortal>
      <FloatingFocusManager context={menu.context} modal={false} initialFocus={0}>
        <div
          ref={menu.refs.setFloating}
          style={menu.floatingStyles}
          {...menu.getFloatingProps()}
          className="new-file-menu bg-nim-secondary border border-nim rounded-md shadow-lg p-1 min-w-[180px] max-h-[min(70vh,480px)] overflow-y-auto z-[10000] text-[13px] backdrop-blur-[10px]"
        >
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              className={itemClass}
              onClick={() => handleSelect(item.fileType)}
            >
              <MaterialSymbol icon={item.icon} size={18} />
              <span>{item.label}</span>
            </button>
          ))}

          <div className="new-file-menu-separator h-px bg-[var(--nim-border)] mx-2 my-1" />

          {/* Arbitrary-extension escape hatch: prompts for the full filename. */}
          <button
            type="button"
            role="menuitem"
            className={itemClass}
            onClick={() => handleSelect('any')}
          >
            <MaterialSymbol icon="note_add" size={18} />
            <span>New File...</span>
          </button>

          {onNewFolder && (
            <button
              type="button"
              role="menuitem"
              className={`${itemClass} new-folder-menu-item`}
              onClick={() => { onNewFolder(); onClose(); }}
            >
              <MaterialSymbol icon="create_new_folder" size={18} />
              <span>New Folder</span>
            </button>
          )}
        </div>
      </FloatingFocusManager>
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
