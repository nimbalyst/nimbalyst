import React, { useState, useEffect, useRef, useCallback } from 'react';
import { MaterialSymbol } from '../../icons/MaterialSymbol';
import type { TranscriptViewMessage } from '../../../ai/server/transcript/TranscriptProjector';

// Augment the HighlightRegistry interface to add Map-like methods
// (TypeScript's lib.dom.d.ts has the interface but not the full Map extension without DOM.Iterable)
declare global {
  interface HighlightRegistry {
    set(name: string, highlight: Highlight): this;
    delete(name: string): boolean;
    get(name: string): Highlight | undefined;
    has(name: string): boolean;
    clear(): void;
  }
}

// Inject search highlight styles once
const injectHighlightStyles = () => {
  const styleId = 'transcript-search-highlight-styles';
  if (document.getElementById(styleId)) return;

  const style = document.createElement('style');
  style.id = styleId;
  style.textContent = `
    /* CSS Custom Highlight API styles */
    ::highlight(transcript-search) {
      background-color: color-mix(in srgb, var(--nim-warning) 35%, transparent);
    }
    ::highlight(transcript-search-current) {
      background-color: var(--nim-warning);
    }
  `;
  document.head.appendChild(style);
};

/**
 * TranscriptSearchBar - Find-in-page search UI for agent transcript messages.
 *
 * Uses the CSS Custom Highlight API for highlighting, which is specifically designed
 * for "find-on-page over virtualized documents" (per MDN). This API:
 * - Doesn't modify the DOM structure
 * - Works efficiently with virtualized lists
 * - Automatically handles elements being added/removed from DOM
 *
 * Features:
 * - Searches message content data to find all matches
 * - Works with virtualized lists (VList) where most messages aren't in DOM
 * - Uses CSS Custom Highlight API for efficient text highlighting
 * - Scrolls to message containing current match
 * - Supports case-sensitive and case-insensitive search modes
 */

interface SearchMatch {
  messageIndex: number;
  offset: number;
  length: number;
}

interface TranscriptSearchBarProps {
  isVisible: boolean;
  messages: TranscriptViewMessage[];
  containerRef: React.RefObject<HTMLDivElement | null>;
  onClose: () => void;
  onScrollToMessage: (index: number) => void;
}

