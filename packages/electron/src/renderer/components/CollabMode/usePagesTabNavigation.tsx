/**
 * Pages' tab navigation in the window: opens a page where `planPagesOpen`
 * says (the current tab, a new tab, or the tab already showing it), steps the
 * active tab Back and Forward, and the small Back/Forward buttons at the start
 * of the tab strip. Cmd+[ and Cmd+] reach the active tab while Pages is shown.
 */

import React, { useCallback, useEffect, useMemo } from 'react';
import { globalRegistry } from '@nimbalyst/tracker-schema';
import { store } from '@nimbalyst/runtime/store';
import { trackerItemsMapAtom } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerDataAtoms';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import { useTabs, useTabsActions, type TabData } from '../../contexts/TabsContext';
import type { TabHistoryEntry } from '../../contexts/tabHistory';
import { getPersonalCollabDocsSession, getPersonalCollabHost, linkableSharedDocumentsAtom, teamSyncStatusAtom } from '../../store/atoms/collabDocuments';
import {
  documentAvailability,
  isPagesEntryAvailable,
  planPagesOpen,
  registerPagesHistoryNavigator,
  type PagesEntryLookup,
  type PagesOpenOptions,
} from './pagesTabNavigation';

/** `TabsContext.addTab`'s shape, which the page openers take. */
export type PagesAddTab = (
  filePath: string,
  content?: string,
  switchToTab?: boolean,
  displayName?: string,
  initialState?: Pick<TabData, 'isPinned'>,
) => string | null;

export interface PagesTabNavigation {
  /**
   * An `addTab` that lands where a click asked. Without options (restore,
   * agents, deep links) it is plain `addTab`: focus the tab or add one.
   */
  addTabFor: (options: PagesOpenOptions | undefined) => PagesAddTab;
  /** Back (-1) or Forward (1) in the active tab. */
  step: (direction: -1 | 1) => void;
}

type PersonalPageRow = { documentId: string; trashedAt?: number | null };

/**
 * The database Personal pages not exported to the Local wiki yet (the only
 * pages that open as `personal://` tabs), trashed rows included; null when it
 * cannot be read. Read per step rather than from the session, whose list says
 * nothing until its first snapshot lands, so a purged last page reads as gone
 * and not as "not loaded yet".
 */
async function readPersonalPages(workspacePath: string): Promise<PersonalPageRow[] | null> {
  try {
    const snapshot = await window.electronAPI.invoke('local-wiki:legacy-snapshot', workspacePath) as { items?: PersonalPageRow[] } | null;
    return snapshot?.items ?? [];
  } catch (error) {
    console.warn('[usePagesTabNavigation] Could not read Personal pages; Back and Forward will not skip any:', error);
    return null;
  }
}

/** Whether pages are still there, read from the window's lists when a step is taken. */
function windowPagesLookup(workspacePath: string, personalPages: PersonalPageRow[] | null): PagesEntryLookup {
  return {
    teamPage: (documentId) => documentAvailability(store.get(linkableSharedDocumentsAtom), documentId, store.get(teamSyncStatusAtom) === 'connected'),
    personalPage: (documentId) => (personalPages
      ? documentAvailability(personalPages, documentId, true)
      : documentAvailability(store.get(getPersonalCollabDocsSession(workspacePath).atoms.allSharedDocuments), documentId, false)),
    typedPage: (itemId) => {
      const items = store.get(trackerItemsMapAtom);
      if (items.size === 0) return 'unknown';
      const item = items.get(itemId);
      return item && !item.archived ? 'live' : 'gone';
    },
    type: (typeId) => (globalRegistry.get(typeId) ? 'live' : globalRegistry.getAll().length > 0 ? 'gone' : 'unknown'),
  };
}

export function usePagesTabNavigation(isActive: boolean, workspacePath: string): PagesTabNavigation {
  const tabsActions = useTabsActions();
  const { addTab, getSnapshot, navigateTab, stepTab } = tabsActions;

  const addTabFor = useCallback((options: PagesOpenOptions | undefined): PagesAddTab => (
    (filePath, content = '', switchToTab = true, displayName, initialState) => {
      if (!options) return addTab(filePath, content, switchToTab, displayName, initialState);
      const isLocalPage = (path: string) => getPersonalCollabHost(workspacePath).source().documentIdForFile(path) !== null;
      const plan = planPagesOpen(filePath, options, getSnapshot(), isLocalPage);
      // A new tab focuses one that already shows the page.
      if (plan.action === 'new') return addTab(filePath, '', true, displayName, initialState);
      navigateTab(plan.tabId, filePath, displayName);
      return plan.tabId;
    }
  ), [addTab, getSnapshot, navigateTab, workspacePath]);

  // Back and Forward pass over pages that were trashed or deleted since.
  const step = useCallback((direction: -1 | 1) => {
    const activeTabId = getSnapshot().activeTabId;
    if (!activeTabId) return;
    void readPersonalPages(workspacePath).then((personalPages) => {
      // The tab moved on (closed, or another tab chosen) while the list was read.
      if (getSnapshot().activeTabId !== activeTabId) return;
      const lookup = windowPagesLookup(workspacePath, personalPages);
      stepTab(activeTabId, direction, (entry: TabHistoryEntry) => isPagesEntryAvailable(entry.filePath, lookup));
    });
  }, [getSnapshot, stepTab, workspacePath]);

  useEffect(() => (isActive ? registerPagesHistoryNavigator(step) : undefined), [isActive, step]);

  return useMemo(() => ({ addTabFor, step }), [addTabFor, step]);
}

const MOD = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform) ? 'Cmd' : 'Ctrl';

const NAV_BUTTON = 'pages-tab-history-button flex h-6 w-6 items-center justify-center rounded border-none bg-transparent p-0 text-nim-muted enabled:cursor-pointer enabled:hover:bg-nim-hover enabled:hover:text-nim disabled:opacity-35';

/** Back and Forward for the active tab, at the start of the tab strip. */
export function PagesTabHistoryButtons({ onStep }: { onStep: (direction: -1 | 1) => void }) {
  const { activeTab } = useTabs();
  const back = activeTab?.history?.back.at(-1);
  const forward = activeTab?.history?.forward[0];
  return (
    <div className="pages-tab-history flex shrink-0 items-center gap-0.5 pl-1.5" data-testid="pages-tab-history">
      <button
        type="button"
        className={NAV_BUTTON}
        disabled={!back}
        title={`${back ? `Back to ${back.fileName}` : 'Back'} (${MOD}+[)`}
        aria-label="Back"
        data-testid="pages-tab-back"
        onClick={() => onStep(-1)}
      >
        <MaterialSymbol icon="arrow_back" size={16} />
      </button>
      <button
        type="button"
        className={NAV_BUTTON}
        disabled={!forward}
        title={`${forward ? `Forward to ${forward.fileName}` : 'Forward'} (${MOD}+])`}
        aria-label="Forward"
        data-testid="pages-tab-forward"
        onClick={() => onStep(1)}
      >
        <MaterialSymbol icon="arrow_forward" size={16} />
      </button>
    </div>
  );
}
