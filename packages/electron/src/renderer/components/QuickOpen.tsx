import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useSetAtom } from 'jotai';
import { usePostHog } from 'posthog-js/react';
import { MaterialSymbol } from '@nimbalyst/runtime';
import { getFileName, getRelativeDir } from '../utils/pathUtils';
import { revealFolderAtom } from '../store';
import { KeyboardShortcuts, getShortcutDisplay } from '../../shared/KeyboardShortcuts';

interface FileItem {
  path: string;
  name: string;
  type?: 'file' | 'directory';
  lastOpened?: Date;
  isRecent?: boolean;
  matches?: Array<{
    line: number;
    text: string;
    start: number;
    end: number;
  }>;
  isFileNameMatch?: boolean;
  isContentMatch?: boolean;
}

// QuickOpen works in all modes (Editor, Agent, Files)
interface QuickOpenProps {
  isOpen: boolean;
  onClose: () => void;
  workspacePath: string;
  currentFilePath?: string | null;
  onFileSelect: (filePath: string) => void;
  /** Callback when a folder is selected -- switches to files mode and reveals in tree */
  onFolderSelect?: (folderPath: string) => void;
  /** If true, immediately trigger content search mode when opened */
  startInContentSearchMode?: boolean;
  /** Callback to show sessions that edited a file (opens Session Quick Open with @path) */
  onShowFileSessions?: (filePath: string) => void;
}

