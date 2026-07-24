import { useEffect, useState, useCallback, useRef } from 'react';
import type { LexicalEditor } from 'lexical';
import { $getRoot, $getNodeByKey, $isTextNode, $createRangeSelection, $setSelection } from 'lexical';
import { SearchReplaceStateManager } from './SearchReplaceStateManager';
// Only contains global highlight styles for dynamically applied classes
import './SearchReplaceBar.css';

interface SearchReplaceBarProps {
  filePath: string;
  fileName: string;
  editor?: LexicalEditor;
}

interface SearchMatch {
  key: string;
  offset: number;
  length: number;
  text: string;
}

const SEARCH_HISTORY_KEY = 'nimbalyst-search-history';
const REPLACE_HISTORY_KEY = 'nimbalyst-replace-history';
const MAX_HISTORY_ITEMS = 10;

function getHistory(key: string): string[] {
  try {
    const stored = localStorage.getItem(key);
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
}

function addToHistory(key: string, value: string) {
  if (!value.trim()) return;

  const history = getHistory(key);
  const filtered = history.filter(item => item !== value);
  const updated = [value, ...filtered].slice(0, MAX_HISTORY_ITEMS);

  try {
    localStorage.setItem(key, JSON.stringify(updated));
  } catch {
    // Ignore localStorage errors
  }
}

// Helper to find all text nodes in the editor
function $findTextNodes(root: ReturnType<typeof $getRoot>, callback: (node: any) => void) {
  const traverse = (node: any) => {
    if ($isTextNode(node)) {
      callback(node);
    }
    const children = node.getChildren?.();
    if (children) {
      children.forEach((child: any) => traverse(child));
    }
  };
  traverse(root);
}

// HighlightManager class for creating visual highlights over search matches
class HighlightManager {
  private editor: LexicalEditor;
  private highlightElements: HTMLElement[] = [];
  private wrapperElement: HTMLElement;
  private observer: MutationObserver | null = null;
  private rootElement: HTMLElement | null = null;
  private parentElement: HTMLElement | null = null;

  constructor(editor: LexicalEditor) {
    this.editor = editor;
    this.wrapperElement = document.createElement('div');
    this.wrapperElement.className = 'search-highlights-wrapper';
    this.wrapperElement.style.position = 'relative';
    this.wrapperElement.style.pointerEvents = 'none';
  }

  updateHighlights(matches: SearchMatch[], currentIndex: number) {
    const rootElement = this.editor.getRootElement();
    if (!rootElement) return;

    const parentElement = rootElement.parentElement;
    if (!parentElement) return;

    if (this.rootElement !== rootElement || this.parentElement !== parentElement) {
      this.setupObserver(rootElement, parentElement);
    }

    this.clearHighlights();

    if (!this.wrapperElement.isConnected) {
      parentElement.insertBefore(this.wrapperElement, parentElement.firstChild);
    }

    const { left: parentLeft, top: parentTop } = parentElement.getBoundingClientRect();

    matches.forEach((match, index) => {
      this.editor.getEditorState().read(() => {
        const node = $getNodeByKey(match.key);
        if (!$isTextNode(node)) return;

        // Validate offset is still valid for this node
        const textContent = node.getTextContent();
        if (match.offset >= textContent.length) return;

        const domElement = this.editor.getElementByKey(match.key);
        if (!domElement) return;

        const textNode = domElement.firstChild as Text;
        if (!textNode || textNode.nodeType !== Node.TEXT_NODE) return;

        // Clamp the range to valid offsets
        const validOffset = Math.min(match.offset, textNode.length);
        const validEnd = Math.min(match.offset + match.length, textNode.length);

        if (validOffset >= validEnd) return;

        const range = document.createRange();
        try {
          range.setStart(textNode, validOffset);
          range.setEnd(textNode, validEnd);
        } catch (e) {
          return;
        }

        const rects = Array.from(range.getClientRects());
        rects.forEach((rect) => {
          const highlightElement = document.createElement('div');
          highlightElement.className = index === currentIndex ? 'search-highlight-current' : 'search-highlight';
          highlightElement.style.position = 'absolute';
          highlightElement.style.left = `${rect.left - parentLeft}px`;
          highlightElement.style.top = `${rect.top - parentTop}px`;
          highlightElement.style.width = `${rect.width}px`;
          highlightElement.style.height = `${rect.height}px`;
          highlightElement.style.pointerEvents = 'none';

          this.wrapperElement.appendChild(highlightElement);
          this.highlightElements.push(highlightElement);
        });
      });
    });
  }

  clearHighlights() {
    this.highlightElements.forEach((element) => element.remove());
    this.highlightElements = [];
  }

  destroy() {
    this.clearHighlights();
    this.wrapperElement.remove();
    if (this.observer) {
      this.observer.disconnect();
    }
  }

  private setupObserver(rootElement: HTMLElement, parentElement: HTMLElement) {
    if (this.observer) {
      this.observer.disconnect();
    }

    this.rootElement = rootElement;
    this.parentElement = parentElement;

    this.observer = new MutationObserver(() => {
      const currentRoot = this.editor.getRootElement();
      const currentParent = currentRoot?.parentElement;

      if (currentRoot !== this.rootElement || currentParent !== this.parentElement) {
        this.clearHighlights();
      }
    });

    this.observer.observe(parentElement, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
  }
}

export function SearchReplaceBar({ filePath, editor }: SearchReplaceBarProps) {
  // console.log('[SearchReplaceBar] RENDER - filePath:', filePath);

  // Use filePath as the tabId for consistency with the registry's shouldRender check
  // Note: This means tabs with the same file will share search state
  // To get per-tab isolation, we'd need a unique tab instance ID from the parent
  const tabId = filePath;

  const [isOpen, setIsOpen] = useState(false);
  const [searchString, setSearchString] = useState('');
  const [replaceString, setReplaceString] = useState('');
  const [caseInsensitive, setCaseInsensitive] = useState(true); // Case insensitive by default (Match case button OFF)
  const [useRegex, setUseRegex] = useState(false);
  const [matches, setMatches] = useState<SearchMatch[]>([]);
  const [currentMatchIndex, setCurrentMatchIndex] = useState(-1);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const highlightManagerRef = useRef<HighlightManager | null>(null);
  const searchDebounceRef = useRef<NodeJS.Timeout | null>(null);

  // Listen to state changes from SearchReplaceStateManager
  useEffect(() => {
    const handleStateChange = (changedTabId: string, state: any) => {
      if (changedTabId === tabId) {
        setIsOpen(state.isOpen);
      }
    };

    SearchReplaceStateManager.addListener(handleStateChange);

    // Initialize state
    const initialState = SearchReplaceStateManager.getState(tabId);
    setIsOpen(initialState.isOpen);

    return () => {
      SearchReplaceStateManager.removeListener(handleStateChange);
    };
  }, [tabId]);

  // Focus search input when bar opens
  useEffect(() => {
    if (isOpen) {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    }
  }, [isOpen]);

  // Initialize and cleanup HighlightManager
  useEffect(() => {
    if (editor) {
      highlightManagerRef.current = new HighlightManager(editor);
    }
    return () => {
      highlightManagerRef.current?.destroy();
      highlightManagerRef.current = null;
      // Clean up debounce timeout on unmount
      if (searchDebounceRef.current) {
        clearTimeout(searchDebounceRef.current);
      }
    };
  }, [editor]);

  // Clear highlights when closing
  useEffect(() => {
    if (!isOpen) {
      highlightManagerRef.current?.clearHighlights();
    }
  }, [isOpen]);

  // Navigate to a specific match - MUST be defined before performSearch
  const navigateToMatchInternal = useCallback(
    (matchList: SearchMatch[], index: number, options?: { refocusInput?: boolean; setSelection?: boolean }) => {
      if (!editor || matchList.length === 0 || index < 0 || index >= matchList.length) {
        return;
      }

      const refocusInput = options?.refocusInput ?? true;
      const setSelection = options?.setSelection ?? true;
      const match = matchList[index];

      editor.update(() => {
        const node = $getNodeByKey(match.key);
        if ($isTextNode(node)) {
          // Validate that the offset is still valid (document may have changed)
          const textContent = node.getTextContent();
          const validOffset = Math.min(match.offset, textContent.length);
          const validLength = Math.min(match.length, textContent.length - validOffset);

          if (validOffset >= 0 && validLength > 0) {
            // Only set selection if explicitly requested (prevents focus steal)
            if (setSelection) {
              const selection = $createRangeSelection();
              selection.anchor.set(match.key, validOffset, 'text');
              selection.focus.set(match.key, validOffset + validLength, 'text');
              $setSelection(selection);
            }

            const domNode = editor.getElementByKey(match.key);
            if (domNode) {
              domNode.scrollIntoView({
                behavior: 'smooth',
                block: 'center',
              });
            }
          }
        }
      });

      // Only refocus search input if explicitly requested (user navigation, not auto-update)
      if (refocusInput) {
        setTimeout(() => {
          if (searchInputRef.current) {
            searchInputRef.current.focus();
          }
        }, 0);
      }
    },
    [editor]
  );

  // Perform search
  const performSearch = useCallback(
    (searchStr: string, caseSensitive: boolean, regex: boolean, options?: { autoNavigate?: boolean; preserveIndex?: boolean; setSelection?: boolean }) => {
      if (!editor || !searchStr) {
        setMatches([]);
        setCurrentMatchIndex(-1);
        return;
      }

      const autoNavigate = options?.autoNavigate ?? true;
      const preserveIndex = options?.preserveIndex ?? false;
      const setSelection = options?.setSelection ?? true;

      editor.getEditorState().read(() => {
        const foundMatches: SearchMatch[] = [];
        let searchPattern: RegExp;

        try {
          if (regex) {
            searchPattern = new RegExp(searchStr, caseSensitive ? 'g' : 'gi');
          } else {
            const escapedSearchString = searchStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            searchPattern = new RegExp(escapedSearchString, caseSensitive ? 'g' : 'gi');
          }
        } catch (e) {
          return;
        }

        const root = $getRoot();
        $findTextNodes(root, (textNode) => {
          const text = textNode.getTextContent();
          const key = textNode.getKey();
          let match;

          searchPattern.lastIndex = 0;
          while ((match = searchPattern.exec(text)) !== null) {
            foundMatches.push({
              key,
              offset: match.index,
              length: match[0].length,
              text: match[0],
            });
          }
        });

        setMatches(foundMatches);

        // Determine the new current index
        let newIndex: number;
        if (preserveIndex) {
          // Keep the current index if it's still valid, otherwise clamp it
          setCurrentMatchIndex(prev => {
            if (foundMatches.length === 0) {
              newIndex = -1;
              return -1;
            }
            if (prev < 0) {
              newIndex = 0;
              return 0;
            }
            newIndex = Math.min(prev, foundMatches.length - 1);
            return newIndex;
          });
        } else {
          newIndex = foundMatches.length > 0 ? 0 : -1;
          setCurrentMatchIndex(newIndex);
        }

        // Update highlights with the appropriate index
        // Use setTimeout to ensure we get the updated index after state updates
        setTimeout(() => {
          highlightManagerRef.current?.updateHighlights(foundMatches, newIndex);
        }, 0);

        // Only navigate to first match if autoNavigate is true (when user initiates search)
        if (autoNavigate && foundMatches.length > 0) {
          // When auto-navigating, pass through the setSelection option
          navigateToMatchInternal(foundMatches, 0, { refocusInput: true, setSelection });
        }
      });
    },
    [editor, navigateToMatchInternal]
  );

  // Listen to editor changes and update highlights (debounced)
  useEffect(() => {
    if (!editor || !isOpen || !searchString) {
      return;
    }

    let timeoutId: NodeJS.Timeout;

    const removeUpdateListener = editor.registerUpdateListener(({ editorState }) => {
      // Debounce to avoid updating highlights on every keystroke
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        // Don't auto-navigate when updating due to document changes
        // Preserve the current match index so it doesn't jump back to 1
        performSearch(searchString, !caseInsensitive, useRegex, {
          autoNavigate: false,
          preserveIndex: true
        });
      }, 100); // 100ms debounce
    });

    return () => {
      clearTimeout(timeoutId);
      removeUpdateListener();
    };
  }, [editor, isOpen, searchString, caseInsensitive, useRegex, performSearch]);

  // Handle search input change
  const handleSearchChange = useCallback(
    (value: string) => {
      // Save focus state before updating
      const hadFocus = document.activeElement === searchInputRef.current;
      const selectionStart = searchInputRef.current?.selectionStart ?? 0;
      const selectionEnd = searchInputRef.current?.selectionEnd ?? 0;

      setSearchString(value);

      // Clear existing debounce timeout
      if (searchDebounceRef.current) {
        clearTimeout(searchDebounceRef.current);
      }

      // Debounce the search to avoid performance issues while typing
      searchDebounceRef.current = setTimeout(() => {
        // Navigate and scroll to matches while typing, but don't set selection (prevents focus steal)
        performSearch(value, !caseInsensitive, useRegex, { autoNavigate: true, setSelection: false });
      }, 150);

      // Restore focus after state updates
      if (hadFocus && searchInputRef.current) {
        requestAnimationFrame(() => {
          searchInputRef.current?.focus();
          searchInputRef.current?.setSelectionRange(selectionStart, selectionEnd);
        });
      }
    },
    [performSearch, caseInsensitive, useRegex]
  );

  // Handle replace input change
  const handleReplaceChange = useCallback((value: string) => {
    setReplaceString(value);
  }, []);

  // Handle previous match navigation
  const handlePrevious = useCallback(() => {
    if (matches.length === 0) return;
    const newIndex = currentMatchIndex <= 0 ? matches.length - 1 : currentMatchIndex - 1;
    setCurrentMatchIndex(newIndex);
    highlightManagerRef.current?.updateHighlights(matches, newIndex);
    navigateToMatchInternal(matches, newIndex);
  }, [matches, currentMatchIndex, navigateToMatchInternal]);

  // Handle next match navigation
  const handleNext = useCallback(() => {
    if (matches.length === 0) return;
    const newIndex = currentMatchIndex >= matches.length - 1 ? 0 : currentMatchIndex + 1;
    setCurrentMatchIndex(newIndex);
    highlightManagerRef.current?.updateHighlights(matches, newIndex);
    navigateToMatchInternal(matches, newIndex);
  }, [matches, currentMatchIndex, navigateToMatchInternal]);

  // Replace current match
  const handleReplace = useCallback(() => {
    if (!editor || currentMatchIndex < 0 || currentMatchIndex >= matches.length) return;

    const match = matches[currentMatchIndex];
    editor.update(() => {
      const node = $getNodeByKey(match.key);
      if ($isTextNode(node)) {
        const text = node.getTextContent();
        const before = text.substring(0, match.offset);
        const after = text.substring(match.offset + match.length);
        const newText = before + replaceString + after;
        node.setTextContent(newText);
      }
    });

    addToHistory(REPLACE_HISTORY_KEY, replaceString);

    // Re-perform search after replacement and jump to next match
    // Use a longer timeout to ensure the editor state is fully updated
    setTimeout(() => {
      // Re-run the search with fresh editor state
      editor.getEditorState().read(() => {
        const foundMatches: SearchMatch[] = [];
        let searchPattern: RegExp;

        try {
          const regex = useRegex;
          const caseSensitive = !caseInsensitive;
          if (regex) {
            searchPattern = new RegExp(searchString, caseSensitive ? 'g' : 'gi');
          } else {
            const escapedSearchString = searchString.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            searchPattern = new RegExp(escapedSearchString, caseSensitive ? 'g' : 'gi');
          }
        } catch (e) {
          return;
        }

        const root = $getRoot();
        $findTextNodes(root, (textNode) => {
          const text = textNode.getTextContent();
          const key = textNode.getKey();
          let match;

          searchPattern.lastIndex = 0;
          while ((match = searchPattern.exec(text)) !== null) {
            foundMatches.push({
              key,
              offset: match.index,
              length: match[0].length,
              text: match[0],
            });
          }
        });

        // Update matches state
        setMatches(foundMatches);

        // After replacement, the current index now points to what was the next match
        // If we're at the end, stay at the last match
        const newIndex = foundMatches.length > 0
          ? Math.min(currentMatchIndex, foundMatches.length - 1)
          : -1;

        setCurrentMatchIndex(newIndex);

        // Update highlights and navigate to the new match
        // Schedule navigation for next tick to ensure state is fully updated
        requestAnimationFrame(() => {
          if (newIndex >= 0 && foundMatches[newIndex]) {
            highlightManagerRef.current?.updateHighlights(foundMatches, newIndex);
            navigateToMatchInternal(foundMatches, newIndex, { refocusInput: false });
          } else {
            highlightManagerRef.current?.clearHighlights();
          }
        });
      });
    }, 100);
  }, [editor, matches, currentMatchIndex, replaceString, searchString, caseInsensitive, useRegex, navigateToMatchInternal]);

  // Replace all matches
  const handleReplaceAll = useCallback(() => {
    if (!editor || matches.length === 0) return;

    editor.update(() => {
      // Group matches by node key to handle multiple replacements in the same node
      const matchesByKey = new Map<string, SearchMatch[]>();
      matches.forEach(match => {
        if (!matchesByKey.has(match.key)) {
          matchesByKey.set(match.key, []);
        }
        matchesByKey.get(match.key)!.push(match);
      });

      // Replace in reverse order within each node to maintain offsets
      matchesByKey.forEach((nodeMatches, key) => {
        const node = $getNodeByKey(key);
        if ($isTextNode(node)) {
          let text = node.getTextContent();
          // Sort matches by offset in descending order
          const sortedMatches = [...nodeMatches].sort((a, b) => b.offset - a.offset);

          sortedMatches.forEach(match => {
            const before = text.substring(0, match.offset);
            const after = text.substring(match.offset + match.length);
            text = before + replaceString + after;
          });

          node.setTextContent(text);
        }
      });
    });

    addToHistory(REPLACE_HISTORY_KEY, replaceString);

    // Clear search after replace all
    setMatches([]);
    setCurrentMatchIndex(-1);
    setSearchString('');
  }, [editor, matches, replaceString]);

  // Handle close
  const handleClose = useCallback(() => {
    if (searchString) {
      addToHistory(SEARCH_HISTORY_KEY, searchString);
    }
    SearchReplaceStateManager.close(tabId);
  }, [tabId, searchString]);

  // Handle keyboard shortcuts in search input
  const handleSearchKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Let Cmd/Ctrl+Number shortcuts bubble up to menu handlers for tab switching
      if ((e.metaKey || e.ctrlKey) && e.key >= '1' && e.key <= '9') {
        return; // Don't prevent default or stop propagation
      }

      if (e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey) {
          handlePrevious();
        } else {
          handleNext();
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        handleClose();
      }
    },
    [handleNext, handlePrevious, handleClose]
  );

  // Handle keyboard shortcuts in replace input
  const handleReplaceKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Let Cmd/Ctrl+Number shortcuts bubble up to menu handlers for tab switching
      if ((e.metaKey || e.ctrlKey) && e.key >= '1' && e.key <= '9') {
        return; // Don't prevent default or stop propagation
      }

      if (e.key === 'Enter') {
        e.preventDefault();
        if (e.metaKey || e.ctrlKey) {
          if (e.shiftKey) {
            handleReplaceAll();
          } else {
            handleReplace();
          }
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        handleClose();
      }
    },
    [handleReplace, handleReplaceAll, handleClose]
  );

  // Don't render if not open
  if (!isOpen) {
    return null;
  }

  // Common styles
  const inputStyles = "w-full px-2.5 py-1.5 text-[13px] border border-[var(--nim-border)] rounded bg-[var(--nim-bg)] text-[var(--nim-text)] outline-none transition-colors duration-150 focus:border-[var(--nim-primary)] placeholder:text-[var(--nim-text-faint)]";
  const navButtonStyles = "bg-transparent border border-[var(--nim-border)] rounded w-6 h-6 flex items-center justify-center cursor-pointer text-[var(--nim-text)] p-0 transition-colors duration-150 hover:enabled:bg-[var(--nim-bg-hover)] disabled:opacity-40 disabled:cursor-not-allowed";

  return (
    <div className="search-replace-bar bg-[var(--nim-bg-secondary)] border-b border-[var(--nim-border)] px-4 py-2 flex flex-col gap-2" data-testid="search-replace-bar">
      {/* First row: search input + options + navigation + close */}
      <div className="search-replace-bar-content flex items-center w-full gap-3">
        {/* Search icon */}
        <span className="search-replace-bar-icon flex items-center text-[var(--nim-text-muted)] shrink-0">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5"/>
            <path d="M10 10L13 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
        </span>

        {/* Search input */}
        <div className="search-replace-input-group flex-auto min-w-[120px] max-w-[400px]">
          <input
            ref={searchInputRef}
            type="text"
            className={`search-replace-input ${inputStyles}`}
            placeholder="Find..."
            value={searchString}
            tabIndex={1}
            onChange={(e) => handleSearchChange(e.target.value)}
            onKeyDown={(e) => {
              // Only stop propagation if we're actually handling the event
              // Let Cmd+Number and other unhandled shortcuts bubble up
              const shouldHandle = (
                e.key === 'Enter' ||
                e.key === 'Escape' ||
                (!((e.metaKey || e.ctrlKey) && e.key >= '1' && e.key <= '9'))
              );
              if (shouldHandle && e.key !== 'Enter' && e.key !== 'Escape') {
                e.stopPropagation();
              }
              handleSearchKeyDown(e);
            }}
            data-testid="search-input"
          />
        </div>

        {/* Options */}
        <div className="search-replace-options flex gap-1 shrink-0">
          <button
            className={`search-option-button w-7 h-7 flex items-center justify-center border border-[var(--nim-border)] rounded text-[var(--nim-text-muted)] text-xs font-semibold cursor-pointer transition-all duration-150 p-0 hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)] ${!caseInsensitive ? 'bg-[var(--nim-primary)] border-[var(--nim-primary)] text-white' : ''}`}
            tabIndex={-1}
            onClick={() => {
              const newValue = !caseInsensitive;
              setCaseInsensitive(newValue);
              performSearch(searchString, !newValue, useRegex);
            }}
            title="Match case"
            data-testid="case-toggle"
          >
            Aa
          </button>
          <button
            className={`search-option-button w-7 h-7 flex items-center justify-center border border-[var(--nim-border)] rounded text-[var(--nim-text-muted)] text-xs font-semibold cursor-pointer transition-all duration-150 p-0 hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)] ${useRegex ? 'bg-[var(--nim-primary)] border-[var(--nim-primary)] text-white' : ''}`}
            tabIndex={-1}
            onClick={() => {
              const newValue = !useRegex;
              setUseRegex(newValue);
              performSearch(searchString, !caseInsensitive, newValue);
            }}
            title="Use regular expression"
            data-testid="regex-toggle"
          >
            .*
          </button>
        </div>

        {/* Navigation */}
        <div className="search-replace-navigation flex items-center gap-2 shrink-0">
          <button
            onClick={handlePrevious}
            disabled={matches.length === 0}
            tabIndex={-1}
            aria-label="Previous match"
            className={`search-nav-button ${navButtonStyles}`}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M6 9L3 6L6 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
          <span className="search-match-counter text-[13px] text-[var(--nim-text-muted)] min-w-20 text-center select-none" data-testid="match-counter">
            {matches.length > 0 ? `${currentMatchIndex + 1} of ${matches.length}` : searchString ? 'No results' : ''}
          </span>
          <button
            onClick={handleNext}
            disabled={matches.length === 0}
            tabIndex={-1}
            aria-label="Next match"
            className={`search-nav-button ${navButtonStyles}`}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M6 3L9 6L6 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
        </div>

        {/* Close button */}
        <button
          className="search-replace-close bg-transparent border border-[var(--nim-border)] rounded w-7 h-7 flex items-center justify-center cursor-pointer text-[var(--nim-text-muted)] p-0 transition-all duration-150 shrink-0 hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)]"
          onClick={handleClose}
          tabIndex={-1}
          aria-label="Close search"
          title="Close (Esc)"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M10 4L4 10M4 4L10 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
        </button>
      </div>

      {/* Second row: replace input + actions */}
      <div className="search-replace-bar-content flex items-center w-full gap-3">
        {/* Spacer to align with search input */}
        <span className="search-replace-bar-icon flex items-center text-[var(--nim-text-muted)] shrink-0 invisible">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5"/>
            <path d="M10 10L13 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
        </span>

        {/* Replace input */}
        <div className="search-replace-input-group flex-auto min-w-[120px] max-w-[400px]">
          <input
            type="text"
            className={`search-replace-input ${inputStyles}`}
            placeholder="Replace..."
            value={replaceString}
            tabIndex={2}
            onChange={(e) => handleReplaceChange(e.target.value)}
            onKeyDown={(e) => {
              // Only stop propagation if we're actually handling the event
              // Let Cmd+Number and other unhandled shortcuts bubble up
              const shouldHandle = (
                e.key === 'Enter' ||
                e.key === 'Escape' ||
                (!((e.metaKey || e.ctrlKey) && e.key >= '1' && e.key <= '9'))
              );
              if (shouldHandle && e.key !== 'Enter' && e.key !== 'Escape') {
                e.stopPropagation();
              }
              handleReplaceKeyDown(e);
            }}
            data-testid="replace-input"
          />
        </div>

        {/* Actions */}
        <div className="search-replace-actions flex gap-2 ml-auto shrink-0">
          <button
            className="search-replace-button px-3 py-1.5 rounded-md text-[13px] font-medium cursor-pointer transition-all duration-200 bg-transparent border border-[var(--nim-border)] text-[var(--nim-text)] whitespace-nowrap hover:enabled:bg-[var(--nim-bg-hover)] disabled:opacity-40 disabled:cursor-not-allowed"
            onClick={handleReplace}
            disabled={currentMatchIndex < 0}
            tabIndex={3}
            title="Replace (Cmd+Enter)"
          >
            Replace
          </button>
          <button
            className="search-replace-button px-3 py-1.5 rounded-md text-[13px] font-medium cursor-pointer transition-all duration-200 bg-transparent border border-[var(--nim-border)] text-[var(--nim-text)] whitespace-nowrap hover:enabled:bg-[var(--nim-bg-hover)] disabled:opacity-40 disabled:cursor-not-allowed"
            onClick={handleReplaceAll}
            disabled={matches.length === 0}
            tabIndex={4}
            title="Replace All (Cmd+Shift+Enter)"
          >
            Replace All
          </button>
        </div>
      </div>
    </div>
  );
}
