import React, { memo, useState, useRef, useEffect, useCallback } from 'react';
import { useAtomValue } from 'jotai';
import { MaterialSymbol, getFileIcon } from '@nimbalyst/runtime';
import {
  fileGitStatusAtom,
  directoryGitStatusAtom,
  type FlatTreeNode,
  type FileGitStatus,
} from '../store';

/**
 * Helper to convert atom git status to display string.
 */
function getStatusDisplay(status: FileGitStatus | undefined): { code: string; className: string; title: string } | null {
  if (!status) return null;

  const code = status.workingTree !== ' ' ? status.workingTree : status.index;
  if (code === ' ') return null;

  switch (code) {
    case 'M':
      return { code: 'M', className: 'modified', title: 'Modified - Changes not staged for commit' };
    case 'A':
      return { code: 'S', className: 'staged', title: 'Staged - Changes ready to commit' };
    case '?':
      return { code: '?', className: 'untracked', title: 'Untracked - New file not yet added to git' };
    case 'D':
      return { code: 'D', className: 'deleted', title: 'Deleted - File removed' };
    default:
      return null;
  }
}

/**
 * Git status indicator for a file.
 * Each instance subscribes only to its own file's git status atom.
 */
const FileGitStatusIndicator = memo<{ filePath: string }>(({ filePath }) => {
  const status = useAtomValue(fileGitStatusAtom(filePath));
  const display = getStatusDisplay(status);

  if (!display) return null;

  return (
    <span
      className={`file-tree-git-status file-tree-git-status--${display.className}`}
      title={display.title}
    >
      {display.code}
    </span>
  );
});

/**
 * Git status indicator for a directory.
 * Shows aggregate status of all files within the directory.
 */
const DirectoryGitStatusIndicator = memo<{ dirPath: string }>(({ dirPath }) => {
  const status = useAtomValue(directoryGitStatusAtom(dirPath));
  const display = getStatusDisplay(status);

  if (!display) return null;

  return (
    <span
      className={`file-tree-git-status file-tree-git-status--${display.className} file-tree-git-status--inherited`}
      title={
        display.className === 'modified' ? 'Contains modified files' :
        display.className === 'staged' ? 'Contains staged files' :
        display.className === 'untracked' ? 'Contains untracked files' :
        display.className === 'deleted' ? 'Contains deleted files' : ''
      }
    >
      {display.code}
    </span>
  );
});

interface FileTreeRowProps {
  node: FlatTreeNode;
  showIcons: boolean;
  isFocused: boolean;
  isRenaming: boolean;
  isDragSource: boolean;
  isCopyDrag: boolean;
  onClick: (e: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDragLeave?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent) => void;
  onRenameConfirm?: (path: string, newName: string) => void;
  onRenameCancel?: () => void;
}

/**
 * Inline rename input component.
 * Auto-selects filename without extension for files, full name for directories.
 */
const InlineRenameInput = memo<{
  path: string;
  name: string;
  type: 'file' | 'directory';
  onConfirm: (path: string, newName: string) => void;
  onCancel: () => void;
}>(({ path, name, type, onConfirm, onCancel }) => {
  const [value, setValue] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!inputRef.current) return;
    inputRef.current.focus();

    if (type === 'file') {
      const dotIndex = name.lastIndexOf('.');
      if (dotIndex > 0) {
        inputRef.current.setSelectionRange(0, dotIndex);
      } else {
        inputRef.current.select();
      }
    } else {
      inputRef.current.select();
    }
  }, [name, type]);

  const handleConfirm = useCallback(() => {
    const trimmed = value.trim();
    if (trimmed && trimmed !== name) {
      onConfirm(path, trimmed);
    } else {
      onCancel();
    }
  }, [value, name, path, onConfirm, onCancel]);

  return (
    <input
      ref={inputRef}
      className="file-tree-rename-input"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          handleConfirm();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        }
      }}
      onBlur={handleConfirm}
      onClick={(e) => e.stopPropagation()}
    />
  );
});

/**
 * Memoized row renderer for the flat virtualized file tree.
 *
 * Preserves existing CSS class names (.file-tree-file, .file-tree-directory, etc.)
 * for backward compatibility with E2E tests and existing styles.
 * Indentation is handled via inline paddingLeft instead of nested <ul> elements.
 */
export const FileTreeRow = memo<FileTreeRowProps>(({
  node,
  showIcons,
  isFocused,
  isRenaming,
  isDragSource,
  isCopyDrag,
  onClick,
  onContextMenu,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDragLeave,
  onDrop,
  onRenameConfirm,
  onRenameCancel,
}) => {
  const indent = node.depth * 16 + 8;

  if (node.type === 'directory') {
    return (
      <div
        role="treeitem"
        aria-expanded={node.isExpanded}
        aria-selected={node.isMultiSelected || node.isSelected}
        aria-level={node.depth + 1}
        className={`file-tree-directory${node.isDragOver ? ' drag-over' : ''}${node.isSelected ? ' selected' : ''}${node.isMultiSelected ? ' multi-selected' : ''}${node.isSpecialDirectory ? ' special-directory' : ''}${isFocused ? ' focused' : ''}`}
        style={{ paddingLeft: indent, opacity: isDragSource ? 0.5 : 1 }}
        onClick={onClick}
        onContextMenu={onContextMenu}
        draggable={!isRenaming}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <span className="file-tree-chevron">
          <MaterialSymbol
            icon={node.isExpanded ? "keyboard_arrow_down" : "keyboard_arrow_right"}
            size={16}
          />
        </span>
        {showIcons && (
          <span className="file-tree-icon">
            <MaterialSymbol
              icon={node.isExpanded ? "folder_open" : "folder"}
              size={18}
            />
          </span>
        )}
        {isRenaming && onRenameConfirm && onRenameCancel ? (
          <InlineRenameInput
            path={node.path}
            name={node.name}
            type="directory"
            onConfirm={onRenameConfirm}
            onCancel={onRenameCancel}
          />
        ) : (
          <>
            <span className="file-tree-name">
              {node.name}
              {node.isDragOver && isCopyDrag && <span style={{ marginLeft: '4px', fontSize: '10px', opacity: 0.7 }}>(copy)</span>}
            </span>
            <DirectoryGitStatusIndicator dirPath={node.path} />
          </>
        )}
      </div>
    );
  }

  return (
    <div
      role="treeitem"
      aria-selected={node.isMultiSelected || node.isActive}
      aria-level={node.depth + 1}
      className={`file-tree-file${node.isActive ? ' active' : ''}${node.isMultiSelected ? ' multi-selected' : ''}${isFocused ? ' focused' : ''}`}
      style={{ paddingLeft: indent, opacity: isDragSource ? 0.5 : 1 }}
      onClick={onClick}
      onContextMenu={onContextMenu}
      draggable={!isRenaming}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      <span className="file-tree-spacer"></span>
      {showIcons && (
        <span className="file-tree-icon">
          {getFileIcon(node.name)}
        </span>
      )}
      {isRenaming && onRenameConfirm && onRenameCancel ? (
        <InlineRenameInput
          path={node.path}
          name={node.name}
          type="file"
          onConfirm={onRenameConfirm}
          onCancel={onRenameCancel}
        />
      ) : (
        <>
          <span className="file-tree-name">
            {node.name}
          </span>
          <FileGitStatusIndicator filePath={node.path} />
        </>
      )}
    </div>
  );
});