export const QuickOpen: React.FC<QuickOpenProps> = ({
  isOpen,
  onClose,
  workspacePath,
  currentFilePath,
  onFileSelect,
  onFolderSelect,
  startInContentSearchMode = false,
  onShowFileSessions,
}) => {
  const posthog = usePostHog();
  const revealFolder = useSetAtom(revealFolderAtom);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [searchResults, setSearchResults] = useState<FileItem[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isContentSearch, setIsContentSearch] = useState(false);
  const [contentSearchTriggered, setContentSearchTriggered] = useState(false);
  const [mouseHasMoved, setMouseHasMoved] = useState(false);
  const [recentFiles, setRecentFiles] = useState<string[]>([]);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchTimeoutRef = useRef<NodeJS.Timeout>();
  const resultsListRef = useRef<HTMLUListElement>(null);

  // Convert recent files to FileItems (excluding current file)
  const recentFileItems: FileItem[] = recentFiles
    .filter(path => path !== currentFilePath)
    .map(path => ({
      path,
      name: getFileName(path),
      isRecent: true,
    }));

  // Combined list of files to display
  const displayFiles = searchQuery ? searchResults : recentFileItems;

  // Search for files in the workspace (name search only)
  const searchFiles = useCallback(async (query: string) => {
    if (!query.trim()) {
      setSearchResults([]);
      setIsContentSearch(false);
      return;
    }

    setIsSearching(true);

    try {
      // Use electron API to search files (check both window.electronAPI and window.electron)
      const api = (window as any).electronAPI || (window as any).electron;
      if (!api) {
        console.error('Electron API not available');
        setSearchResults([]);
        setIsSearching(false);
        return;
      }

      if (!workspacePath) {
        console.error('No workspace path available');
        setSearchResults([]);
        setIsSearching(false);
        return;
      }

      // Get file name matches
      if (!api.searchWorkspaceFileNames) {
        console.error('searchWorkspaceFileNames method not available');
        setSearchResults([]);
        setIsSearching(false);
        return;
      }

      const fileNameResults = await api.searchWorkspaceFileNames(workspacePath, query);

      // Process and display file name results
      if (Array.isArray(fileNameResults)) {
        const processedFileNames = fileNameResults
          .map((result: any) => ({
            path: result.path,
            name: getFileName(result.path),
            type: result.type as 'file' | 'directory' | undefined,
            isRecent: recentFiles.includes(result.path),
            matches: result.matches || [],
            isFileNameMatch: result.isFileNameMatch || false,
            isContentMatch: false,
          }));

        setSearchResults(processedFileNames);
        setIsSearching(false);

        // Track workspace search analytics (file name search)
        try {
          const resultCount = processedFileNames.length;
          const queryLength = query.length;
          let queryLengthCategory = 'short';
          if (queryLength > 20) queryLengthCategory = 'long';
          else if (queryLength > 10) queryLengthCategory = 'medium';

          let resultCountBucket = '0';
          if (resultCount > 0) {
            if (resultCount <= 10) resultCountBucket = '1-10';
            else if (resultCount <= 50) resultCountBucket = '11-50';
            else if (resultCount <= 100) resultCountBucket = '51-100';
            else resultCountBucket = '100+';
          }

          posthog?.capture('workspace_search_used', {
            resultCount: resultCountBucket,
            queryLength: queryLengthCategory,
            searchType: 'file_name',
          });
        } catch (error) {
          console.error('Error tracking workspace_search_used event:', error);
        }
      } else {
        console.warn('Results is not an array:', fileNameResults);
        setSearchResults([]);
        setIsSearching(false);
      }
    } catch (error) {
      console.error('Error searching files:', error);
      setSearchResults([]);
      setIsSearching(false);
    }
  }, [workspacePath, recentFiles]);

  // Search file contents (triggered manually)
  const searchFileContents = useCallback(async () => {
    if (!searchQuery.trim() || contentSearchTriggered) {
      return; // Don't search if already triggered or no query
    }

    setContentSearchTriggered(true);
    setIsSearching(true);

    try {
      const api = (window as any).electronAPI || (window as any).electron;
      if (!api || !api.searchWorkspaceFileContent) {
        setIsSearching(false);
        return;
      }

      const contentResults = await api.searchWorkspaceFileContent(workspacePath, searchQuery);

      // Merge content results with existing file name results
      if (Array.isArray(contentResults)) {
        setSearchResults(prevResults => {
          const mergedResults = [...prevResults];

          // Process content results
          for (const contentResult of contentResults) {
            const existingIndex = mergedResults.findIndex(r => r.path === contentResult.path);

            if (existingIndex >= 0) {
              // File already in results from name match, add content matches
              mergedResults[existingIndex].matches = contentResult.matches || [];
              mergedResults[existingIndex].isContentMatch = true;
            } else {
              // New file found only by content
              mergedResults.push({
                path: contentResult.path,
                name: getFileName(contentResult.path),
                isRecent: recentFiles.includes(contentResult.path),
                matches: contentResult.matches || [],
                isFileNameMatch: false,
                isContentMatch: true,
              });
            }
          }

          // Sort merged results: prioritize file name matches over content matches
          mergedResults.sort((a, b) => {
            // File name matches come first
            if (a.isFileNameMatch && !b.isFileNameMatch) return -1;
            if (!a.isFileNameMatch && b.isFileNameMatch) return 1;

            // Then sort by number of matches (more matches = higher priority)
            const aMatchCount = a.matches?.length || 0;
            const bMatchCount = b.matches?.length || 0;
            if (aMatchCount !== bMatchCount) {
              return bMatchCount - aMatchCount;
            }

            // Finally, sort alphabetically by file name
            return a.name.localeCompare(b.name);
          });

          return mergedResults;
        });

        // Track workspace search analytics (content search)
        try {
          const queryLength = searchQuery.length;
          let queryLengthCategory = 'short';
          if (queryLength > 20) queryLengthCategory = 'long';
          else if (queryLength > 10) queryLengthCategory = 'medium';

          const resultCount = contentResults.length;
          let resultCountBucket = '0';
          if (resultCount > 0) {
            if (resultCount <= 10) resultCountBucket = '1-10';
            else if (resultCount <= 50) resultCountBucket = '11-50';
            else if (resultCount <= 100) resultCountBucket = '51-100';
            else resultCountBucket = '100+';
          }

          posthog?.capture('workspace_search_used', {
            resultCount: resultCountBucket,
            queryLength: queryLengthCategory,
            searchType: 'content',
          });
        } catch (error) {
          console.error('Error tracking workspace_search_used event:', error);
        }
      }
      setIsSearching(false);
    } catch (error) {
      console.error('Error in content search:', error);
      setIsSearching(false);
    }
  }, [workspacePath, searchQuery, contentSearchTriggered, recentFiles, posthog]);

  // Debounced search
  useEffect(() => {
    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
    }

    // Reset content search trigger when query changes (but keep it if in content search mode)
    if (!startInContentSearchMode) {
      setContentSearchTriggered(false);
    }

    if (searchQuery) {
      searchTimeoutRef.current = setTimeout(() => {
        searchFiles(searchQuery);
        // If in content search mode, also trigger content search after file name search
        if (startInContentSearchMode) {
          // Content search will be triggered after searchFiles completes
          // We need to call it separately since contentSearchTriggered is already true
          const api = (window as any).electronAPI || (window as any).electron;
          if (api?.searchWorkspaceFileContent) {
            api.searchWorkspaceFileContent(workspacePath, searchQuery)
              .then((contentResults: any[]) => {
                if (Array.isArray(contentResults)) {
                  setSearchResults(prevResults => {
                    const mergedResults = [...prevResults];
                    for (const contentResult of contentResults) {
                      const existingIndex = mergedResults.findIndex(r => r.path === contentResult.path);
                      if (existingIndex >= 0) {
                        mergedResults[existingIndex].matches = contentResult.matches || [];
                        mergedResults[existingIndex].isContentMatch = true;
                      } else {
                        mergedResults.push({
                          path: contentResult.path,
                          name: getFileName(contentResult.path),
                          isRecent: recentFiles.includes(contentResult.path),
                          matches: contentResult.matches || [],
                          isFileNameMatch: false,
                          isContentMatch: true,
                        });
                      }
                    }
                    mergedResults.sort((a, b) => {
                      if (a.isFileNameMatch && !b.isFileNameMatch) return -1;
                      if (!a.isFileNameMatch && b.isFileNameMatch) return 1;
                      const aMatchCount = a.matches?.length || 0;
                      const bMatchCount = b.matches?.length || 0;
                      if (aMatchCount !== bMatchCount) return bMatchCount - aMatchCount;
                      return a.name.localeCompare(b.name);
                    });
                    return mergedResults;
                  });
                }
              })
              .catch((error: any) => {
                console.error('Error in content search:', error);
              });
          }
        }
      }, 150);
    } else {
      setSearchResults([]);
    }

    return () => {
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current);
      }
    };
  }, [searchQuery, searchFiles, startInContentSearchMode, workspacePath, recentFiles]);

  // Load recent files when modal opens
  useEffect(() => {
    if (isOpen && window.electronAPI?.getRecentWorkspaceFiles) {
      window.electronAPI.getRecentWorkspaceFiles()
        .then(files => {
          setRecentFiles(files || []);
        })
        .catch(error => {
          console.error('[QuickOpen] Failed to load recent files:', error);
          setRecentFiles([]);
        });
    }
  }, [isOpen]);

  // Reset state when modal opens/closes
  useEffect(() => {
    if (isOpen) {
      setSearchQuery('');
      setSelectedIndex(0);
      setSearchResults([]);
      // If starting in content search mode, mark as triggered so we search contents immediately
      setContentSearchTriggered(startInContentSearchMode);
      setIsContentSearch(startInContentSearchMode);
      setMouseHasMoved(false);
      setTimeout(() => searchInputRef.current?.focus(), 100);

      // Build file name cache in background
      const api = (window as any).electronAPI || (window as any).electron;
      if (api?.buildQuickOpenCache && workspacePath) {
        api.buildQuickOpenCache(workspacePath).catch((error: any) => {
          console.error('Failed to build quick open cache:', error);
        });
      }
    }
  }, [isOpen, workspacePath, startInContentSearchMode]);

  // Track mouse movement to distinguish between mouse hover and mouse at rest
  useEffect(() => {
    if (!isOpen) return;

    const handleMouseMove = () => {
      setMouseHasMoved(true);
    };

    window.addEventListener('mousemove', handleMouseMove);
    return () => window.removeEventListener('mousemove', handleMouseMove);
  }, [isOpen]);

  // Scroll selected item into view
  useEffect(() => {
    if (!resultsListRef.current) return;

    const items = resultsListRef.current.querySelectorAll('.quick-open-item');
    const selectedItem = items[selectedIndex] as HTMLElement;

    if (selectedItem) {
      selectedItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [selectedIndex]);

  // Keyboard navigation
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setSelectedIndex(prev =>
            prev < displayFiles.length - 1 ? prev + 1 : prev
          );
          break;
        case 'ArrowUp':
          e.preventDefault();
          setSelectedIndex(prev => prev > 0 ? prev - 1 : prev);
          break;
        case 'Enter':
          e.preventDefault();
          if (displayFiles[selectedIndex]) {
            handleItemSelect(displayFiles[selectedIndex].path, displayFiles[selectedIndex].type);
          }
          break;
        case 'Tab':
          e.preventDefault();
          if (searchQuery && !contentSearchTriggered) {
            searchFileContents();
          }
          break;
        case 'Escape':
          e.preventDefault();
          onClose();
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, selectedIndex, displayFiles, searchQuery, contentSearchTriggered, onClose, searchFileContents]);

  const handleItemSelect = (filePath: string, fileType?: 'file' | 'directory') => {
    if (fileType === 'directory') {
      // Switch to files mode and reveal the folder in the file tree
      if (onFolderSelect) {
        onFolderSelect(filePath);
      }
      revealFolder(filePath);
      onClose();
      return;
    }
    onFileSelect(filePath);
    onClose();
  };

  if (!isOpen) return null;

  return (
    <>
      <div
        className="quick-open-backdrop fixed inset-0 z-[99998] nim-animate-fade-in bg-black/50"
        onClick={onClose}
      />
      <div
        className="quick-open-modal fixed top-[20%] left-1/2 -translate-x-1/2 w-[90%] max-w-[600px] max-h-[60vh] flex flex-col overflow-hidden rounded-lg z-[99999] bg-nim border border-nim shadow-[0_20px_60px_rgba(0,0,0,0.3)]"
      >
        <div
          className="quick-open-header p-3 border-b border-nim"
        >
          <div className="text-[11px] font-medium text-nim-faint uppercase tracking-wide mb-2">
            {startInContentSearchMode ? 'Search in Files' : 'Open File'}
          </div>
          <div className="relative">
            <input
              ref={searchInputRef}
              type="text"
              className="quick-open-search nim-input text-base"
              placeholder={startInContentSearchMode ? "Search in file contents..." : "Search files..."}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {isSearching && (
              <div
                className="quick-open-searching absolute right-3 top-1/2 -translate-y-1/2 text-xs text-nim-faint"
              >
                {contentSearchTriggered ? 'Searching file contents...' : 'Searching...'}
              </div>
            )}
            {!isSearching && searchQuery && !contentSearchTriggered && !startInContentSearchMode && (
              <button
                className="quick-open-content-search-hint absolute right-3 top-1/2 -translate-y-1/2 text-xs flex items-center gap-1 px-2 py-1 rounded cursor-pointer border-none transition-colors duration-150 bg-transparent text-nim-faint hover:bg-[var(--nim-accent-subtle)] hover:text-nim-primary"
                onClick={() => searchFileContents()}
                title="Search in file contents"
            >
              <kbd
                className="px-1.5 py-0.5 rounded font-mono text-[10px] bg-nim border border-nim text-nim"
              >
                Tab
              </kbd>
              Search in file contents
            </button>
          )}
          </div>
        </div>

        <div className="quick-open-results flex-1 overflow-y-auto min-h-[200px]">
          {displayFiles.length === 0 ? (
            <div
              className="quick-open-empty p-10 text-center text-nim-faint"
            >
              {searchQuery ? 'No files found' : 'No recent files'}
            </div>
          ) : (
            <ul className="quick-open-list list-none m-0 p-0" ref={resultsListRef}>
              {displayFiles.map((file, index) => (
                <li
                  key={`${file.path}-${index}`}
                  className={`quick-open-item relative group px-4 py-2.5 cursor-pointer border-l-[3px] transition-all duration-100 ${
                    index === selectedIndex ? 'selected bg-nim-selected border-l-nim-primary' : 'border-transparent hover:bg-nim-hover'
                  } ${file.isContentMatch ? 'content-match' : ''} ${file.isFileNameMatch ? 'name-match' : ''}`}
                  onClick={() => handleItemSelect(file.path, file.type)}
                  onMouseEnter={() => {
                    if (mouseHasMoved) {
                      setSelectedIndex(index);
                    }
                  }}
                >
                  {onShowFileSessions && (
                    <button
                      className={`quick-open-show-sessions absolute right-3 top-2.5 p-1 rounded transition-all duration-100 border-none cursor-pointer bg-transparent text-[var(--nim-text-faint)] hover:text-[var(--nim-primary)] hover:bg-[var(--nim-accent-subtle)] ${
                        index === selectedIndex ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                      }`}
                      onClick={(e) => {
                        e.stopPropagation();
                        const relativePath = file.path.startsWith(workspacePath)
                          ? file.path.slice(workspacePath.length + 1)
                          : file.path;
                        onShowFileSessions(relativePath);
                      }}
                      title="Show sessions that edited this file"
                    >
                      <MaterialSymbol icon="history" size={16} />
                    </button>
                  )}
                  <div
                    className={`quick-open-item-name text-sm font-medium flex items-center gap-2 text-nim ${file.isContentMatch ? 'mb-1' : ''}`}
                  >
                    {file.type === 'directory' && (
                      <MaterialSymbol icon="folder" size={16} className="text-nim-faint shrink-0" />
                    )}
                    {file.type === 'directory' ? file.name + '/' : file.name}
                    {file.isRecent && !searchQuery && (
                      <span className="quick-open-badge nim-badge-primary text-[10px]">Recent</span>
                    )}
                    {/*{file.isFileNameMatch && (*/}
                    {/*  <span className="quick-open-badge name-badge nim-badge-success text-[10px]">Name</span>*/}
                    {/*)}*/}
                    {file.matches && file.matches.length > 0 && (
                      <span
                        className="quick-open-badge content-badge text-[10px] px-1.5 py-0.5 rounded text-white font-semibold uppercase bg-[var(--nim-accent-purple)]"
                      >
                        {file.matches.length} match{file.matches.length > 1 ? 'es' : ''}
                      </span>
                    )}
                  </div>
                  <div
                    className="quick-open-item-path text-xs mt-0.5 overflow-hidden text-ellipsis whitespace-nowrap text-nim-faint"
                  >
                    {getRelativeDir(file.path, workspacePath)}
                  </div>
                  {file.matches && file.matches.length > 0 && (
                    <div
                      className="quick-open-item-matches mt-2 pl-2 border-l-2 border-nim"
                    >
                      {file.matches.slice(0, 2).map((match, i) => (
                        <div
                          key={i}
                          className="quick-open-match text-xs leading-snug mb-1 block overflow-hidden text-ellipsis whitespace-nowrap text-nim-muted"
                        >
                          <span
                            className="quick-open-line-number mr-2 font-medium text-nim-faint"
                          >
                            Line {match.line}:
                          </span>
                          <span className="quick-open-match-text">
                            {match.text.substring(0, match.start)}
                            <mark
                              className="px-0.5 rounded font-semibold bg-[var(--nim-highlight-bg)] text-[var(--nim-highlight-text)]"
                            >
                              {match.text.substring(match.start, match.end)}
                            </mark>
                            {match.text.substring(match.end)}
                          </span>
                        </div>
                      ))}
                      {file.matches.length > 2 && (
                        <div
                          className="quick-open-more-matches text-[11px] italic mt-1 text-nim-faint"
                        >
                          ...and {file.matches.length - 2} more match{file.matches.length - 2 > 1 ? 'es' : ''}
                        </div>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div
          className="quick-open-footer px-4 py-2 flex justify-between border-t border-nim bg-nim-secondary"
        >
          <div className="flex gap-4">
            <span
              className="quick-open-hint text-[11px] flex items-center gap-1 text-nim-faint"
            >
              <kbd
                className="px-1.5 py-0.5 rounded font-mono text-[10px] bg-nim border border-nim text-nim"
              >
                ↑↓
              </kbd>
              Navigate
            </span>
            <span
              className="quick-open-hint text-[11px] flex items-center gap-1 text-nim-faint"
            >
              <kbd
                className="px-1.5 py-0.5 rounded font-mono text-[10px] bg-nim border border-nim text-nim"
              >
                Enter
              </kbd>
              Open
            </span>
            {searchQuery && !contentSearchTriggered && !startInContentSearchMode && (
              <span
                className="quick-open-hint text-[11px] flex items-center gap-1 text-nim-faint"
              >
                <kbd
                  className="px-1.5 py-0.5 rounded font-mono text-[10px] bg-nim border border-nim text-nim"
                >
                  Tab
                </kbd>
                Search in file contents
              </span>
            )}
            <span
              className="quick-open-hint text-[11px] flex items-center gap-1 text-nim-faint"
            >
              <kbd
                className="px-1.5 py-0.5 rounded font-mono text-[10px] bg-nim border border-nim text-nim"
              >
                Esc
              </kbd>
              Close
            </span>
          </div>
          {!startInContentSearchMode && (
            <span
              className="quick-open-hint text-[11px] flex items-center gap-1 text-nim-faint"
            >
              <kbd
                className="px-1.5 py-0.5 rounded font-mono text-[10px] bg-nim border border-nim text-nim"
              >
                {getShortcutDisplay(KeyboardShortcuts.window.contentSearch)}
              </kbd>
              Content search
            </span>
          )}
        </div>
      </div>
    </>
  );
};
