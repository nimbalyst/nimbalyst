/**
 * UnifiedQuickOpen
 *
 * One dialog combining Files, In Files, Sessions, Prompts, and Projects search
 * behind a single shared search input + tab strip. Replaces the four separate
 * QuickOpen / SessionQuickOpen / PromptQuickOpen / ProjectQuickOpen dialogs.
 *
 * Each pane owns its own data loading and keyboard handling (when active);
 * the shell owns the shared search query, the tab strip, and the global
 * shortcut routing that lets ⌘O/⌘L/⌘⇧F/⌘⇧L/⌘⇧P jump between tabs while the
 * dialog is open.
 */
import React, {
  useState,
  useEffect,
  useLayoutEffect,
  useRef,
  useMemo,
  useCallback,
  memo,
} from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { usePostHog } from 'posthog-js/react';
import { MaterialSymbol, ProviderIcon } from '@nimbalyst/runtime';
import { getFileName, getRelativeDir } from '../utils/pathUtils';
import { getRelativeTimeString } from '../utils/dateFormatting';
import { revealFolderAtom } from '../store';
import {
  sessionOrChildProcessingAtom,
  sessionUnreadAtom,
  sessionPendingPromptAtom,
} from '../store';
import { fileMentionOptionsAtom, searchFileMentionAtom } from '../store/atoms/fileMention';
import { setWindowModeAtom } from '../store/atoms/windowMode';
import { setTrackerModeLayoutAtom } from '../store/atoms/trackers';
import type { TypeaheadOption } from './Typeahead/GenericTypeahead';
import type { SessionMeta as SessionItem } from '../store';
import { KeyboardShortcuts, getShortcutDisplay } from '../../shared/KeyboardShortcuts';
import {
  FilterChip,
  type FilterChipHandle,
  type FilterChipOption,
} from './UnifiedQuickOpen/FilterChip';
import { useRecentHistory } from './UnifiedQuickOpen/useRecentHistory';
import { parseFileMask, matchesFileMask } from './UnifiedQuickOpen/fileMask';
import type { TrackerItem } from '@nimbalyst/runtime/core/DocumentService';

const isMac =
  typeof navigator !== 'undefined' && navigator.platform.startsWith('Mac');

// -----------------------------------------------------------------------------
// Types & constants
// -----------------------------------------------------------------------------

export type UnifiedQuickOpenTab =
  | 'search'
  | 'files'
  | 'in-files'
  | 'sessions'
  | 'prompts'
  | 'projects'
  | 'trackers';

interface TabSpec {
  id: UnifiedQuickOpenTab;
  label: string;
  /** KeyboardShortcuts.* value, or undefined for tabs with no global shortcut. */
  shortcut?: string;
}

interface DisabledTabSpec {
  id: string;
  label: string;
  soon: true;
}

// Global semantic-search tab. Prepended to the tab strip only when the
// nimbalyst-memory engine is running (soft launch — hidden otherwise).
const SEARCH_TAB_SPEC: TabSpec = {
  id: 'search',
  label: 'Search',
  shortcut: KeyboardShortcuts.window.globalSearch,
};

const TAB_SPECS: TabSpec[] = [
  { id: 'files', label: 'Files', shortcut: KeyboardShortcuts.file.open },
  { id: 'in-files', label: 'In Files', shortcut: KeyboardShortcuts.window.contentSearch },
  { id: 'sessions', label: 'Sessions', shortcut: KeyboardShortcuts.window.sessionQuickOpen },
  { id: 'prompts', label: 'Prompts', shortcut: KeyboardShortcuts.window.promptQuickOpen },
  { id: 'projects', label: 'Projects', shortcut: KeyboardShortcuts.window.projectQuickOpen },
  { id: 'trackers', label: 'Trackers' },
];

const FUTURE_TABS: DisabledTabSpec[] = [];

// File mask options for the Files / In Files filter chip. Values are
// comma-separated glob patterns — same syntax as the git extension's file
// mask. The curated list covers common languages; users can type any custom
// glob (e.g. "*.vue", "src/**/*.test.ts", "*.ts,*.tsx") via free-text input.
const FILE_EXT_OPTIONS: FilterChipOption[] = [
  { value: '*.ts,*.tsx', label: 'TypeScript' },
  { value: '*.js,*.jsx,*.mjs,*.cjs', label: 'JavaScript' },
  { value: '*.md,*.mdx', label: 'Markdown' },
  { value: '*.json', label: 'JSON' },
  { value: '*.css,*.scss,*.less', label: 'Styles' },
  { value: '*.html,*.htm', label: 'HTML' },
  { value: '*.py', label: 'Python' },
  { value: '*.go', label: 'Go' },
  { value: '*.rs', label: 'Rust' },
  { value: '*.swift', label: 'Swift' },
  { value: '*.yaml,*.yml,*.toml', label: 'Config' },
];

// Default tracker types shown in the Trackers tab filter chip. Fetched
// dynamically from `trackerSchema.getAll()` at runtime; this is the fallback.
const DEFAULT_TRACKER_TYPE_OPTIONS: FilterChipOption[] = [
  { value: 'bug', label: 'Bug', icon: 'bug_report' },
  { value: 'task', label: 'Task', icon: 'task_alt' },
  { value: 'plan', label: 'Plan', icon: 'flag' },
  { value: 'idea', label: 'Idea', icon: 'lightbulb' },
  { value: 'decision', label: 'Decision', icon: 'gavel' },
  { value: 'feature', label: 'Feature', icon: 'auto_awesome' },
];

const RECENT_FILE_EXT_KEY = 'unifiedQuickOpen.recentFileMasks';
const RECENT_TRACKER_TYPE_KEY = 'unifiedQuickOpen.recentTrackerTypes';
const SELECTED_FILE_EXT_KEY = 'unifiedQuickOpen.selectedFileMask';
const SELECTED_TRACKER_TYPE_KEY = 'unifiedQuickOpen.selectedTrackerType';

// Tracker status badge colors. Kept here so the Trackers pane and any future
// status filter stay consistent with the tracker mode UI.
const TRACKER_STATUS_COLOR: Record<string, string> = {
  open: 'var(--nim-text-faint)',
  'in-progress': 'var(--nim-primary)',
  'in-review': 'var(--nim-warning)',
  completed: 'var(--nim-success)',
  blocked: 'var(--nim-error)',
  rejected: 'var(--nim-text-faint)',
};

export interface UnifiedQuickOpenProps {
  isOpen: boolean;
  onClose: () => void;
  workspacePath: string;
  currentFilePath?: string | null;
  initialTab?: UnifiedQuickOpenTab;
  onFileSelect: (filePath: string) => void;
  onFolderSelect?: (folderPath: string) => void;
  onSessionSelect: (sessionId: string) => void;
  onPromptSelect: (sessionId: string, messageTimestamp?: number) => void;
  /**
   * Optional override for tracker open. Defaults to switching to tracker mode
   * and selecting the item via Jotai atoms. Pass to short-circuit for tests.
   */
  onTrackerSelect?: (trackerId: string) => void;
}

