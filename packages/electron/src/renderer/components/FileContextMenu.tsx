import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useSetAtom } from 'jotai';
import { MaterialSymbol } from '@nimbalyst/runtime';
import type { NewFileType, ExtensionFileType } from './NewFileMenu';
import { CommonFileActions } from './CommonFileActions';
import { useFloatingMenu, FloatingPortal, virtualElement } from '../hooks/useFloatingMenu';
import { historyDialogFileAtom } from '../store';

interface FileContextMenuProps {
  x: number;
  y: number;
  filePath: string;
  fileName: string;
  fileType: 'file' | 'directory';
  onClose: () => void;
  onRename: (filePath: string, newName: string) => void;
  onDelete: (filePath: string) => void;
  onDeleteMultiple?: (filePaths: string[]) => void;
  onNewFile?: (folderPath: string, fileType: NewFileType) => void;
  onNewFolder?: (folderPath: string) => void;
  onViewWorkspaceHistory?: (folderPath: string) => void;
  selectedPaths?: Set<string>;
  /** Extension-contributed file types */
  extensionFileTypes?: ExtensionFileType[];
}

export function FileContextMenu({
  x,
  y,
  filePath,
  fileName,
  fileType,
  onClose,
  onRename,
  onDelete,
  onDeleteMultiple,
  onNewFile,
  onNewFolder,
  onViewWorkspaceHistory,
  selectedPaths,
  extensionFileTypes = []
}: FileContextMenuProps) {
  const openHistoryDialog = useSetAtom(historyDialogFileAtom);
  const [isRenaming, setIsRenaming] = useState(false);
  const [newName, setNewName] = useState(fileName);
  const inputRef = useRef<HTMLInputElement>(null);
  const reference = useMemo(() => virtualElement(x, y), [x, y]);

  const menu = useFloatingMenu({
    placement: 'right-start',
    reference,
    open: true,
    onOpenChange: (open) => {
      if (!open && !isRenaming) onClose();
    },
  });

  useEffect(() => {
    if (isRenaming && inputRef.current) {
      inputRef.current.focus();
      // Select filename without extension for files
      if (fileType === 'file') {
        const lastDotIndex = fileName.lastIndexOf('.');
        if (lastDotIndex > 0) {
          inputRef.current.setSelectionRange(0, lastDotIndex);
        } else {
          inputRef.current.select();
        }
      } else {
        inputRef.current.select();
      }
    }
  }, [isRenaming]); // Only run when isRenaming changes, not when typing

  const handleRenameClick = () => {
    setIsRenaming(true);
  };

  const handleRenameSubmit = () => {
    if (newName && newName !== fileName) {
      onRename(filePath, newName);
    }
    setIsRenaming(false);
    onClose();
  };

  const handleRenameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleRenameSubmit();
    } else if (e.key === 'Escape') {
      setIsRenaming(false);
      setNewName(fileName);
    }
  };

  const handleDelete = () => {
    // Check if we have multiple items selected
    const hasMultipleSelected = selectedPaths && selectedPaths.size > 1;

    if (hasMultipleSelected && onDeleteMultiple) {
      const selectedArray = Array.from(selectedPaths);
      const confirmMessage = `Are you sure you want to delete ${selectedArray.length} items?`;

      if (window.confirm(confirmMessage)) {
        onDeleteMultiple(selectedArray);
        onClose();
      }
    } else {
      const confirmMessage = fileType === 'directory'
        ? `Are you sure you want to delete the folder "${fileName}" and all its contents?`
        : `Are you sure you want to delete "${fileName}"?`;

      if (window.confirm(confirmMessage)) {
        onDelete(filePath);
        onClose();
      }
    }
  };

  const hasMultipleSelected = selectedPaths && selectedPaths.size > 1;

  if (isRenaming) {
    return (
      <FloatingPortal>
        <div
          ref={menu.refs.setFloating}
          style={{
            ...menu.floatingStyles,
            background: 'var(--nim-bg)',
            border: '1px solid var(--nim-border)',
          }}
          {...menu.getFloatingProps()}
          className="file-context-menu file-context-menu-rename p-2 min-w-[250px] rounded-md z-[10000] backdrop-blur-[10px] shadow-[0_4px_12px_rgba(0,0,0,0.15)] dark:shadow-[0_4px_20px_rgba(0,0,0,0.5)]"
        >
          <div className="rename-input-container flex items-center">
            <input
              ref={inputRef}
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={handleRenameKeyDown}
              onBlur={handleRenameSubmit}
              className="rename-input w-full px-2 py-1.5 rounded text-[13px] outline-none transition-colors"
              style={{
                background: 'var(--nim-bg-secondary)',
                border: '1px solid var(--nim-primary)',
                color: 'var(--nim-text)',
              }}
            />
          </div>
        </div>
      </FloatingPortal>
    );
  }

  // When multiple items are selected, show only batch-compatible options
  if (hasMultipleSelected) {
    return (
      <FloatingPortal>
        <div
          ref={menu.refs.setFloating}
          style={{
            ...menu.floatingStyles,
            background: 'var(--nim-bg)',
            border: '1px solid var(--nim-border)',
          }}
          {...menu.getFloatingProps()}
          className="file-context-menu p-1 min-w-[200px] max-h-[calc(100vh-20px)] overflow-y-auto rounded-md z-[10000] text-[13px] backdrop-blur-[10px] shadow-[0_4px_12px_rgba(0,0,0,0.15)] dark:shadow-[0_4px_20px_rgba(0,0,0,0.5)]"
        >
          <div
            className="file-context-menu-item file-context-menu-item-danger flex items-center gap-2.5 px-3 py-1.5 rounded cursor-pointer transition-colors text-[var(--nim-error)] hover:bg-[var(--nim-error-subtle)]"
            onClick={handleDelete}
          >
            <MaterialSymbol icon="delete" size={18} />
            <span>Delete {selectedPaths.size} Items</span>
          </div>
        </div>
      </FloatingPortal>
    );
  }

  const menuItemClasses = "file-context-menu-item flex items-center gap-2.5 px-3 py-1.5 rounded cursor-pointer transition-colors text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]";
  const dangerItemClasses = "file-context-menu-item file-context-menu-item-danger flex items-center gap-2.5 px-3 py-1.5 rounded cursor-pointer transition-colors text-[var(--nim-error)] hover:bg-[var(--nim-error-subtle)]";
  const separatorClasses = "context-menu-separator h-px my-1 mx-2 bg-[var(--nim-border)]";

  return (
    <FloatingPortal>
      <div
        ref={menu.refs.setFloating}
        style={{
          ...menu.floatingStyles,
          background: 'var(--nim-bg)',
          border: '1px solid var(--nim-border)',
        }}
        {...menu.getFloatingProps()}
        className="file-context-menu p-1 min-w-[200px] max-h-[calc(100vh-20px)] overflow-y-auto rounded-md z-[10000] text-[13px] backdrop-blur-[10px] shadow-[0_4px_12px_rgba(0,0,0,0.15)] dark:shadow-[0_4px_20px_rgba(0,0,0,0.5)]"
        data-testid="file-context-menu"
      >
        {fileType === 'directory' && (
          <>
            {onNewFile && (
              <>
                <div className={menuItemClasses} onClick={() => { onNewFile(filePath, 'markdown'); onClose(); }}>
                  <MaterialSymbol icon="description" size={18} />
                  <span>New Markdown File</span>
                </div>
                {/* Mockup is contributed by the mockuplm extension (.mockup.html);
                    a hardcoded built-in entry here would duplicate it. */}
                {extensionFileTypes.map((extType) => (
                  <div
                    key={extType.extension}
                    className={menuItemClasses}
                    onClick={() => { onNewFile(filePath, `ext:${extType.extension}`); onClose(); }}
                  >
                    <MaterialSymbol icon={extType.icon} size={18} />
                    <span>New {extType.displayName}</span>
                  </div>
                ))}
                <div className={menuItemClasses} onClick={() => { onNewFile(filePath, 'any'); onClose(); }}>
                  <MaterialSymbol icon="note_add" size={18} />
                  <span>New File...</span>
                </div>
              </>
            )}
            {onNewFolder && (
              <div className={menuItemClasses} onClick={() => { onNewFolder(filePath); onClose(); }}>
                <MaterialSymbol icon="create_new_folder" size={18} />
                <span>New Folder</span>
              </div>
            )}
            {(onNewFile || onNewFolder) && <div className={separatorClasses} />}
            {onViewWorkspaceHistory && (
              <div className={menuItemClasses} onClick={() => { onViewWorkspaceHistory(filePath); onClose(); }}>
                <MaterialSymbol icon="history" size={18} />
                <span>View Folder History...</span>
              </div>
            )}
          </>
        )}

        {fileType === 'file' && (
          <div className={menuItemClasses} onClick={() => { openHistoryDialog(filePath); onClose(); }}>
            <MaterialSymbol icon="history" size={18} />
            <span>View History...</span>
          </div>
        )}

        {/* Common file actions (Open in Default App, External Editor, Finder, Copy Path, Share) */}
        <CommonFileActions
          filePath={filePath}
          fileName={fileName}
          onClose={onClose}
          menuItemClass={menuItemClasses}
          separatorClass={separatorClasses}
        />

        <div className={separatorClasses} />

        <div className={menuItemClasses} onClick={handleRenameClick}>
          <MaterialSymbol icon="edit" size={18} />
          <span>Rename</span>
        </div>

        <div className={separatorClasses} />

        <div
          className={dangerItemClasses}
          data-testid="context-menu-delete"
          onClick={handleDelete}
        >
          <MaterialSymbol icon="delete" size={18} />
          <span>Delete</span>
        </div>
      </div>
    </FloatingPortal>
  );
}
