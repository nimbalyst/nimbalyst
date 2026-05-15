import React, { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback, memo } from 'react';
import { ProviderIcon } from '@nimbalyst/runtime';
import { getRelativeTimeString } from '../utils/dateFormatting';

interface PromptItem {
  id: string;
  sessionId: string;
  content: string;
  createdAt: number;
  sessionTitle: string;
  provider: string;
  parentSessionId?: string | null;
}

const extractPromptText = (content: string): string => {
  try {
    const parsed = JSON.parse(content);
    if (parsed.prompt) return parsed.prompt;
  } catch {
    // Not JSON, return as-is
  }
  return content;
};

const truncatePrompt = (text: string, maxLength = 120): string => {
  const extracted = extractPromptText(text);
  if (extracted.length <= maxLength) return extracted;
  return extracted.substring(0, maxLength) + '...';
};

interface PromptRowProps {
  prompt: PromptItem;
  index: number;
  isSelected: boolean;
  onSelect: (index: number) => void;
  onHover: (index: number) => void;
}

const PromptRow = memo<PromptRowProps>(({ prompt, index, isSelected, onSelect, onHover }) => {
  return (
    <li
      className={`prompt-quick-open-item py-3 px-4 cursor-pointer border-l-[3px] border-transparent transition-all duration-100 flex items-start gap-3 hover:bg-[var(--nim-bg-hover)] ${
        isSelected ? 'selected bg-[rgba(0,122,255,0.1)] !border-l-[#007aff]' : ''
      }`}
      onClick={() => onSelect(index)}
      onMouseEnter={() => onHover(index)}
    >
      <div className="prompt-quick-open-item-content flex-1 min-w-0">
        <div className="prompt-quick-open-item-text text-sm text-[var(--nim-text)] leading-[1.4] mb-1 overflow-hidden text-ellipsis line-clamp-2">
          {truncatePrompt(prompt.content)}
        </div>
        <div className="prompt-quick-open-item-meta text-xs text-[var(--nim-text-faint)] flex items-center gap-2">
          <span className="prompt-quick-open-session-title flex items-center gap-1.5 overflow-hidden text-ellipsis whitespace-nowrap">
            <span className="prompt-quick-open-item-icon shrink-0 inline-flex items-center justify-center text-[var(--nim-text-muted)]">
              <ProviderIcon provider={prompt.provider || 'claude'} size={12} />
            </span>
            {prompt.sessionTitle}
            {prompt.parentSessionId && (
              <span className="prompt-quick-open-badge workstream-badge shrink-0 text-[10px] py-0.5 px-1.5 bg-[var(--nim-primary)] text-white rounded font-semibold">
                In Workstream
              </span>
            )}
          </span>
          <span className="prompt-quick-open-time shrink-0 ml-auto">
            {getRelativeTimeString(prompt.createdAt)}
          </span>
        </div>
      </div>
    </li>
  );
});

interface PromptQuickOpenProps {
  isOpen: boolean;
  onClose: () => void;
  workspacePath: string;
  onSessionSelect: (sessionId: string, messageTimestamp?: number) => void;
  /** Pre-fill the search input when the modal opens (e.g. from Session Quick Open Tab switch) */
  initialSearchQuery?: string;
}