function usePersistedFilterValue(storageKey: string): [string | null, (value: string | null) => void] {
  const [value, setValue] = useState<string | null>(null);
  const loadedRef = useRef(false);
  const changedBeforeLoadRef = useRef(false);
  const latestValueRef = useRef<string | null>(null);

  const persistValue = useCallback(
    (next: string | null) => {
      const api = (window as any).electronAPI;
      if (!api?.invoke) return;
      api.invoke('app-settings:set', storageKey, next).catch(() => {
        /* ignore */
      });
    },
    [storageKey],
  );

  useEffect(() => {
    let cancelled = false;
    const api = (window as any).electronAPI;
    if (!api?.invoke) {
      loadedRef.current = true;
      return;
    }

    api
      .invoke('app-settings:get', storageKey)
      .then((stored: unknown) => {
        if (cancelled) return;
        loadedRef.current = true;
        if (changedBeforeLoadRef.current) {
          persistValue(latestValueRef.current);
          return;
        }
        const next = typeof stored === 'string' && stored.trim() ? stored : null;
        latestValueRef.current = next;
        setValue(next);
      })
      .catch(() => {
        if (cancelled) return;
        loadedRef.current = true;
        if (changedBeforeLoadRef.current) {
          persistValue(latestValueRef.current);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [storageKey, persistValue]);

  useEffect(() => {
    if (!loadedRef.current) return;
    persistValue(value);
  }, [value, persistValue]);

  const setPersistedValue = useCallback((next: string | null) => {
    changedBeforeLoadRef.current = !loadedRef.current;
    latestValueRef.current = next;
    setValue(next);
  }, []);

  return [value, setPersistedValue];
}

// -----------------------------------------------------------------------------
// Main shell
// -----------------------------------------------------------------------------

export const UnifiedQuickOpen: React.FC<UnifiedQuickOpenProps> = ({
  isOpen,
  onClose,
  workspacePath,
  currentFilePath,
  initialTab = 'files',
  onFileSelect,
  onFolderSelect,
  onSessionSelect,
  onPromptSelect,
  onTrackerSelect,
}) => {
  const [activeTab, setActiveTab] = useState<UnifiedQuickOpenTab>(initialTab);
  const [query, setQuery] = useState('');
  // Per-tab Sessions sub-filter: when the user picks a file via @typeahead, we
  // store the chip here and the Sessions pane filters its list by it.
  const [sessionFileFilter, setSessionFileFilter] = useState<string | null>(null);
  // Bumped to ask the Sessions pane to run a message-content search (Shift+Tab).
  const [sessionContentNonce, setSessionContentNonce] = useState(0);
  // Bumped to ask the Sessions pane to drop back to title-filter mode.
  const [sessionContentClearNonce, setSessionContentClearNonce] = useState(0);
  // Sessions pane reports its content-search status so the in-input button can reflect it.
  const [sessionContentStatus, setSessionContentStatus] = useState<
    'idle' | 'searching' | 'results'
  >('idle');
  // Per-tab filter chip values, hoisted so they survive tab switches.
  const [fileExtFilter, setFileExtFilter] = usePersistedFilterValue(SELECTED_FILE_EXT_KEY);
  const [trackerTypeFilter, setTrackerTypeFilter] = usePersistedFilterValue(SELECTED_TRACKER_TYPE_KEY);
  const inputRef = useRef<HTMLInputElement>(null);
  const trackerTypeFilterRef = useRef<FilterChipHandle>(null);
  // Whether the nimbalyst-memory engine is running for this workspace. `null`
  // until the async check resolves (so we don't bounce off the Search tab while
  // it's still being determined). When false, the Search tab is hidden entirely.
  const [searchAvailable, setSearchAvailable] = useState<boolean | null>(null);
  const visibleTabs = useMemo(
    () => (searchAvailable === true ? [SEARCH_TAB_SPEC, ...TAB_SPECS] : TAB_SPECS),
    [searchAvailable],
  );

  // Recent-history dropdowns (persisted to app-settings).
  const fileExtHistory = useRecentHistory(RECENT_FILE_EXT_KEY);
  const trackerTypeHistory = useRecentHistory(RECENT_TRACKER_TYPE_KEY);

  // Default tracker-select handler: switch the main window into tracker mode
  // and ask it to open the chosen item via the existing layout atom.
  const setWindowMode = useSetAtom(setWindowModeAtom);
  const setTrackerLayout = useSetAtom(setTrackerModeLayoutAtom);
  const handleTrackerSelectDefault = useCallback(
    (trackerId: string) => {
      if (onTrackerSelect) {
        onTrackerSelect(trackerId);
        return;
      }
      setWindowMode('tracker');
      setTrackerLayout({ selectedType: 'all', selectedItemId: trackerId });
    },
    [onTrackerSelect, setWindowMode, setTrackerLayout],
  );

  // Reset on open. We intentionally do NOT reset the filter chips — the user
  // wants those to feel sticky across opens within a session.
  useEffect(() => {
    if (isOpen) {
      setActiveTab(initialTab);
      setQuery('');
      setSessionFileFilter(null);
      // Focus shortly after mount so React has time to render the input.
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen, initialTab]);

  // Probe memory-engine availability each time the dialog opens so the Search
  // tab appears/disappears with the extension's enabled state.
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    window.electronAPI.semanticSearch
      ?.isAvailable(workspacePath)
      .then((ok) => {
        if (!cancelled) setSearchAvailable(!!ok);
      })
      .catch(() => {
        if (!cancelled) setSearchAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, workspacePath]);

  // If we opened straight onto the Search tab (Cmd+Shift+O) but memory turned
  // out to be off, fall back to Files rather than showing an empty pane. Only
  // fires once the check has resolved (false, not null).
  useEffect(() => {
    if (activeTab === 'search' && searchAvailable === false) {
      setActiveTab('files');
    }
  }, [activeTab, searchAvailable]);

  // Switch tabs without losing focus on the input.
  const switchTab = useCallback((tab: UnifiedQuickOpenTab) => {
    setActiveTab(tab);
    setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  const openTrackerTypeFilter = useCallback(() => {
    setActiveTab('trackers');
    setTimeout(() => trackerTypeFilterRef.current?.open(), 0);
  }, []);

  // Tab / Shift+Tab cycles tabs. We use capture to win over any per-pane
  // handler that might also listen to Tab.
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Cycle tabs with Tab / Shift+Tab
      if (e.key === 'Tab') {
        e.preventDefault();
        e.stopPropagation();
        // On the Sessions tab, Shift+Tab runs a message-content search instead
        // of cycling back a tab (mirrors Session History's content-search key).
        if (
          e.shiftKey &&
          activeTab === 'sessions' &&
          query.trim() &&
          !query.startsWith('@')
        ) {
          setSessionContentNonce((n) => n + 1);
          return;
        }
        const idx = visibleTabs.findIndex((t) => t.id === activeTab);
        const nextIdx = e.shiftKey
          ? (idx - 1 + visibleTabs.length) % visibleTabs.length
          : (idx + 1) % visibleTabs.length;
        switchTab(visibleTabs[nextIdx].id);
        return;
      }

      if (
        e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        !e.shiftKey &&
        (e.key === 'T' || e.key === 't')
      ) {
        e.preventDefault();
        e.stopPropagation();
        openTrackerTypeFilter();
        return;
      }

      // Global shortcuts also jump tabs while the dialog is open.
      const isAppModifier = isMac ? e.metaKey : e.ctrlKey;
      if (!isAppModifier) return;

      // Cmd+Shift+P → Projects
      if (e.shiftKey && (e.key === 'P' || e.key === 'p')) {
        e.preventDefault();
        e.stopPropagation();
        switchTab('projects');
        return;
      }
      // Cmd+Shift+F → In Files
      if (e.shiftKey && (e.key === 'F' || e.key === 'f')) {
        e.preventDefault();
        e.stopPropagation();
        switchTab('in-files');
        return;
      }
      // Cmd+Shift+L → Prompts
      if (e.shiftKey && (e.key === 'L' || e.key === 'l')) {
        e.preventDefault();
        e.stopPropagation();
        switchTab('prompts');
        return;
      }
      // Cmd+Shift+O → Search (only when memory is available)
      if (e.shiftKey && (e.key === 'O' || e.key === 'o')) {
        e.preventDefault();
        e.stopPropagation();
        if (searchAvailable === true) switchTab('search');
        return;
      }
      // Cmd+O → Files
      if (!e.shiftKey && e.key === 'o') {
        e.preventDefault();
        e.stopPropagation();
        switchTab('files');
        return;
      }
      // Cmd+L → Sessions
      if (!e.shiftKey && e.key === 'l') {
        e.preventDefault();
        e.stopPropagation();
        switchTab('sessions');
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [isOpen, activeTab, switchTab, query, openTrackerTypeFilter, visibleTabs, searchAvailable]);

  if (!isOpen) return null;

  // The in-input "Search contents" affordance only applies to the Sessions tab
  // when there's a real query (not the @file-edited typeahead).
  const showSessionContentHint =
    activeTab === 'sessions' && !!query.trim() && !query.startsWith('@');

  const placeholder =
    activeTab === 'search'
      ? 'Search everything by meaning — trackers, docs, sessions...'
      : activeTab === 'projects'
        ? 'Search projects...'
        : activeTab === 'in-files'
          ? 'Search in file contents...'
          : activeTab === 'sessions'
            ? 'Search sessions... (@ to filter by file edited)'
            : activeTab === 'prompts'
              ? 'Search your prompts...'
              : 'Search files...';

  return (
    <>
      <div
        className="unified-quick-open-backdrop fixed inset-0 z-[99998] nim-animate-fade-in bg-black/50"
        onClick={onClose}
      />
      <div
        className="unified-quick-open-modal fixed top-[15%] left-1/2 -translate-x-1/2 w-[92%] max-w-[820px] max-h-[70vh] flex flex-col overflow-hidden rounded-lg z-[99999] bg-nim border border-nim shadow-[0_20px_60px_rgba(0,0,0,0.3)]"
        data-testid="unified-quick-open"
      >
        {/* Tab strip — equal-width tabs so the row stays stable when switching
            (the kbd chip widths varied otherwise). */}
        <div
          className="unified-quick-open-tabs flex items-stretch border-b border-nim bg-nim-secondary"
          role="tablist"
        >
          {visibleTabs.map((tab) => {
            const active = tab.id === activeTab;
            return (
              <button
                key={tab.id}
                role="tab"
                aria-selected={active}
                data-tab={tab.id}
                className={`unified-quick-open-tab flex-1 min-w-0 flex items-center justify-center gap-1.5 px-2 py-1.5 text-[13px] font-medium whitespace-nowrap border-b-2 cursor-pointer transition-colors duration-100 ${
                  active
                    ? 'text-nim border-[var(--nim-primary)] bg-nim'
                    : 'text-nim-muted border-transparent hover:text-nim hover:bg-nim-hover'
                }`}
                onClick={() => switchTab(tab.id)}
                tabIndex={-1}
              >
                <span>{tab.label}</span>
                {tab.shortcut && (
                  <kbd
                    className={`unified-quick-open-tab-shortcut font-mono text-[10px] px-1.5 py-0.5 rounded border min-w-[26px] text-center ${
                      active
                        ? 'text-[var(--nim-primary)] border-[var(--nim-primary)] bg-transparent'
                        : 'text-nim-faint border-nim bg-nim-secondary'
                    }`}
                  >
                    {getShortcutDisplay(tab.shortcut)}
                  </kbd>
                )}
              </button>
            );
          })}
          {FUTURE_TABS.map((tab) => (
            <div
              key={tab.id}
              className="unified-quick-open-tab future flex-1 min-w-0 flex items-center justify-center gap-1.5 px-2 py-1.5 text-[13px] font-medium whitespace-nowrap border-b-2 border-transparent text-nim-faint italic cursor-not-allowed opacity-60"
              title="Coming soon"
            >
              <span>{tab.label}</span>
              <span className="text-[9px] uppercase tracking-wide text-nim-faint not-italic">
                soon
              </span>
            </div>
          ))}
        </div>

        {/* Shared search input + per-tab filter chips on the right edge so
            they're always reachable without leaving the keyboard row. */}
        <div className="unified-quick-open-search-bar px-2 py-1.5 border-b border-nim bg-nim">
          <div className="flex items-center gap-2">
            <div className="flex-1 min-w-0 relative">
              <input
                ref={inputRef}
                type="text"
                className={`unified-quick-open-search nim-input w-full text-sm py-1 px-2 ${
                  showSessionContentHint ? 'pr-[156px]' : ''
                }`}
                placeholder={placeholder}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                data-testid="unified-quick-open-search"
              />
              {showSessionContentHint &&
                (sessionContentStatus === 'searching' ? (
                  <span className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1 text-xs text-nim-faint pointer-events-none">
                    <MaterialSymbol icon="progress_activity" size={13} className="animate-spin" />
                    Searching messages...
                  </span>
                ) : sessionContentStatus === 'results' ? (
                  <button
                    type="button"
                    className="unified-quick-open-content-search-active absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1 text-xs text-[var(--nim-primary)] bg-transparent border-none cursor-pointer px-2 py-1 rounded transition-colors duration-150 hover:bg-nim-hover"
                    onClick={() => setSessionContentClearNonce((n) => n + 1)}
                    title="Back to title search"
                  >
                    <MaterialSymbol icon="manage_search" size={13} />
                    Message matches
                    <MaterialSymbol icon="close" size={12} />
                  </button>
                ) : (
                  <button
                    type="button"
                    className="unified-quick-open-content-search-hint absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1 text-xs text-nim-muted bg-transparent border-none cursor-pointer px-2 py-1 rounded transition-colors duration-150 hover:bg-nim-hover hover:text-[var(--nim-primary)]"
                    onClick={() => setSessionContentNonce((n) => n + 1)}
                    title="Press Shift+Tab to search message contents"
                  >
                    ⇧⇥ Search contents
                  </button>
                ))}
            </div>
            {(activeTab === 'files' || activeTab === 'in-files') && (
              <FilterChip
                label="Mask"
                value={fileExtFilter}
                onChange={setFileExtFilter}
                options={FILE_EXT_OPTIONS}
                history={fileExtHistory.history}
                onAddToHistory={fileExtHistory.remember}
                onRemoveFromHistory={fileExtHistory.forget}
                freeText
                placeholder="*.ts,*.tsx"
              />
            )}
            {activeTab === 'trackers' && (
              <FilterChip
                ref={trackerTypeFilterRef}
                label="Type"
                value={trackerTypeFilter}
                onChange={setTrackerTypeFilter}
                options={DEFAULT_TRACKER_TYPE_OPTIONS}
                history={trackerTypeHistory.history}
                onAddToHistory={trackerTypeHistory.remember}
                onRemoveFromHistory={trackerTypeHistory.forget}
                freeText
                placeholder="custom-type"
              />
            )}
          </div>
        </div>

        {/* Active pane — others are mounted but hidden so their data stays
            loaded and re-activating a tab is instant. */}
        <div className="unified-quick-open-results flex-1 overflow-hidden flex flex-col min-h-[260px]">
          {searchAvailable === true && (
            <div className={activeTab === 'search' ? 'contents' : 'hidden'}>
              <SearchPane
                isOpen={isOpen}
                isActive={activeTab === 'search'}
                query={activeTab === 'search' ? query : ''}
                workspacePath={workspacePath}
                onTrackerSelect={handleTrackerSelectDefault}
                onFileSelect={onFileSelect}
                onSessionSelect={onSessionSelect}
                onClose={onClose}
              />
            </div>
          )}
          <div className={activeTab === 'files' ? 'contents' : 'hidden'}>
            <FilesPane
              isOpen={isOpen}
              isActive={activeTab === 'files'}
              query={activeTab === 'files' ? query : ''}
              extFilter={fileExtFilter}
              workspacePath={workspacePath}
              currentFilePath={currentFilePath}
              onFileSelect={onFileSelect}
              onFolderSelect={onFolderSelect}
              onClose={onClose}
              onShowFileSessions={(filePath) => {
                setSessionFileFilter(filePath);
                switchTab('sessions');
              }}
            />
          </div>
          <div className={activeTab === 'in-files' ? 'contents' : 'hidden'}>
            <InFilesPane
              isOpen={isOpen}
              isActive={activeTab === 'in-files'}
              query={activeTab === 'in-files' ? query : ''}
              extFilter={fileExtFilter}
              workspacePath={workspacePath}
              onFileSelect={onFileSelect}
              onClose={onClose}
            />
          </div>
          <div className={activeTab === 'trackers' ? 'contents' : 'hidden'}>
            <TrackersPane
              isOpen={isOpen}
              isActive={activeTab === 'trackers'}
              query={activeTab === 'trackers' ? query : ''}
              typeFilter={trackerTypeFilter}
              workspacePath={workspacePath}
              onTrackerSelect={handleTrackerSelectDefault}
              onClose={onClose}
            />
          </div>
          <div className={activeTab === 'sessions' ? 'contents' : 'hidden'}>
            <SessionsPane
              isOpen={isOpen}
              isActive={activeTab === 'sessions'}
              query={activeTab === 'sessions' ? query : ''}
              setQuery={setQuery}
              workspacePath={workspacePath}
              fileFilter={sessionFileFilter}
              setFileFilter={setSessionFileFilter}
              contentSearchNonce={sessionContentNonce}
              contentClearNonce={sessionContentClearNonce}
              onContentStatusChange={setSessionContentStatus}
              onSessionSelect={onSessionSelect}
              onClose={onClose}
            />
          </div>
          <div className={activeTab === 'prompts' ? 'contents' : 'hidden'}>
            <PromptsPane
              isOpen={isOpen}
              isActive={activeTab === 'prompts'}
              query={activeTab === 'prompts' ? query : ''}
              workspacePath={workspacePath}
              onPromptSelect={onPromptSelect}
              onClose={onClose}
            />
          </div>
          <div className={activeTab === 'projects' ? 'contents' : 'hidden'}>
            <ProjectsPane
              isOpen={isOpen}
              isActive={activeTab === 'projects'}
              query={activeTab === 'projects' ? query : ''}
              currentWorkspacePath={workspacePath}
              onClose={onClose}
            />
          </div>
        </div>

        {/* Footer */}
        <div className="unified-quick-open-footer flex justify-between gap-3 px-4 py-2 border-t border-nim bg-nim-secondary">
          <div className="flex gap-4 flex-wrap">
            <FooterHint kbd="↑↓" label="Navigate" />
            <FooterHint
              kbd="Enter"
              label={activeTab === 'prompts' ? 'Open at this prompt' : 'Open'}
            />
            <FooterHint kbd="Tab" label="Next tab" />
            {activeTab === 'trackers' && <FooterHint kbd="Ctrl+T" label="Type" />}
            <FooterHint kbd="Esc" label="Close" />
          </div>
        </div>
      </div>
    </>
  );
};

const FooterHint: React.FC<{ kbd: string; label: string }> = ({ kbd, label }) => (
  <span className="unified-quick-open-hint text-[11px] flex items-center gap-1 text-nim-faint">
    <kbd className="px-1.5 py-0.5 rounded font-mono text-[10px] bg-nim border border-nim text-nim">
      {kbd}
    </kbd>
    {label}
  </span>
);

// =============================================================================
// FilesPane — name search + recent files
// =============================================================================

interface FileItem {
  path: string;
  name: string;
  type?: 'file' | 'directory';
  isRecent?: boolean;
  matches?: Array<{ line: number; text: string; start: number; end: number }>;
  isFileNameMatch?: boolean;
  isContentMatch?: boolean;
}

interface FilesPaneProps {
  isOpen: boolean;
  isActive: boolean;
  query: string;
  /** File-extension filter (e.g. ".ts"). Null means no filter. */
  extFilter: string | null;
  workspacePath: string;
  currentFilePath?: string | null;
  onFileSelect: (filePath: string) => void;
  onFolderSelect?: (folderPath: string) => void;
  onShowFileSessions?: (filePath: string) => void;
  onClose: () => void;
}

const FilesPane: React.FC<FilesPaneProps> = memo(({
  isOpen,
  isActive,
  query,
  extFilter,
  workspacePath,
  currentFilePath,
  onFileSelect,
  onFolderSelect,
  onShowFileSessions,
  onClose,
}) => {
  const posthog = usePostHog();
  const revealFolder = useSetAtom(revealFolderAtom);
  const [results, setResults] = useState<FileItem[]>([]);
  const [recentFiles, setRecentFiles] = useState<string[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [mouseHasMoved, setMouseHasMoved] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const searchTimeoutRef = useRef<NodeJS.Timeout>();
  const listRef = useRef<HTMLUListElement>(null);

  // Load recent files when dialog opens. We pass the explicit workspacePath
  // so the main process scopes the list to THIS workspace (see #301).
  useEffect(() => {
    if (!isOpen) return;
    window.electronAPI?.getRecentWorkspaceFiles?.(workspacePath)
      ?.then((files) => setRecentFiles(files || []))
      ?.catch(() => setRecentFiles([]));

    // Warm the file name cache
    const api = (window as any).electronAPI;
    if (api?.buildQuickOpenCache && workspacePath) {
      api.buildQuickOpenCache(workspacePath).catch(() => {});
    }
  }, [isOpen, workspacePath]);

  // Reset selected index when query changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  // Debounced file name search
  useEffect(() => {
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    if (!query.trim()) {
      setResults([]);
      return;
    }
    searchTimeoutRef.current = setTimeout(async () => {
      setIsSearching(true);
      try {
        const api = (window as any).electronAPI;
        if (!api?.searchWorkspaceFileNames) {
          setResults([]);
          return;
        }
        const fileNameResults = await api.searchWorkspaceFileNames(
          workspacePath,
          query,
          extFilter ? { fileMask: extFilter } : undefined,
        );
        if (Array.isArray(fileNameResults)) {
          const processed: FileItem[] = fileNameResults.map((r: any) => ({
            path: r.path,
            name: getFileName(r.path),
            type: r.type,
            isRecent: recentFiles.includes(r.path),
            matches: r.matches || [],
            isFileNameMatch: r.isFileNameMatch || false,
            isContentMatch: false,
          }));
          setResults(processed);

          // Analytics
          try {
            const queryLength = query.length;
            const queryLengthCategory =
              queryLength > 20 ? 'long' : queryLength > 10 ? 'medium' : 'short';
            const c = processed.length;
            const resultCountBucket =
              c === 0
                ? '0'
                : c <= 10
                  ? '1-10'
                  : c <= 50
                    ? '11-50'
                    : c <= 100
                      ? '51-100'
                      : '100+';
            posthog?.capture('workspace_search_used', {
              resultCount: resultCountBucket,
              queryLength: queryLengthCategory,
              searchType: 'file_name',
            });
          } catch {
            /* ignore */
          }
        } else {
          setResults([]);
        }
      } finally {
        setIsSearching(false);
      }
    }, 150);
    return () => {
      if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    };
  }, [query, extFilter, workspacePath, recentFiles, posthog]);

  const recentItems: FileItem[] = useMemo(
    () =>
      recentFiles
        .filter((p) => p !== currentFilePath)
        .map((p) => ({ path: p, name: getFileName(p), isRecent: true })),
    [recentFiles, currentFilePath],
  );

  // Apply the file-mask filter client-side. Same comma-separated glob syntax
  // as the git extension (e.g. "*.ts,*.tsx", "src/**/*.test.ts").
  const maskPatterns = useMemo(
    () => (extFilter ? parseFileMask(extFilter) : []),
    [extFilter],
  );
  const displayFiles = useMemo(() => {
    const base = query ? results : recentItems;
    if (maskPatterns.length === 0) return base;
    return base.filter((f) => {
      if (f.type === 'directory') return false;
      return matchesFileMask(f.path, maskPatterns);
    });
  }, [query, results, recentItems, maskPatterns]);

  // Track mouse movement
  useEffect(() => {
    if (!isOpen) return;
    const onMove = () => setMouseHasMoved(true);
    window.addEventListener('mousemove', onMove);
    return () => window.removeEventListener('mousemove', onMove);
  }, [isOpen]);

  // Scroll selected into view
  useEffect(() => {
    if (!listRef.current) return;
    const items = listRef.current.querySelectorAll('.unified-quick-open-item');
    const item = items[selectedIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selectedIndex]);

  const handleSelect = useCallback(
    (file: FileItem) => {
      if (file.type === 'directory') {
        onFolderSelect?.(file.path);
        revealFolder(file.path);
        onClose();
        return;
      }
      onFileSelect(file.path);
      onClose();
    },
    [onFileSelect, onFolderSelect, onClose, revealFolder],
  );

  // Keyboard navigation — only when this pane is active
  useEffect(() => {
    if (!isOpen || !isActive) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setSelectedIndex((i) => (i < displayFiles.length - 1 ? i + 1 : i));
          break;
        case 'ArrowUp':
          e.preventDefault();
          setSelectedIndex((i) => (i > 0 ? i - 1 : i));
          break;
        case 'Enter':
          e.preventDefault();
          if (displayFiles[selectedIndex]) handleSelect(displayFiles[selectedIndex]);
          break;
        case 'Escape':
          e.preventDefault();
          onClose();
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, isActive, displayFiles, selectedIndex, handleSelect, onClose]);

  return (
    <div className="files-pane flex-1 overflow-y-auto">
      {displayFiles.length === 0 ? (
        <div className="p-10 text-center text-nim-faint">
          {isSearching ? 'Searching...' : query ? 'No files found' : 'No recent files'}
        </div>
      ) : (
        <ul
          ref={listRef}
          className={`list-none m-0 p-0 ${mouseHasMoved ? '' : 'pointer-events-none'}`}
        >
          {displayFiles.map((file, index) => (
            <li
              key={`${file.path}-${index}`}
              className={`unified-quick-open-item relative group px-4 py-2.5 cursor-pointer border-l-[3px] transition-all duration-100 ${
                index === selectedIndex
                  ? 'selected bg-nim-selected border-l-nim-primary'
                  : 'border-transparent hover:bg-nim-hover'
              }`}
              onClick={() => handleSelect(file)}
              onMouseEnter={() => {
                if (mouseHasMoved) setSelectedIndex(index);
              }}
            >
              {onShowFileSessions && file.type !== 'directory' && (
                <button
                  className={`absolute right-3 top-2.5 p-1 rounded border-none cursor-pointer bg-transparent text-nim-faint hover:text-[var(--nim-primary)] hover:bg-[var(--nim-accent-subtle)] ${
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
              <div className="text-sm font-medium flex items-center gap-2 text-nim">
                {file.type === 'directory' && (
                  <MaterialSymbol icon="folder" size={16} className="text-nim-faint shrink-0" />
                )}
                {file.type === 'directory' ? file.name + '/' : file.name}
                {file.isRecent && !query && (
                  <span className="nim-badge-primary text-[10px]">Recent</span>
                )}
              </div>
              <div className="text-xs mt-0.5 overflow-hidden text-ellipsis whitespace-nowrap text-nim-faint">
                {getRelativeDir(file.path, workspacePath)}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
});

// =============================================================================
// InFilesPane — content search (lazy, only runs when this tab is active)
// =============================================================================

interface InFilesPaneProps {
  isOpen: boolean;
  isActive: boolean;
  query: string;
  /** File-extension filter (e.g. ".ts"). Null means no filter. */
  extFilter: string | null;
  workspacePath: string;
  onFileSelect: (filePath: string) => void;
  onClose: () => void;
}

const InFilesPane: React.FC<InFilesPaneProps> = memo(({
  isOpen,
  isActive,
  query,
  extFilter,
  workspacePath,
  onFileSelect,
  onClose,
}) => {
  const posthog = usePostHog();
  const [results, setResults] = useState<FileItem[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [mouseHasMoved, setMouseHasMoved] = useState(false);
  const searchTimeoutRef = useRef<NodeJS.Timeout>();
  const listRef = useRef<HTMLUListElement>(null);
  const lastQueryRef = useRef<string>('');

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  // Run content search only when this pane is active AND the query changed
  // since the last run. This is the lazy bit: switching to In Files with a
  // stale query reruns at most once.
  useEffect(() => {
    if (!isOpen || !isActive) return;
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    if (!query.trim()) {
      setResults([]);
      lastQueryRef.current = '';
      return;
    }
    if (lastQueryRef.current === query) return;

    searchTimeoutRef.current = setTimeout(async () => {
      setIsSearching(true);
      lastQueryRef.current = query;
      try {
        const api = (window as any).electronAPI;
        if (!api?.searchWorkspaceFileContent) {
          setResults([]);
          return;
        }
        const contentResults = await api.searchWorkspaceFileContent(workspacePath, query);
        if (Array.isArray(contentResults)) {
          const processed: FileItem[] = contentResults.map((r: any) => ({
            path: r.path,
            name: getFileName(r.path),
            matches: r.matches || [],
            isContentMatch: true,
            isFileNameMatch: false,
          }));
          processed.sort((a, b) => (b.matches?.length || 0) - (a.matches?.length || 0));
          setResults(processed);

          try {
            const queryLength = query.length;
            const queryLengthCategory =
              queryLength > 20 ? 'long' : queryLength > 10 ? 'medium' : 'short';
            const c = processed.length;
            const resultCountBucket =
              c === 0
                ? '0'
                : c <= 10
                  ? '1-10'
                  : c <= 50
                    ? '11-50'
                    : c <= 100
                      ? '51-100'
                      : '100+';
            posthog?.capture('workspace_search_used', {
              resultCount: resultCountBucket,
              queryLength: queryLengthCategory,
              searchType: 'content',
            });
          } catch {
            /* ignore */
          }
        }
      } finally {
        setIsSearching(false);
      }
    }, 200);
    return () => {
      if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    };
  }, [isOpen, isActive, query, workspacePath, posthog]);

  // Reset cached lastQuery when modal closes
  useEffect(() => {
    if (!isOpen) {
      lastQueryRef.current = '';
      setResults([]);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const onMove = () => setMouseHasMoved(true);
    window.addEventListener('mousemove', onMove);
    return () => window.removeEventListener('mousemove', onMove);
  }, [isOpen]);

  useEffect(() => {
    if (!listRef.current) return;
    const items = listRef.current.querySelectorAll('.unified-quick-open-item');
    const item = items[selectedIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selectedIndex]);

  const handleSelect = useCallback(
    (file: FileItem) => {
      onFileSelect(file.path);
      onClose();
    },
    [onFileSelect, onClose],
  );

  // Narrow to the active mask client-side. Cheaper than another ripgrep.
  // Same comma-separated glob syntax as the git extension.
  const maskPatterns = useMemo(
    () => (extFilter ? parseFileMask(extFilter) : []),
    [extFilter],
  );
  const displayResults = useMemo(() => {
    if (maskPatterns.length === 0) return results;
    return results.filter((f) => matchesFileMask(f.path, maskPatterns));
  }, [results, maskPatterns]);

  useEffect(() => {
    if (!isOpen || !isActive) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setSelectedIndex((i) => (i < displayResults.length - 1 ? i + 1 : i));
          break;
        case 'ArrowUp':
          e.preventDefault();
          setSelectedIndex((i) => (i > 0 ? i - 1 : i));
          break;
        case 'Enter':
          e.preventDefault();
          if (displayResults[selectedIndex]) handleSelect(displayResults[selectedIndex]);
          break;
        case 'Escape':
          e.preventDefault();
          onClose();
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, isActive, displayResults, selectedIndex, handleSelect, onClose]);

  return (
    <div className="in-files-pane flex-1 overflow-y-auto">
      {displayResults.length === 0 ? (
        <div className="p-10 text-center text-nim-faint">
          {isSearching
            ? 'Searching file contents...'
            : query
              ? extFilter
                ? `No matches with ${extFilter}`
                : 'No matches'
              : 'Type to search file contents'}
        </div>
      ) : (
        <ul
          ref={listRef}
          className={`list-none m-0 p-0 ${mouseHasMoved ? '' : 'pointer-events-none'}`}
        >
          {displayResults.map((file, index) => (
            <li
              key={`${file.path}-${index}`}
              className={`unified-quick-open-item px-4 py-2.5 cursor-pointer border-l-[3px] transition-all duration-100 ${
                index === selectedIndex
                  ? 'selected bg-nim-selected border-l-nim-primary'
                  : 'border-transparent hover:bg-nim-hover'
              }`}
              onClick={() => handleSelect(file)}
              onMouseEnter={() => {
                if (mouseHasMoved) setSelectedIndex(index);
              }}
            >
              <div className="text-sm font-medium flex items-center gap-2 text-nim">
                {file.name}
                {file.matches && file.matches.length > 0 && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded text-white font-semibold uppercase bg-[var(--nim-accent-purple)]">
                    {file.matches.length} match{file.matches.length > 1 ? 'es' : ''}
                  </span>
                )}
              </div>
              <div className="text-xs mt-0.5 overflow-hidden text-ellipsis whitespace-nowrap text-nim-faint">
                {getRelativeDir(file.path, workspacePath)}
              </div>
              {file.matches && file.matches.length > 0 && (
                <div className="mt-2 pl-2 border-l-2 border-nim">
                  {file.matches.slice(0, 2).map((m, i) => (
                    <div
                      key={i}
                      className="text-xs leading-snug mb-1 block overflow-hidden text-ellipsis whitespace-nowrap text-nim-muted"
                    >
                      <span className="mr-2 font-medium text-nim-faint">Line {m.line}:</span>
                      <span>
                        {m.text.substring(0, m.start)}
                        <mark className="px-0.5 rounded font-semibold bg-[var(--nim-highlight-bg)] text-[var(--nim-highlight-text)]">
                          {m.text.substring(m.start, m.end)}
                        </mark>
                        {m.text.substring(m.end)}
                      </span>
                    </div>
                  ))}
                  {file.matches.length > 2 && (
                    <div className="text-[11px] italic mt-1 text-nim-faint">
                      ...and {file.matches.length - 2} more
                    </div>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
});

// =============================================================================
// SessionsPane
// =============================================================================

const SessionStatusIndicator = memo<{ sessionId: string }>(({ sessionId }) => {
  const isProcessing = useAtomValue(sessionOrChildProcessingAtom(sessionId));
  const hasPendingPrompt = useAtomValue(sessionPendingPromptAtom(sessionId));
  const hasUnread = useAtomValue(sessionUnreadAtom(sessionId));

  if (isProcessing) {
    return (
      <div className="flex items-center justify-center w-5 h-5 text-[var(--nim-primary)] opacity-80" title="Processing...">
        <MaterialSymbol icon="progress_activity" size={14} className="animate-spin" />
      </div>
    );
  }
  if (hasPendingPrompt) {
    return (
      <div className="flex items-center justify-center w-5 h-5 text-[var(--nim-warning)] animate-pulse" title="Waiting for your response">
        <MaterialSymbol icon="help" size={14} />
      </div>
    );
  }
  if (hasUnread) {
    return (
      <div className="flex items-center justify-center w-5 h-5 text-[var(--nim-primary)]" title="Unread response">
        <MaterialSymbol icon="circle" size={8} fill />
      </div>
    );
  }
  return null;
});

interface SessionsPaneProps {
  isOpen: boolean;
  isActive: boolean;
  query: string;
  setQuery: (q: string) => void;
  workspacePath: string;
  fileFilter: string | null;
  setFileFilter: (path: string | null) => void;
  contentSearchNonce: number;
  contentClearNonce: number;
  onContentStatusChange: (status: 'idle' | 'searching' | 'results') => void;
  onSessionSelect: (sessionId: string) => void;
  onClose: () => void;
}

const SessionsPane: React.FC<SessionsPaneProps> = memo(({
  isOpen,
  isActive,
  query,
  setQuery,
  workspacePath,
  fileFilter,
  setFileFilter,
  contentSearchNonce,
  contentClearNonce,
  onContentStatusChange,
  onSessionSelect,
  onClose,
}) => {
  const [allSessions, setAllSessions] = useState<SessionItem[]>([]);
  const [fileFilteredIds, setFileFilteredIds] = useState<string[] | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [typeaheadIndex, setTypeaheadIndex] = useState(0);
  const [mouseHasMoved, setMouseHasMoved] = useState(false);
  // Message-content search (Shift+Tab / button): null = title-filter mode,
  // an array = showing sessions whose message text matched the query.
  const [contentResults, setContentResults] = useState<SessionItem[] | null>(null);
  const [contentSearchedQuery, setContentSearchedQuery] = useState<string | null>(null);
  const [contentSearching, setContentSearching] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);
  const searchDebounceRef = useRef<NodeJS.Timeout>();
  const visibleQuery = isActive ? query : '';

  // @ typeahead — only active when query starts with @ and no file is selected yet
  const isFileSearchMode = visibleQuery.startsWith('@') && !fileFilter;
  const fileSearchQuery = isFileSearchMode ? visibleQuery.slice(1) : '';
  const fileOptions = useAtomValue(fileMentionOptionsAtom(workspacePath));
  const searchFileMention = useSetAtom(searchFileMentionAtom);

  useEffect(() => {
    setSelectedIndex(0);
  }, [visibleQuery, fileFilter]);

  // Run a full-text search over message contents for the current query.
  const triggerContentSearch = useCallback(async () => {
    const q = visibleQuery.trim();
    if (!q || isFileSearchMode || fileFilter) return;
    setContentSearching(true);
    try {
      const result = await window.electronAPI.invoke('sessions:search', workspacePath, q, {
        includeArchived: false,
      });
      const sessions: SessionItem[] =
        result?.success && Array.isArray(result.sessions) ? result.sessions : [];
      setContentResults(sessions);
      setContentSearchedQuery(q);
      setSelectedIndex(0);
    } catch {
      setContentResults([]);
      setContentSearchedQuery(q);
    } finally {
      setContentSearching(false);
    }
  }, [visibleQuery, isFileSearchMode, fileFilter, workspacePath]);

  // Parent bumps contentSearchNonce on Shift+Tab; run the search via a ref so we
  // don't re-fire every time the query (and thus the callback identity) changes.
  const triggerRef = useRef(triggerContentSearch);
  triggerRef.current = triggerContentSearch;
  useEffect(() => {
    if (contentSearchNonce > 0) triggerRef.current();
  }, [contentSearchNonce]);

  // Parent bumps contentClearNonce to drop back to title-filter mode.
  useEffect(() => {
    if (contentClearNonce > 0) {
      setContentResults(null);
      setContentSearchedQuery(null);
      setSelectedIndex(0);
    }
  }, [contentClearNonce]);

  // Report content-search status up so the parent's in-input button can reflect it.
  useEffect(() => {
    onContentStatusChange(
      contentSearching ? 'searching' : contentResults !== null ? 'results' : 'idle',
    );
  }, [contentSearching, contentResults, onContentStatusChange]);

  // Drop back to title-filter mode when the query no longer matches what we
  // content-searched, or when @file filtering takes over.
  useEffect(() => {
    if (contentResults === null) return;
    const stale =
      visibleQuery.trim() !== contentSearchedQuery ||
      isFileSearchMode ||
      !!fileFilter ||
      !isActive;
    if (stale) {
      setContentResults(null);
      setContentSearchedQuery(null);
    }
  }, [visibleQuery, contentSearchedQuery, contentResults, isFileSearchMode, fileFilter, isActive]);

  // Load all sessions when opened
  useEffect(() => {
    if (!isOpen || !workspacePath) return;
    window.electronAPI
      .invoke('sessions:list', workspacePath, { includeArchived: false })
      .then((result: { success: boolean; sessions: SessionItem[] }) => {
        if (result.success && Array.isArray(result.sessions)) {
          setAllSessions(result.sessions);
        } else {
          setAllSessions([]);
        }
      })
      .catch(() => setAllSessions([]));
  }, [isOpen, workspacePath]);

  // File mention typeahead search (debounced) — only when in typeahead mode AND active
  useEffect(() => {
    if (!isOpen || !isActive || !isFileSearchMode) return;
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => {
      searchFileMention({ workspacePath, query: fileSearchQuery });
    }, 150);
    return () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    };
  }, [isOpen, isActive, isFileSearchMode, fileSearchQuery, workspacePath, searchFileMention]);

  // When a file is selected, fetch session IDs that edited it
  useEffect(() => {
    if (!isOpen || !fileFilter) {
      setFileFilteredIds(null);
      return;
    }
    const absolutePath = fileFilter.startsWith('/')
      ? fileFilter
      : `${workspacePath}/${fileFilter}`;
    window.electronAPI
      .invoke('session-files:get-sessions-by-file', workspacePath, absolutePath, 'edited')
      .then((result: { success: boolean; sessionIds: string[] }) => {
        setFileFilteredIds(result.success ? result.sessionIds : []);
      })
      .catch(() => setFileFilteredIds([]));
  }, [isOpen, fileFilter, workspacePath]);

  const displaySessions = useMemo(() => {
    // File-filtered mode
    if (fileFilter && fileFilteredIds !== null) {
      return allSessions.filter((s) => fileFilteredIds.includes(s.id));
    }
    // Typeahead mode: don't filter sessions; they're hidden behind typeahead anyway
    if (isFileSearchMode) return allSessions;
    // Content-search mode: show sessions whose message text matched
    if (contentResults !== null) return contentResults;
    // Normal title search
    if (!visibleQuery.trim()) return allSessions;
    const q = visibleQuery.toLowerCase();
    return allSessions.filter((s) =>
      (s.title || 'New conversation').toLowerCase().includes(q),
    );
  }, [allSessions, visibleQuery, fileFilter, fileFilteredIds, isFileSearchMode, contentResults]);

  const handleFileTypeaheadSelect = useCallback(
    (option: TypeaheadOption) => {
      const filePath = (option.data as any)?.path || option.label;
      setFileFilter(filePath);
      setQuery('');
      setSelectedIndex(0);
    },
    [setFileFilter, setQuery],
  );

  useEffect(() => {
    if (!isOpen) return;
    const onMove = () => setMouseHasMoved(true);
    window.addEventListener('mousemove', onMove);
    return () => window.removeEventListener('mousemove', onMove);
  }, [isOpen]);

  useEffect(() => {
    if (!listRef.current) return;
    const items = listRef.current.querySelectorAll('.unified-quick-open-item');
    const item = items[selectedIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selectedIndex]);

  const handleSelect = useCallback(
    (id: string) => {
      onSessionSelect(id);
      onClose();
    },
    [onSessionSelect, onClose],
  );

  // Keyboard: typeahead overrides arrows/enter when shown
  const showTypeahead = isFileSearchMode && fileOptions.length > 0;
  useEffect(() => {
    if (!isOpen || !isActive) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (showTypeahead) {
        switch (e.key) {
          case 'ArrowDown':
            e.preventDefault();
            setTypeaheadIndex((i) => (i < fileOptions.length - 1 ? i + 1 : i));
            return;
          case 'ArrowUp':
            e.preventDefault();
            setTypeaheadIndex((i) => (i > 0 ? i - 1 : i));
            return;
          case 'Enter':
            e.preventDefault();
            if (fileOptions[typeaheadIndex]) {
              handleFileTypeaheadSelect(fileOptions[typeaheadIndex]);
            }
            return;
          case 'Escape':
            e.preventDefault();
            setQuery('');
            setFileFilter(null);
            return;
        }
      }
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setSelectedIndex((i) => (i < displaySessions.length - 1 ? i + 1 : i));
          break;
        case 'ArrowUp':
          e.preventDefault();
          setSelectedIndex((i) => (i > 0 ? i - 1 : i));
          break;
        case 'Enter':
          e.preventDefault();
          if (displaySessions[selectedIndex]) handleSelect(displaySessions[selectedIndex].id);
          break;
        case 'Escape':
          e.preventDefault();
          if (fileFilter) {
            setFileFilter(null);
            setQuery('');
          } else {
            onClose();
          }
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    isOpen,
    isActive,
    showTypeahead,
    fileOptions,
    typeaheadIndex,
    handleFileTypeaheadSelect,
    displaySessions,
    selectedIndex,
    handleSelect,
    onClose,
    fileFilter,
    setFileFilter,
    setQuery,
  ]);

  return (
    <div className="sessions-pane flex-1 flex flex-col overflow-hidden">
      {fileFilter && (
        <div className="flex items-center gap-2 px-4 py-1.5 text-xs text-nim-muted border-b border-nim bg-[var(--nim-accent-subtle)]">
          <span className="text-nim-faint">Filtered to sessions that edited:</span>
          <span
            className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-[rgba(0,122,255,0.15)] text-[var(--nim-primary)] text-xs max-w-[60%]"
            title={fileFilter}
          >
            <MaterialSymbol icon="description" size={14} className="shrink-0" />
            <span className="overflow-hidden text-ellipsis whitespace-nowrap">{fileFilter}</span>
            <button
              className="shrink-0 flex items-center justify-center w-4 h-4 rounded-full border-none bg-transparent text-nim-faint hover:text-nim hover:bg-nim-tertiary cursor-pointer p-0"
              onClick={() => {
                setFileFilter(null);
                setQuery('');
              }}
              title="Clear file filter"
            >
              <MaterialSymbol icon="close" size={12} />
            </button>
          </span>
        </div>
      )}
      <div className="flex-1 overflow-y-auto">
        {showTypeahead ? (
          <ul className={`list-none m-0 p-0 ${mouseHasMoved ? '' : 'pointer-events-none'}`}>
            {fileOptions.length === 0 ? (
              <li className="py-6 px-4 text-center text-nim-faint text-sm">
                {fileSearchQuery ? 'No files found' : 'Type to search files...'}
              </li>
            ) : (
              fileOptions.slice(0, 20).map((option, index) => (
                <li
                  key={option.id}
                  className={`flex items-center gap-3 py-2 px-4 cursor-pointer transition-all duration-100 hover:bg-nim-hover ${
                    index === typeaheadIndex ? 'bg-[rgba(0,122,255,0.1)]' : ''
                  }`}
                  onClick={() => handleFileTypeaheadSelect(option)}
                  onMouseEnter={() => {
                    if (mouseHasMoved) setTypeaheadIndex(index);
                  }}
                >
                  <span className="shrink-0 flex items-center justify-center w-5 h-5 text-nim-muted">
                    {typeof option.icon === 'string' ? (
                      <MaterialSymbol icon={option.icon} size={16} />
                    ) : (
                      option.icon
                    )}
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="text-sm text-nim block overflow-hidden text-ellipsis whitespace-nowrap">
                      {option.label}
                    </span>
                    {option.description && (
                      <span className="text-xs text-nim-faint block overflow-hidden text-ellipsis whitespace-nowrap">
                        {option.description}
                      </span>
                    )}
                  </span>
                </li>
              ))
            )}
          </ul>
        ) : displaySessions.length === 0 ? (
          <div className="p-10 text-center text-nim-faint">
            {fileFilter
              ? `No sessions edited ${fileFilter}`
              : query
                ? 'No sessions found'
                : 'No recent sessions'}
          </div>
        ) : (
          <ul
            ref={listRef}
            className={`list-none m-0 p-0 ${mouseHasMoved ? '' : 'pointer-events-none'}`}
          >
            {displaySessions.map((session, index) => (
              <li
                key={session.id}
                className={`unified-quick-open-item flex items-start gap-3 py-2.5 px-4 cursor-pointer border-l-[3px] transition-all duration-100 ${
                  index === selectedIndex
                    ? 'selected bg-nim-selected border-l-nim-primary'
                    : 'border-transparent hover:bg-nim-hover'
                }`}
                onClick={() => handleSelect(session.id)}
                onMouseEnter={() => {
                  if (mouseHasMoved) setSelectedIndex(index);
                }}
              >
                <div className="shrink-0 flex items-center justify-center pt-0.5 text-nim-muted">
                  <ProviderIcon provider={session.provider || 'claude'} size={16} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-nim flex items-center gap-2 overflow-hidden text-ellipsis whitespace-nowrap">
                    {session.title || 'New conversation'}
                    {session.parentSessionId && (
                      <span className="shrink-0 text-[10px] py-0.5 px-1.5 rounded font-semibold bg-[var(--nim-primary)] text-white">
                        In Workstream
                      </span>
                    )}
                    {session.worktreeId && (
                      <span className="shrink-0 text-[10px] py-0.5 px-1.5 rounded font-semibold bg-[var(--nim-success)] text-white">
                        Worktree
                      </span>
                    )}
                    {session.messageCount > 0 && (
                      <span className="shrink-0 text-[10px] py-0.5 px-1.5 rounded font-semibold bg-nim-faint text-white">
                        {session.messageCount} msg{session.messageCount !== 1 ? 's' : ''}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-nim-faint mt-0.5">
                    {getRelativeTimeString(session.updatedAt)}
                  </div>
                </div>
                <div className="shrink-0 flex items-center gap-1.5 ml-auto">
                  {session.uncommittedCount !== undefined && session.uncommittedCount > 0 && (
                    <span
                      className="shrink-0 text-[10px] py-0.5 px-1.5 rounded font-semibold bg-[rgba(245,158,11,0.15)] text-[var(--nim-warning)]"
                      title={`${session.uncommittedCount} uncommitted change${session.uncommittedCount !== 1 ? 's' : ''}`}
                    >
                      {session.uncommittedCount}
                    </span>
                  )}
                  <SessionStatusIndicator sessionId={session.id} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
});

// =============================================================================
// PromptsPane
// =============================================================================

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
    /* not JSON */
  }
  return content;
};

const truncatePrompt = (text: string, maxLength = 120): string => {
  const extracted = extractPromptText(text);
  return extracted.length <= maxLength ? extracted : extracted.substring(0, maxLength) + '...';
};

interface PromptsPaneProps {
  isOpen: boolean;
  isActive: boolean;
  query: string;
  workspacePath: string;
  onPromptSelect: (sessionId: string, messageTimestamp?: number) => void;
  onClose: () => void;
}

const PromptsPane: React.FC<PromptsPaneProps> = memo(({
  isOpen,
  isActive,
  query,
  workspacePath,
  onPromptSelect,
  onClose,
}) => {
  const [allPrompts, setAllPrompts] = useState<PromptItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [mouseHasMoved, setMouseHasMoved] = useState(false);
  const [copiedPromptId, setCopiedPromptId] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const copiedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const visibleQuery = isActive ? query : '';

  useEffect(() => {
    setSelectedIndex(0);
  }, [visibleQuery]);

  // Reset list synchronously before paint so the empty state doesn't flash
  // "No recent prompts" while the IPC call is in flight.
  useLayoutEffect(() => {
    if (isOpen && workspacePath) {
      setAllPrompts([]);
      setIsLoading(true);
    }
  }, [isOpen, workspacePath]);

  useEffect(() => {
    if (!isOpen || !workspacePath) return;
    window.electronAPI.ai
      .listUserPrompts(workspacePath)
      .then((result: { success: boolean; prompts: PromptItem[] }) => {
        if (result.success) setAllPrompts(result.prompts);
      })
      .catch(() => {
        /* leave empty */
      })
      .finally(() => setIsLoading(false));
  }, [isOpen, workspacePath]);

  const displayPrompts = useMemo(() => {
    if (!visibleQuery.trim()) return allPrompts;
    const q = visibleQuery.toLowerCase();
    return allPrompts.filter((p) => extractPromptText(p.content).toLowerCase().includes(q));
  }, [visibleQuery, allPrompts]);

  useEffect(() => {
    if (!isOpen) return;
    const onMove = () => setMouseHasMoved(true);
    window.addEventListener('mousemove', onMove);
    return () => window.removeEventListener('mousemove', onMove);
  }, [isOpen]);

  useEffect(() => {
    if (!listRef.current) return;
    const items = listRef.current.querySelectorAll('.unified-quick-open-item');
    const item = items[selectedIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selectedIndex]);

  const handleSelect = useCallback(
    (p: PromptItem) => {
      onPromptSelect(p.sessionId, p.createdAt);
      onClose();
    },
    [onPromptSelect, onClose],
  );

  const handleCopy = useCallback((p: PromptItem) => {
    const text = extractPromptText(p.content);
    void navigator.clipboard.writeText(text);
    setCopiedPromptId(p.id);
    if (copiedTimeoutRef.current) clearTimeout(copiedTimeoutRef.current);
    copiedTimeoutRef.current = setTimeout(() => {
      setCopiedPromptId(null);
      copiedTimeoutRef.current = null;
    }, 1200);
  }, []);

  useEffect(() => {
    if (!isOpen && copiedTimeoutRef.current) {
      clearTimeout(copiedTimeoutRef.current);
      copiedTimeoutRef.current = null;
      setCopiedPromptId(null);
    }
    return () => {
      if (copiedTimeoutRef.current) clearTimeout(copiedTimeoutRef.current);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !isActive) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        const p = displayPrompts[selectedIndex];
        if (p) handleCopy(p);
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setSelectedIndex((i) => (i < displayPrompts.length - 1 ? i + 1 : i));
          break;
        case 'ArrowUp':
          e.preventDefault();
          setSelectedIndex((i) => (i > 0 ? i - 1 : i));
          break;
        case 'Enter':
          e.preventDefault();
          if (displayPrompts[selectedIndex]) handleSelect(displayPrompts[selectedIndex]);
          break;
        case 'Escape':
          e.preventDefault();
          onClose();
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, isActive, displayPrompts, selectedIndex, handleSelect, handleCopy, onClose]);

  return (
    <div className="prompts-pane flex-1 overflow-y-auto relative">
      {copiedPromptId && (
        <div
          className="absolute top-2 left-1/2 -translate-x-1/2 z-10 py-1 px-3 rounded-full text-[11px] font-medium bg-[var(--nim-success)] text-white shadow"
          data-testid="prompt-quick-open-copied-toast"
        >
          Copied to clipboard
        </div>
      )}
      {displayPrompts.length === 0 ? (
        <div className="p-10 text-center text-nim-faint">
          {isLoading ? 'Loading...' : query ? 'No prompts found' : 'No recent prompts'}
        </div>
      ) : (
        <ul
          ref={listRef}
          className={`list-none m-0 p-0 ${mouseHasMoved ? '' : 'pointer-events-none'}`}
        >
          {displayPrompts.map((prompt, index) => (
            <li
              key={prompt.id}
              className={`unified-quick-open-item py-3 px-4 cursor-pointer border-l-[3px] flex items-start gap-3 transition-all duration-100 ${
                index === selectedIndex
                  ? 'selected bg-nim-selected border-l-nim-primary'
                  : 'border-transparent hover:bg-nim-hover'
              }`}
              onClick={() => handleSelect(prompt)}
              onMouseEnter={() => {
                if (mouseHasMoved) setSelectedIndex(index);
              }}
            >
              <div className="flex-1 min-w-0">
                <div className="text-sm text-nim leading-snug mb-1 overflow-hidden text-ellipsis line-clamp-2">
                  {truncatePrompt(prompt.content)}
                </div>
                <div className="text-xs text-nim-faint flex items-center gap-2">
                  <span className="flex items-center gap-1.5 overflow-hidden text-ellipsis whitespace-nowrap">
                    <span className="shrink-0 inline-flex items-center justify-center text-nim-muted">
                      <ProviderIcon provider={prompt.provider || 'claude'} size={12} />
                    </span>
                    {prompt.sessionTitle}
                    {prompt.parentSessionId && (
                      <span className="shrink-0 text-[10px] py-0.5 px-1.5 bg-[var(--nim-primary)] text-white rounded font-semibold">
                        In Workstream
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 ml-auto">{getRelativeTimeString(prompt.createdAt)}</span>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
});

// =============================================================================
// ProjectsPane
// =============================================================================

interface ProjectItem {
  path: string;
  name: string;
  lastOpened?: number;
  isOpen: boolean;
  isCurrent: boolean;
}

interface RecentWorkspaceItem {
  path: string;
  name?: string;
  timestamp?: number;
  lastOpened?: number;
}

interface ProjectsPaneProps {
  isOpen: boolean;
  isActive: boolean;
  query: string;
  currentWorkspacePath: string | null;
  onClose: () => void;
}

const ProjectsPane: React.FC<ProjectsPaneProps> = memo(({
  isOpen,
  isActive,
  query,
  currentWorkspacePath,
  onClose,
}) => {
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [mouseHasMoved, setMouseHasMoved] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);
  const visibleQuery = isActive ? query : '';

  useEffect(() => {
    setSelectedIndex(0);
  }, [visibleQuery]);

  useEffect(() => {
    if (!isOpen) return;
    (async () => {
      const [recentWorkspaces, openPaths] = await Promise.all([
        window.electronAPI.invoke('get-recent-workspaces') as Promise<RecentWorkspaceItem[]>,
        window.electronAPI.workspaceManager.getOpenWorkspaces(),
      ]);
      const openSet = new Set(openPaths);
      const items: ProjectItem[] = recentWorkspaces.map((ws) => ({
        path: ws.path,
        name: ws.name || ws.path.split('/').pop() || ws.path,
        lastOpened: ws.lastOpened || ws.timestamp,
        isOpen: openSet.has(ws.path),
        isCurrent: ws.path === currentWorkspacePath,
      }));
      items.sort((a, b) => {
        if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
        if (a.isOpen !== b.isOpen) return a.isOpen ? -1 : 1;
        return (b.lastOpened || 0) - (a.lastOpened || 0);
      });
      setProjects(items);
    })();
  }, [isOpen, currentWorkspacePath]);

  const displayProjects = useMemo(() => {
    if (!visibleQuery.trim()) return projects;
    const q = visibleQuery.toLowerCase();
    return projects.filter(
      (p) => p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q),
    );
  }, [visibleQuery, projects]);

  useEffect(() => {
    if (!isOpen) return;
    const onMove = () => setMouseHasMoved(true);
    window.addEventListener('mousemove', onMove);
    return () => window.removeEventListener('mousemove', onMove);
  }, [isOpen]);

  useEffect(() => {
    if (!listRef.current) return;
    const items = listRef.current.querySelectorAll('.unified-quick-open-item');
    const item = items[selectedIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selectedIndex]);

  const handleSelect = useCallback(
    async (p: ProjectItem) => {
      onClose();
      await window.electronAPI.workspaceManager.openWorkspace(p.path);
    },
    [onClose],
  );

  useEffect(() => {
    if (!isOpen || !isActive) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setSelectedIndex((i) => (i < displayProjects.length - 1 ? i + 1 : i));
          break;
        case 'ArrowUp':
          e.preventDefault();
          setSelectedIndex((i) => (i > 0 ? i - 1 : i));
          break;
        case 'Enter':
          e.preventDefault();
          if (displayProjects[selectedIndex]) handleSelect(displayProjects[selectedIndex]);
          break;
        case 'Escape':
          e.preventDefault();
          onClose();
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, isActive, displayProjects, selectedIndex, handleSelect, onClose]);

  return (
    <div className="projects-pane flex-1 overflow-y-auto">
      {displayProjects.length === 0 ? (
        <div className="p-10 text-center text-nim-faint">
          {query ? 'No projects found' : 'No recent projects'}
        </div>
      ) : (
        <ul
          ref={listRef}
          className={`list-none m-0 p-0 ${mouseHasMoved ? '' : 'pointer-events-none'}`}
        >
          {displayProjects.map((project, index) => (
            <li
              key={project.path}
              className={`unified-quick-open-item flex items-center gap-3 py-2.5 px-4 cursor-pointer border-l-[3px] transition-all duration-100 ${
                index === selectedIndex
                  ? 'selected bg-nim-selected border-l-nim-primary'
                  : 'border-transparent hover:bg-nim-hover'
              }`}
              onClick={() => handleSelect(project)}
              onMouseEnter={() => {
                if (mouseHasMoved) setSelectedIndex(index);
              }}
            >
              <div className="shrink-0 flex items-center justify-center w-5 h-5 text-nim-muted">
                <MaterialSymbol icon="folder" size={16} fill={project.isOpen} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-nim flex items-center gap-2 overflow-hidden text-ellipsis whitespace-nowrap">
                  {project.name}
                  {project.isCurrent && (
                    <span className="shrink-0 text-[10px] py-0.5 px-1.5 rounded font-semibold bg-[var(--nim-primary)] text-white">
                      Current
                    </span>
                  )}
                  {project.isOpen && !project.isCurrent && (
                    <span className="shrink-0 text-[10px] py-0.5 px-1.5 rounded font-semibold bg-[var(--nim-success)] text-white">
                      Open
                    </span>
                  )}
                </div>
                <div className="text-xs text-nim-faint mt-0.5 overflow-hidden text-ellipsis whitespace-nowrap direction-rtl text-left">
                  {project.path}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
});

// =============================================================================
// SearchPane — global semantic search across trackers / docs / sessions
// =============================================================================

interface SearchPaneProps {
  isOpen: boolean;
  isActive: boolean;
  query: string;
  workspacePath: string;
  onTrackerSelect: (trackerId: string) => void;
  onFileSelect: (filePath: string) => void;
  onSessionSelect: (sessionId: string) => void;
  onClose: () => void;
}

function refTypeLabel(result: SemanticSearchResult): string {
  switch (result.refType) {
    case 'tracker':
      return 'Tracker';
    case 'session':
      return 'Session';
    case 'doc-file':
      return 'Document';
    default:
      return result.sourceClass || result.refType;
  }
}

function refTypeIcon(refType: string): string {
  switch (refType) {
    case 'tracker':
      return 'label';
    case 'session':
      return 'forum';
    case 'doc-file':
      return 'description';
    default:
      return 'search';
  }
}

const SearchPane: React.FC<SearchPaneProps> = memo(({
  isOpen,
  isActive,
  query,
  workspacePath,
  onTrackerSelect,
  onFileSelect,
  onSessionSelect,
  onClose,
}) => {
  const [results, setResults] = useState<SemanticSearchResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [mouseHasMoved, setMouseHasMoved] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);
  // Guards against out-of-order responses clobbering a newer query's results.
  const latestReq = useRef(0);
  const visibleQuery = isActive ? query : '';

  useEffect(() => {
    setSelectedIndex(0);
  }, [visibleQuery]);

  // Debounced query → engine. Embedding the query is per-submit, not per
  // keystroke, so a short debounce keeps the dialog responsive.
  useEffect(() => {
    if (!isOpen || !isActive) return;
    const q = visibleQuery.trim();
    if (!q) {
      setResults([]);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    const reqId = ++latestReq.current;
    const timer = setTimeout(() => {
      window.electronAPI.semanticSearch
        .query(workspacePath, q, 25)
        .then((res) => {
          if (reqId === latestReq.current) setResults(Array.isArray(res) ? res : []);
        })
        .catch(() => {
          if (reqId === latestReq.current) setResults([]);
        })
        .finally(() => {
          if (reqId === latestReq.current) setIsLoading(false);
        });
    }, 200);
    return () => clearTimeout(timer);
  }, [isOpen, isActive, visibleQuery, workspacePath]);

  useEffect(() => {
    if (!isOpen) return;
    const onMove = () => setMouseHasMoved(true);
    window.addEventListener('mousemove', onMove);
    return () => window.removeEventListener('mousemove', onMove);
  }, [isOpen]);

  useEffect(() => {
    if (!listRef.current) return;
    const els = listRef.current.querySelectorAll('.unified-quick-open-item');
    const el = els[selectedIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selectedIndex]);

  const handleSelect = useCallback(
    (result: SemanticSearchResult) => {
      if (result.refType === 'tracker') {
        onTrackerSelect(result.refId);
      } else if (result.refType === 'session') {
        onSessionSelect(result.refId);
      } else {
        // doc-file: refId is the engine's workspace-relative POSIX path, but the
        // file opener needs an absolute path — resolve it against workspacePath.
        const rel = result.refId;
        const isAbsolute = rel.startsWith('/') || /^[A-Za-z]:[\\/]/.test(rel);
        const abs = isAbsolute
          ? rel
          : `${workspacePath.replace(/[\\/]+$/, '')}/${rel.replace(/^[\\/]+/, '')}`;
        onFileSelect(abs);
      }
      onClose();
    },
    [onTrackerSelect, onSessionSelect, onFileSelect, onClose, workspacePath],
  );

  useEffect(() => {
    if (!isOpen || !isActive) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setSelectedIndex((i) => (i < results.length - 1 ? i + 1 : i));
          break;
        case 'ArrowUp':
          e.preventDefault();
          setSelectedIndex((i) => (i > 0 ? i - 1 : i));
          break;
        case 'Enter':
          e.preventDefault();
          if (results[selectedIndex]) handleSelect(results[selectedIndex]);
          break;
        case 'Escape':
          e.preventDefault();
          onClose();
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, isActive, results, selectedIndex, handleSelect, onClose]);

  const hasQuery = !!visibleQuery.trim();

  return (
    <div className="search-pane flex-1 overflow-y-auto">
      {results.length === 0 ? (
        <div className="p-10 text-center text-nim-faint">
          {!hasQuery
            ? 'Search trackers, documents, and sessions by meaning'
            : isLoading
              ? 'Searching...'
              : 'No semantic matches'}
        </div>
      ) : (
        <ul
          ref={listRef}
          className={`list-none m-0 p-0 ${mouseHasMoved ? '' : 'pointer-events-none'}`}
        >
          {results.map((result, index) => (
            <li
              key={`${result.refType}:${result.refId}`}
              className={`unified-quick-open-item flex items-start gap-3 py-2.5 px-4 cursor-pointer border-l-[3px] transition-all duration-100 ${
                index === selectedIndex
                  ? 'selected bg-nim-selected border-l-nim-primary'
                  : 'border-transparent hover:bg-nim-hover'
              }`}
              onClick={() => handleSelect(result)}
              onMouseEnter={() => {
                if (mouseHasMoved) setSelectedIndex(index);
              }}
            >
              <div className="shrink-0 mt-0.5 text-nim-muted">
                <MaterialSymbol icon={refTypeIcon(result.refType)} size={16} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-nim flex items-center gap-2 overflow-hidden text-ellipsis whitespace-nowrap">
                  <span className="shrink-0 text-[10px] uppercase tracking-wide py-0.5 px-1.5 rounded bg-nim-secondary text-nim-faint">
                    {refTypeLabel(result)}
                  </span>
                  <span className="truncate">
                    {result.title || result.sourcePath || result.refId}
                  </span>
                </div>
                {result.snippet && (
                  <div className="text-xs text-nim-faint mt-0.5 truncate">{result.snippet}</div>
                )}
              </div>
              {result.signals?.dense && (
                <div
                  className="shrink-0 mt-0.5 text-nim-faint"
                  title="Semantic match"
                >
                  <MaterialSymbol icon="auto_awesome" size={13} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
});

// =============================================================================
// TrackersPane — list / search tracker items, filter by type
// =============================================================================

interface TrackersPaneProps {
  isOpen: boolean;
  isActive: boolean;
  query: string;
  /** Tracker type filter (e.g. "bug"). Null means show all types. */
  typeFilter: string | null;
  workspacePath: string;
  onTrackerSelect: (trackerId: string) => void;
  onClose: () => void;
}

const TrackersPane: React.FC<TrackersPaneProps> = memo(({
  isOpen,
  isActive,
  query,
  typeFilter,
  workspacePath: _workspacePath,
  onTrackerSelect,
  onClose,
}) => {
  const [items, setItems] = useState<TrackerItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [mouseHasMoved, setMouseHasMoved] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);
  const visibleQuery = isActive ? query : '';

  useEffect(() => {
    setSelectedIndex(0);
  }, [visibleQuery, typeFilter]);

  // Load all trackers when the dialog opens. The list-items IPC is fast
  // enough that we can do it eagerly; switching between types is in-memory.
  useEffect(() => {
    if (!isOpen) return;
    setIsLoading(true);
    window.electronAPI
      .invoke('document-service:tracker-items-list')
      .then((result: TrackerItem[] | null) => {
        setItems(Array.isArray(result) ? result : []);
      })
      .catch(() => setItems([]))
      .finally(() => setIsLoading(false));
  }, [isOpen]);

  // Hide archived items; apply type and text filters in-memory.
  const displayItems = useMemo(() => {
    let pool = items.filter((it) => !it.archived);
    if (typeFilter) {
      pool = pool.filter(
        (it) => it.type === typeFilter || (it.typeTags ?? []).includes(typeFilter),
      );
    }
    if (visibleQuery.trim()) {
      const q = visibleQuery.toLowerCase();
      pool = pool.filter((it) => {
        if (it.title.toLowerCase().includes(q)) return true;
        if (it.issueKey?.toLowerCase().includes(q)) return true;
        if (it.description?.toLowerCase().includes(q)) return true;
        if (it.id.toLowerCase().includes(q)) return true;
        return false;
      });
    }
    // Most recently updated first.
    pool.sort((a, b) => {
      const ta = a.updated ? Date.parse(a.updated) : 0;
      const tb = b.updated ? Date.parse(b.updated) : 0;
      return tb - ta;
    });
    return pool.slice(0, 200);
  }, [items, visibleQuery, typeFilter]);

  useEffect(() => {
    if (!isOpen) return;
    const onMove = () => setMouseHasMoved(true);
    window.addEventListener('mousemove', onMove);
    return () => window.removeEventListener('mousemove', onMove);
  }, [isOpen]);

  useEffect(() => {
    if (!listRef.current) return;
    const els = listRef.current.querySelectorAll('.unified-quick-open-item');
    const el = els[selectedIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selectedIndex]);

  const handleSelect = useCallback(
    (it: TrackerItem) => {
      onTrackerSelect(it.id);
      onClose();
    },
    [onTrackerSelect, onClose],
  );

  useEffect(() => {
    if (!isOpen || !isActive) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setSelectedIndex((i) => (i < displayItems.length - 1 ? i + 1 : i));
          break;
        case 'ArrowUp':
          e.preventDefault();
          setSelectedIndex((i) => (i > 0 ? i - 1 : i));
          break;
        case 'Enter':
          e.preventDefault();
          if (displayItems[selectedIndex]) handleSelect(displayItems[selectedIndex]);
          break;
        case 'Escape':
          e.preventDefault();
          onClose();
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, isActive, displayItems, selectedIndex, handleSelect, onClose]);

  return (
    <div className="trackers-pane flex-1 overflow-y-auto">
      {displayItems.length === 0 ? (
        <div className="p-10 text-center text-nim-faint">
          {isLoading
            ? 'Loading trackers...'
            : query || typeFilter
              ? 'No matching trackers'
              : 'No trackers yet'}
        </div>
      ) : (
        <ul
          ref={listRef}
          className={`list-none m-0 p-0 ${mouseHasMoved ? '' : 'pointer-events-none'}`}
        >
          {displayItems.map((it, index) => (
            <li
              key={it.id}
              className={`unified-quick-open-item flex items-start gap-3 py-2.5 px-4 cursor-pointer border-l-[3px] transition-all duration-100 ${
                index === selectedIndex
                  ? 'selected bg-nim-selected border-l-nim-primary'
                  : 'border-transparent hover:bg-nim-hover'
              }`}
              onClick={() => handleSelect(it)}
              onMouseEnter={() => {
                if (mouseHasMoved) setSelectedIndex(index);
              }}
            >
              <div className="shrink-0 mt-0.5 text-nim-muted">
                <MaterialSymbol icon={trackerTypeIcon(it.type)} size={16} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-nim flex items-center gap-2 overflow-hidden text-ellipsis whitespace-nowrap">
                  {it.issueKey && (
                    <span className="shrink-0 text-[10px] font-mono py-0.5 px-1.5 rounded bg-nim-secondary text-nim-faint">
                      {it.issueKey}
                    </span>
                  )}
                  <span className="truncate">{it.title}</span>
                </div>
                <div className="text-xs text-nim-faint mt-0.5 flex items-center gap-2">
                  <span
                    className="inline-flex items-center gap-1"
                    style={{ color: TRACKER_STATUS_COLOR[it.status] ?? 'var(--nim-text-faint)' }}
                  >
                    <span className="w-1.5 h-1.5 rounded-full bg-current" />
                    {it.status}
                  </span>
                  <span className="text-nim-faint">·</span>
                  <span className="capitalize">{it.type}</span>
                  {it.priority && (
                    <>
                      <span className="text-nim-faint">·</span>
                      <span>{it.priority}</span>
                    </>
                  )}
                  {it.updated && (
                    <>
                      <span className="text-nim-faint">·</span>
                      <span>{getRelativeTimeString(Date.parse(it.updated))}</span>
                    </>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
});

function trackerTypeIcon(type: string): string {
  switch (type) {
    case 'bug':
      return 'bug_report';
    case 'task':
      return 'task_alt';
    case 'plan':
      return 'flag';
    case 'idea':
      return 'lightbulb';
    case 'decision':
      return 'gavel';
    case 'feature':
      return 'auto_awesome';
    default:
      return 'label';
  }
}
