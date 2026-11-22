import React from 'react';
import { MaterialSymbol } from '../../../../icons/MaterialSymbol';
import { HunkList } from './HunkList';
import { directoryCheckboxState, fileCheckboxState, type FileHunkState } from './selectionModel';
import { getStatusColorClass, getStatusLabel, type FileStatus } from './fileStatus';
import type { DirectoryNode, OtherSessionOwner } from '../GitCommitConfirmationWidget';

/**
 * Everything the tree rows need from the widget. Bundled into one prop so the
 * row renderers stay a straight move out of the widget rather than a
 * twenty-parameter signature.
 */
export interface FileTreeContext {
  filesToStage: ReadonlySet<string>;
  hunkStates: ReadonlyMap<string, FileHunkState>;
  expandedFiles: ReadonlySet<string>;
  expandedFolders: ReadonlySet<string>;
  loadingHunks: ReadonlySet<string>;
  fileStatusMap: ReadonlyMap<string, FileStatus>;
  /** #1955: files under an expanded directory that another session edited. */
  otherSessionMap?: ReadonlyMap<string, OtherSessionOwner>;
  siblingSessionLabel: string | null;
  isCommitting: boolean;
  peekSupported: boolean;
  registerRowEl: (filePath: string, el: HTMLElement | null) => void;
  isActive: (filePath: string) => boolean;
  togglePeek: (filePath: string) => void;
  toggleFile: (filePath: string) => void;
  toggleFileExpanded: (filePath: string) => void;
  toggleHunk: (filePath: string, hunkIndex: number) => void;
  selectAllHunks: (filePath: string) => void;
  toggleFolder: (folderPath: string) => void;
  toggleDirectoryFiles: (node: DirectoryNode) => void;
  getFilesInNode: (node: DirectoryNode) => string[];
  getFilePathBasename: (filePath: string) => string;
  compareFilesByBasename: (a: string, b: string) => number;
  compareSubdirectoriesByDisplayPath: (a: DirectoryNode, b: DirectoryNode) => number;
}