export const TranscriptSearchBar: React.FC<TranscriptSearchBarProps> = ({
  isVisible,
  messages,
  containerRef,
  onClose,
  onScrollToMessage,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [currentIndex, setCurrentIndex] = useState(0);
  const [matches, setMatches] = useState<SearchMatch[]>([]);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [highlightedMessageIndices, setHighlightedMessageIndices] = useState<Set<number>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);

  // Inject highlight styles on mount
  useEffect(() => {
    injectHighlightStyles();
  }, []);

  // Navigate to next match
  const goToNextMatch = useCallback(() => {
    if (matches.length === 0) return;
    const nextIndex = (currentIndex + 1) % matches.length;
    setCurrentIndex(nextIndex);
    onScrollToMessage(matches[nextIndex].messageIndex);
  }, [matches, currentIndex, onScrollToMessage]);

  // Navigate to previous match
  const goToPrevMatch = useCallback(() => {
    if (matches.length === 0) return;
    const prevIndex = (currentIndex - 1 + matches.length) % matches.length;
    setCurrentIndex(prevIndex);
    onScrollToMessage(matches[prevIndex].messageIndex);
  }, [matches, currentIndex, onScrollToMessage]);

  // Focus input when search bar becomes visible
  useEffect(() => {
    if (isVisible && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isVisible]);

  // Listen for Cmd+G navigation events from parent
  useEffect(() => {
    if (!isVisible) return;

    const handleNext = () => goToNextMatch();
    const handlePrev = () => goToPrevMatch();

    window.addEventListener('transcript-search-next', handleNext);
    window.addEventListener('transcript-search-prev', handlePrev);

    return () => {
      window.removeEventListener('transcript-search-next', handleNext);
      window.removeEventListener('transcript-search-prev', handlePrev);
    };
  }, [isVisible, goToNextMatch, goToPrevMatch]);

  // Clear highlights using CSS Custom Highlight API
  const clearHighlights = useCallback(() => {
    CSS.highlights.delete('transcript-search');
    CSS.highlights.delete('transcript-search-current');
  }, []);

  // Clear state when component becomes hidden
  useEffect(() => {
    if (!isVisible) {
      clearHighlights();
      setSearchQuery('');
      setMatches([]);
      setCurrentIndex(0);
      setHighlightedMessageIndices(new Set());
    }
  }, [isVisible, clearHighlights]);

  // Search for matches in message data (not DOM)
  const performSearch = useCallback(
    (query: string) => {
      if (!query) {
        clearHighlights();
        setMatches([]);
        setCurrentIndex(0);
        setHighlightedMessageIndices(new Set());
        return;
      }

      const newMatches: SearchMatch[] = [];
      const messageIndicesWithMatches = new Set<number>();
      const searchRegex = new RegExp(
        query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        caseSensitive ? 'g' : 'gi'
      );

      // Search through user and assistant messages only (skip tool messages for now)
      messages.forEach((message, messageIndex) => {
        // Skip tool messages - their content is in collapsed UI elements
        if (message.type === 'tool_call' || message.type === 'interactive_prompt' || message.type === 'subagent') return;

        const content = message.text || '';
        let match: RegExpExecArray | null;

        searchRegex.lastIndex = 0;
        while ((match = searchRegex.exec(content))) {
          newMatches.push({
            messageIndex,
            offset: match.index,
            length: match[0].length,
          });
          messageIndicesWithMatches.add(messageIndex);
        }
      });

      setMatches(newMatches);
      setHighlightedMessageIndices(messageIndicesWithMatches);
      setCurrentIndex(newMatches.length > 0 ? 0 : -1);

      // Scroll to first match
      if (newMatches.length > 0) {
        onScrollToMessage(newMatches[0].messageIndex);
      }
    },
    [messages, caseSensitive, clearHighlights, onScrollToMessage]
  );

  // Update highlights using CSS Custom Highlight API
  const updateHighlights = useCallback(() => {
    if (!containerRef.current || !searchQuery || matches.length === 0) return;

    // Clear existing highlights
    CSS.highlights.delete('transcript-search');
    CSS.highlights.delete('transcript-search-current');
    const allRanges: Range[] = [];
    const currentRanges: Range[] = [];

    // Track which match index we're on globally
    let globalMatchCounter = 0;

    // Find all rendered message elements and create Range objects for highlights
    const messageElements = containerRef.current.querySelectorAll('.rich-transcript-message');

    messageElements.forEach((messageElement) => {
      const key = messageElement.getAttribute('data-message-index');
      if (!key) return;

      const messageIndex = parseInt(key, 10);
      if (isNaN(messageIndex) || !highlightedMessageIndices.has(messageIndex)) return;

      // Find the message content area (not the header with timestamp, sender, etc.)
      const contentElement = messageElement.querySelector('.rich-transcript-message-content') || messageElement;

      // Find text matches within this element
      const searchRegex = new RegExp(
        searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        caseSensitive ? 'g' : 'gi'
      );

      // Walk text nodes in the message content only
      const walker = document.createTreeWalker(
        contentElement,
        NodeFilter.SHOW_TEXT,
        null
      );

      let textNode: Node | null;

      while ((textNode = walker.nextNode())) {
        const text = textNode.textContent || '';
        if (text.length === 0) continue;

        let match: RegExpExecArray | null;
        searchRegex.lastIndex = 0;

        while ((match = searchRegex.exec(text))) {
          try {
            const range = document.createRange();
            range.setStart(textNode, match.index);
            range.setEnd(textNode, match.index + match[0].length);

            const isCurrentMatchHighlight = globalMatchCounter === currentIndex;

            if (isCurrentMatchHighlight) {
              currentRanges.push(range);
            } else {
              allRanges.push(range);
            }

            globalMatchCounter++;
          } catch {
            // Range creation can fail if offsets are invalid
          }
        }
      }
    });

    // Register the highlights with the CSS Custom Highlight API
    if (allRanges.length > 0) {
      const highlight = new Highlight(...allRanges);
      CSS.highlights.set('transcript-search', highlight);
    }

    if (currentRanges.length > 0) {
      const currentHighlight = new Highlight(...currentRanges);
      CSS.highlights.set('transcript-search-current', currentHighlight);
    }
  }, [containerRef, searchQuery, matches, currentIndex, highlightedMessageIndices, caseSensitive]);

  // Perform search when query or case sensitivity changes (debounced)
  // Note: we intentionally exclude performSearch from deps to avoid re-running on every render
  useEffect(() => {
    const timeoutId = setTimeout(() => {
      performSearch(searchQuery);
    }, 100);
    return () => clearTimeout(timeoutId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery, caseSensitive]);

  // Update highlights when matches or currentIndex changes
  // Note: we intentionally exclude updateHighlights from deps to avoid infinite loops
  useEffect(() => {
    if (isVisible && searchQuery && matches.length > 0) {
      const timeoutId = setTimeout(() => {
        updateHighlights();
      }, 50);
      return () => clearTimeout(timeoutId);
    }
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isVisible, searchQuery, matches, currentIndex]);

  // Watch for scroll and DOM changes to update highlights
  useEffect(() => {
    if (!isVisible || !searchQuery || !containerRef.current || matches.length === 0) return;

    let rafId: number | null = null;

    // Throttled update using requestAnimationFrame
    const throttledUpdate = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        updateHighlights();
        rafId = null;
      });
    };

    // Update highlights on scroll (VList re-renders elements when scrolling)
    const scrollContainer = containerRef.current.querySelector('.rich-transcript-vlist') || containerRef.current;
    scrollContainer.addEventListener('scroll', throttledUpdate, { passive: true });

    // Watch for VList rendering new message elements (not scroll button or other UI changes)
    const vlistInner = scrollContainer.firstElementChild;
    if (!vlistInner) return;

    const observer = new MutationObserver((mutations) => {
      // Only update if message elements were added/removed, not other UI elements
      const hasMessageChange = mutations.some(mutation => {
        return Array.from(mutation.addedNodes).some(node =>
          node instanceof HTMLElement && node.classList?.contains('rich-transcript-message')
        ) || Array.from(mutation.removedNodes).some(node =>
          node instanceof HTMLElement && node.classList?.contains('rich-transcript-message')
        );
      });
      if (hasMessageChange) {
        throttledUpdate();
      }
    });

    observer.observe(vlistInner, {
      childList: true,
    });

    return () => {
      scrollContainer.removeEventListener('scroll', throttledUpdate);
      observer.disconnect();
      if (rafId) cancelAnimationFrame(rafId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isVisible, searchQuery, matches.length]);

  // Cleanup highlights on unmount
  useEffect(() => {
    return () => {
      CSS.highlights.delete('transcript-search');
      CSS.highlights.delete('transcript-search-current');
    };
  }, []);

  // Handle keyboard shortcuts
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) {
        goToPrevMatch();
      } else {
        goToNextMatch();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  if (!isVisible) {
    return null;
  }

  const matchCount = matches.length;
  const displayIndex = matchCount > 0 ? currentIndex + 1 : 0;

  return (
    <div className="transcript-search-bar sticky top-0 z-10 bg-[var(--nim-bg-secondary)] border-b border-[var(--nim-border)] px-3 py-2">
      <div className="transcript-search-bar-content flex items-center gap-2 max-w-4xl mx-auto">
        <input
          ref={inputRef}
          type="text"
          className="transcript-search-input flex-1 min-w-0 px-2.5 py-1.5 text-sm bg-[var(--nim-bg)] border border-[var(--nim-border)] rounded-md text-[var(--nim-text)] outline-none transition-colors focus:border-[var(--nim-primary)] placeholder:text-[var(--nim-text-faint)]"
          placeholder="Find in transcript..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={handleKeyDown}
        />

        <div className="transcript-search-match-counter text-xs text-[var(--nim-text-muted)] whitespace-nowrap min-w-20 text-center">
          {matchCount > 0 ? `${displayIndex} of ${matchCount}` : 'No matches'}
        </div>

        <button
          className="transcript-search-button p-1.5 bg-[var(--nim-bg)] border border-[var(--nim-border)] rounded-md text-[var(--nim-text-muted)] cursor-pointer transition-all flex items-center justify-center hover:bg-[var(--nim-bg-hover)] hover:border-[var(--nim-primary)] hover:text-[var(--nim-text)] disabled:opacity-40 disabled:cursor-not-allowed"
          onClick={goToPrevMatch}
          disabled={matchCount === 0}
          title="Previous match (Shift+Enter or Cmd+Shift+G)"
        >
          <MaterialSymbol icon="keyboard_arrow_up" size={18} />
        </button>

        <button
          className="transcript-search-button p-1.5 bg-[var(--nim-bg)] border border-[var(--nim-border)] rounded-md text-[var(--nim-text-muted)] cursor-pointer transition-all flex items-center justify-center hover:bg-[var(--nim-bg-hover)] hover:border-[var(--nim-primary)] hover:text-[var(--nim-text)] disabled:opacity-40 disabled:cursor-not-allowed"
          onClick={goToNextMatch}
          disabled={matchCount === 0}
          title="Next match (Enter or Cmd+G)"
        >
          <MaterialSymbol icon="keyboard_arrow_down" size={18} />
        </button>

        <button
          className={`transcript-search-button transcript-search-case-button p-1.5 text-xs font-semibold font-mono bg-[var(--nim-bg)] border border-[var(--nim-border)] rounded-md text-[var(--nim-text-muted)] cursor-pointer transition-all flex items-center justify-center hover:bg-[var(--nim-bg-hover)] hover:border-[var(--nim-primary)] hover:text-[var(--nim-text)] ${caseSensitive ? 'bg-[var(--nim-primary)] border-[var(--nim-primary)] text-white' : ''}`}
          onClick={() => setCaseSensitive(!caseSensitive)}
          title={caseSensitive ? 'Case sensitive' : 'Case insensitive'}
          data-active={caseSensitive}
        >
          Aa
        </button>

        <button
          className="transcript-search-button transcript-search-close-button ml-1 p-1.5 bg-[var(--nim-bg)] border border-[var(--nim-border)] rounded-md text-[var(--nim-text-muted)] cursor-pointer transition-all flex items-center justify-center hover:bg-[var(--nim-bg-hover)] hover:border-[var(--nim-primary)] hover:text-[var(--nim-text)]"
          onClick={onClose}
          title="Close (Escape)"
        >
          <MaterialSymbol icon="close" size={18} />
        </button>
      </div>
    </div>
  );
};