export const PromptQuickOpen: React.FC<PromptQuickOpenProps> = ({
  isOpen,
  onClose,
  workspacePath,
  onSessionSelect,
  initialSearchQuery,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [allPrompts, setAllPrompts] = useState<PromptItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [mouseHasMoved, setMouseHasMoved] = useState(false);
  const [copiedPromptId, setCopiedPromptId] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const resultsListRef = useRef<HTMLUListElement>(null);
  const copiedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);

  // Filter prompts in-memory by content (fast, no database query)
  const displayPrompts = useMemo(() => {
    if (!searchQuery.trim()) {
      return allPrompts;
    }
    const query = searchQuery.toLowerCase();
    return allPrompts.filter(prompt => {
      const promptText = extractPromptText(prompt.content);
      return promptText.toLowerCase().includes(query);
    });
  }, [searchQuery, allPrompts]);

  // Reset list + flip loading flag synchronously before paint so the empty state
  // never flashes "No recent prompts" while the IPC call is in flight.
  useLayoutEffect(() => {
    if (isOpen && workspacePath) {
      setAllPrompts([]);
      setIsLoading(true);
    }
  }, [isOpen, workspacePath]);

  // Load all prompts from canonical transcript events when modal opens
  useEffect(() => {
    if (isOpen && workspacePath) {
      window.electronAPI.ai
        .listUserPrompts(workspacePath)
        .then((result: { success: boolean; prompts: PromptItem[] }) => {
          if (result.success) {
            setAllPrompts(result.prompts);
          }
        })
        .catch(() => {
          // Silently fail - prompts list will remain empty
        })
        .finally(() => {
          setIsLoading(false);
        });
    }
  }, [isOpen, workspacePath]);

  // Reset state when modal opens/closes
  useEffect(() => {
    if (isOpen) {
      setSearchQuery(initialSearchQuery || '');
      setSelectedIndex(0);
      setMouseHasMoved(false);
      setTimeout(() => searchInputRef.current?.focus(), 100);
    }
  }, [isOpen]);

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

    const items = resultsListRef.current.querySelectorAll('.prompt-quick-open-item');
    const selectedItem = items[selectedIndex] as HTMLElement;

    if (selectedItem) {
      selectedItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [selectedIndex]);

  // Keyboard navigation
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        const prompt = displayPrompts[selectedIndex];
        if (prompt) {
          handleCopyPrompt(prompt);
        }
        return;
      }

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setSelectedIndex(prev =>
            prev < displayPrompts.length - 1 ? prev + 1 : prev
          );
          break;
        case 'ArrowUp':
          e.preventDefault();
          setSelectedIndex(prev => prev > 0 ? prev - 1 : prev);
          break;
        case 'Enter':
          e.preventDefault();
          if (displayPrompts[selectedIndex]) {
            handlePromptSelect(displayPrompts[selectedIndex].sessionId, displayPrompts[selectedIndex].createdAt);
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
  }, [isOpen, selectedIndex, displayPrompts, onClose]);

  // Clear any pending "copied" feedback timer on unmount or modal close
  useEffect(() => {
    if (!isOpen) {
      if (copiedTimeoutRef.current) {
        clearTimeout(copiedTimeoutRef.current);
        copiedTimeoutRef.current = null;
      }
      setCopiedPromptId(null);
    }
    return () => {
      if (copiedTimeoutRef.current) {
        clearTimeout(copiedTimeoutRef.current);
      }
    };
  }, [isOpen]);

  const handlePromptSelect = (sessionId: string, createdAt: number) => {
    onSessionSelect(sessionId, createdAt);
    onClose();
  };

  const handleCopyPrompt = (prompt: PromptItem) => {
    const text = extractPromptText(prompt.content);
    void navigator.clipboard.writeText(text);
    setCopiedPromptId(prompt.id);
    if (copiedTimeoutRef.current) {
      clearTimeout(copiedTimeoutRef.current);
    }
    copiedTimeoutRef.current = setTimeout(() => {
      setCopiedPromptId(null);
      copiedTimeoutRef.current = null;
    }, 1200);
  };

  // Stable callbacks for PromptRow so React.memo can bail out on unchanged rows.
  // Latest values are read through refs so the callback identities never change.
  const displayPromptsRef = useRef(displayPrompts);
  displayPromptsRef.current = displayPrompts;
  const mouseHasMovedRef = useRef(mouseHasMoved);
  mouseHasMovedRef.current = mouseHasMoved;
  const handlePromptSelectRef = useRef(handlePromptSelect);
  handlePromptSelectRef.current = handlePromptSelect;

  const onRowSelect = useCallback((index: number) => {
    const prompt = displayPromptsRef.current[index];
    if (prompt) {
      handlePromptSelectRef.current(prompt.sessionId, prompt.createdAt);
    }
  }, []);

  const onRowHover = useCallback((index: number) => {
    if (mouseHasMovedRef.current) {
      setSelectedIndex(index);
    }
  }, []);

  if (!isOpen) return null;

  return (
    <>
      <div
        className="prompt-quick-open-backdrop nim-overlay z-[99998]"
        onClick={onClose}
      />
      <div className="prompt-quick-open-modal fixed top-[20%] left-1/2 -translate-x-1/2 w-[90%] max-w-[700px] max-h-[60vh] flex flex-col overflow-hidden rounded-lg z-[99999] bg-[var(--nim-bg)] border border-[var(--nim-border)] shadow-[0_20px_60px_rgba(0,0,0,0.3)]">
        {copiedPromptId && (
          <div
            className="prompt-quick-open-copied-toast absolute top-2 left-1/2 -translate-x-1/2 z-10 py-1 px-3 rounded-full text-[11px] font-medium bg-[var(--nim-success)] text-white shadow"
            data-testid="prompt-quick-open-copied-toast"
          >
            Copied to clipboard
          </div>
        )}
        <div className="prompt-quick-open-header p-3 border-b border-[var(--nim-border)]">
          <div className="text-[11px] font-medium text-[var(--nim-text-faint)] uppercase tracking-wide mb-2">Prompts</div>
          <input
            ref={searchInputRef}
            type="text"
            className="prompt-quick-open-search nim-input w-full text-base"
            placeholder="Search your prompts..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>

        <div className="prompt-quick-open-results flex-1 overflow-y-auto min-h-[200px]">
          {displayPrompts.length === 0 ? (
            <div className="prompt-quick-open-empty p-10 text-center text-[var(--nim-text-faint)]">
              {isLoading
                ? 'Loading…'
                : searchQuery
                  ? 'No prompts found'
                  : 'No recent prompts'}
            </div>
          ) : (
            <ul
              className={`prompt-quick-open-list list-none m-0 p-0 ${mouseHasMoved ? '' : 'pointer-events-none'}`}
              ref={resultsListRef}
            >
              {displayPrompts.map((prompt, index) => (
                <PromptRow
                  key={prompt.id}
                  prompt={prompt}
                  index={index}
                  isSelected={index === selectedIndex}
                  onSelect={onRowSelect}
                  onHover={onRowHover}
                />
              ))}
            </ul>
          )}
        </div>

        <div className="prompt-quick-open-footer py-2 px-4 border-t border-[var(--nim-border)] flex gap-4 bg-[var(--nim-bg-secondary)]">
          <span className="prompt-quick-open-hint text-[11px] text-[var(--nim-text-faint)] flex items-center gap-1">
            <kbd className="py-0.5 px-1.5 bg-[var(--nim-bg)] border border-[var(--nim-border)] rounded font-mono text-[10px] text-[var(--nim-text)]">Up/Down</kbd> Navigate
          </span>
          <span className="prompt-quick-open-hint text-[11px] text-[var(--nim-text-faint)] flex items-center gap-1">
            <kbd className="py-0.5 px-1.5 bg-[var(--nim-bg)] border border-[var(--nim-border)] rounded font-mono text-[10px] text-[var(--nim-text)]">Enter</kbd> Open
          </span>
          <span className="prompt-quick-open-hint text-[11px] text-[var(--nim-text-faint)] flex items-center gap-1">
            <kbd className="py-0.5 px-1.5 bg-[var(--nim-bg)] border border-[var(--nim-border)] rounded font-mono text-[10px] text-[var(--nim-text)]">{isMac ? '⌘' : 'Ctrl'}</kbd>
            <kbd className="py-0.5 px-1.5 bg-[var(--nim-bg)] border border-[var(--nim-border)] rounded font-mono text-[10px] text-[var(--nim-text)]">Enter</kbd> Copy
          </span>
          <span className="prompt-quick-open-hint text-[11px] text-[var(--nim-text-faint)] flex items-center gap-1">
            <kbd className="py-0.5 px-1.5 bg-[var(--nim-bg)] border border-[var(--nim-border)] rounded font-mono text-[10px] text-[var(--nim-text)]">Esc</kbd> Close
          </span>
        </div>
      </div>
    </>
  );
};