export function FileTree({ tree, ctx }: { tree: DirectoryNode; ctx: FileTreeContext }) {
  const {
    filesToStage,
    hunkStates,
    expandedFiles,
    expandedFolders,
    loadingHunks,
    fileStatusMap,
    otherSessionMap,
    siblingSessionLabel,
    isCommitting,
    peekSupported,
    registerRowEl,
    isActive,
    togglePeek,
    toggleFile,
    toggleFileExpanded,
    toggleHunk,
    selectAllHunks,
    toggleFolder,
    toggleDirectoryFiles,
    getFilesInNode,
    getFilePathBasename,
    compareFilesByBasename,
    compareSubdirectoriesByDisplayPath,
  } = ctx;

  // Render a single file item
  const renderFile = (filePath: string, isInDirectory = false) => {
    const checkState = fileCheckboxState(filePath, filesToStage, hunkStates);
    const isSelected = checkState === 'all';
    const isPartial = checkState === 'partial';
    const fileName = getFilePathBasename(filePath);
    const status = fileStatusMap.get(filePath) || 'modified';
    const otherSession = otherSessionMap?.get(filePath);
    const isPinned = isActive(filePath);
    const hunkState = hunkStates.get(filePath);
    const isExpanded = expandedFiles.has(filePath);
    // Only a modification to an existing text file has a HEAD blob to apply a
    // partial patch against; everything else stages whole.
    const canExpand = peekSupported && status === 'modified';
    return (
      <div key={filePath} className="git-commit-widget__file-group">
      <div
        ref={(el) => registerRowEl(filePath, el)}
        className={`git-commit-widget__file group w-full flex items-center gap-1 text-left px-2 py-0.5 rounded border transition-all ${
          isPinned
            ? 'bg-[var(--nim-bg-hover)] border-[var(--nim-primary)]'
            : 'border-transparent bg-transparent hover:bg-[var(--nim-bg-hover)] hover:border-[var(--nim-border)]'
        }`}
      >
        {isInDirectory && !canExpand && (
          <div className="git-commit-widget__caret-placeholder w-4 h-4 shrink-0" />
        )}
        {canExpand && (
          <button
            type="button"
            data-testid="git-commit-file-expand"
            aria-expanded={isExpanded}
            aria-label={isExpanded ? `Collapse hunks for ${fileName}` : `Show hunks for ${fileName}`}
            className="git-commit-widget__file-caret shrink-0 w-4 h-4 flex items-center justify-center bg-transparent border-0 p-0 cursor-pointer text-[var(--nim-text-faint)] hover:text-[var(--nim-text)]"
            onClick={(e) => {
              e.stopPropagation();
              toggleFileExpanded(filePath);
            }}
          >
            <MaterialSymbol icon={isExpanded ? 'expand_more' : 'chevron_right'} size={16} />
          </button>
        )}
        <button
          type="button"
          className="git-commit-widget__file-main flex-1 min-w-0 flex items-center gap-1 text-left bg-transparent border-0 p-0 cursor-pointer"
          onClick={() => toggleFile(filePath)}
          title={getStatusLabel(status)}
        >
          {/* Checkbox for file selection */}
          <div
            data-testid="git-commit-file-checkbox"
            data-check-state={checkState}
            className={`git-commit-widget__checkbox w-4 h-4 shrink-0 rounded-[3px] border-[1.5px] cursor-pointer flex items-center justify-center transition-all ${
              isSelected
                ? 'bg-[var(--nim-file-edited)] border-[var(--nim-file-edited)]'
                : isPartial
                  ? 'bg-[var(--nim-file-edited)] border-[var(--nim-file-edited)] opacity-60'
                  : 'border-[var(--nim-text-faint)] bg-transparent hover:border-[var(--nim-text-muted)]'
            }`}
          >
            {isSelected && (
              <svg width="8" height="6" viewBox="0 0 8 6" fill="none" className="text-white">
                <path d="M1 3L3 5L7 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            )}
            {isPartial && <div className="w-2 h-0.5 bg-white rounded-full" />}
          </div>
          <div className="git-commit-widget__file-info flex-1 min-w-0">
            <span className={`git-commit-widget__file-name text-[0.8125rem] font-medium overflow-hidden text-ellipsis whitespace-nowrap ${getStatusColorClass(status)}`}>
              {fileName}
            </span>
          </div>
          {otherSession && (
            <span
              data-testid="git-commit-file-other-session"
              className="git-commit-widget__other-session shrink-0 max-w-[50%] overflow-hidden text-ellipsis whitespace-nowrap px-1 py-0.5 rounded text-[9px] border border-[var(--nim-warning)] text-[var(--nim-warning)]"
              title={`Edited by another session: ${otherSession.sessionTitle ?? otherSession.sessionId}`}
            >
              edited by: {otherSession.sessionTitle ?? 'another session'}
            </span>
          )}
          {isPartial && hunkState && (
            <span className="git-commit-widget__hunk-count shrink-0 px-1 py-0.5 bg-[var(--nim-bg-tertiary)] rounded text-[9px] text-[var(--nim-text-faint)]">
              {hunkState.selected.size}/{hunkState.hunks.length} hunks
            </span>
          )}
        </button>
        {peekSupported && (
          <button
            type="button"
            data-testid="git-commit-file-peek"
            className={`git-commit-widget__peek-btn shrink-0 w-5 h-5 flex items-center justify-center rounded text-[var(--nim-text-faint)] hover:text-[var(--nim-primary)] hover:bg-[var(--nim-bg-tertiary)] transition-opacity bg-transparent border-0 cursor-pointer ${
              isPinned ? 'opacity-100 text-[var(--nim-primary)]' : 'opacity-0 group-hover:opacity-100 focus:opacity-100'
            }`}
            title={isPinned ? 'Hide diff' : 'Show diff'}
            onClick={(e) => {
              e.stopPropagation();
              togglePeek(filePath);
            }}
          >
            <MaterialSymbol icon="difference" size={14} />
          </button>
        )}
      </div>
      {isExpanded && (
        loadingHunks.has(filePath) ? (
          <div className="pl-8 py-1 text-[0.6875rem] italic text-[var(--nim-text-faint)]">Loading hunks…</div>
        ) : hunkState?.selectable ? (
          <HunkList
            filePath={filePath}
            state={hunkState}
            siblingSessionLabel={siblingSessionLabel}
            onToggleHunk={toggleHunk}
            onSelectAll={selectAllHunks}
            disabled={isCommitting}
          />
        ) : (
          <div className="pl-8 py-1 text-[0.6875rem] italic text-[var(--nim-text-faint)]">
            This file can only be staged whole.
          </div>
        )
      )}
      </div>
    );
  };

  // Render a directory node recursively
  const renderDirectoryNode = (node: DirectoryNode): React.ReactNode => {
    const isExpanded = expandedFolders.has(node.path);
    const hasContent = node.files.length > 0 || node.subdirectories.size > 0;
    const filesInDir = getFilesInNode(node);
    const selectedCount = filesInDir.filter(f => filesToStage.has(f)).length;
    const dirState = directoryCheckboxState(filesInDir, filesToStage, hunkStates);
    const allSelected = dirState === 'all';
    const someSelected = dirState === 'partial';

    // Sort subdirectories by displayPath and files by basename so the
    // tree renders deterministically rather than in the order the model
    // emitted paths in filesToStage. Folders-before-files convention is
    // preserved by rendering subdirectories before files at each site.
    const sortedSubdirectories = Array.from(node.subdirectories.values())
      .sort(compareSubdirectoriesByDisplayPath);
    const sortedFiles = [...node.files].sort(compareFilesByBasename);

    // Root node - just render children
    if (!node.displayPath) {
      return (
        <>
          {sortedSubdirectories.map(subdir => renderDirectoryNode(subdir))}
          {sortedFiles.map(file => renderFile(file))}
        </>
      );
    }

    return (
      <div key={node.path} className="git-commit-widget__directory-node mb-0.5">
        <button
          onClick={() => toggleFolder(node.path)}
          className="git-commit-widget__directory-header w-full flex items-center gap-1 px-2 py-0.5 text-[0.8125rem] font-medium text-[var(--nim-text-muted)] bg-transparent border border-transparent rounded transition-all cursor-pointer text-left hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)]"
        >
          <MaterialSymbol
            icon={isExpanded ? 'expand_more' : 'chevron_right'}
            size={16}
            className="git-commit-widget__directory-chevron shrink-0 transition-transform text-[var(--nim-text-faint)]"
          />
          {/* Directory checkbox */}
          <div
            className={`git-commit-widget__checkbox w-4 h-4 shrink-0 rounded-[3px] border-[1.5px] cursor-pointer flex items-center justify-center transition-all ${
              allSelected
                ? 'bg-[var(--nim-file-edited)] border-[var(--nim-file-edited)]'
                : someSelected
                  ? 'bg-[var(--nim-file-edited)] border-[var(--nim-file-edited)] opacity-60'
                  : 'border-[var(--nim-text-faint)] bg-transparent hover:border-[var(--nim-text-muted)]'
            }`}
            onClick={(e) => {
              e.stopPropagation();
              toggleDirectoryFiles(node);
            }}
          >
            {allSelected && (
              <svg width="8" height="6" viewBox="0 0 8 6" fill="none" className="text-white">
                <path d="M1 3L3 5L7 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            )}
            {someSelected && (
              <div className="w-2 h-0.5 bg-white rounded-full" />
            )}
          </div>
          <MaterialSymbol
            icon={isExpanded ? 'folder_open' : 'folder'}
            size={16}
            className="git-commit-widget__directory-icon shrink-0 text-[var(--nim-text-muted)]"
          />
          <span className="git-commit-widget__directory-path flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{node.displayPath}</span>
          <span className="git-commit-widget__directory-count shrink-0 px-1 py-0.5 bg-[var(--nim-bg-tertiary)] rounded text-[9px] text-[var(--nim-text-faint)]">
            {selectedCount}/{node.fileCount}
          </span>
        </button>

        {isExpanded && hasContent && (
          <div className="git-commit-widget__directory-children mt-0.5 pl-4">
            {sortedSubdirectories.map(subdir => renderDirectoryNode(subdir))}
            {sortedFiles.map(file => renderFile(file, true))}
          </div>
        )}
      </div>
    );
  };

  return <>{renderDirectoryNode(tree)}</>;
}
