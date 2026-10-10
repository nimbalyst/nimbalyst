/**
 * Pages navigates like a wiki: a plain click opens the target in the current
 * tab, Cmd/Ctrl+click opens a new tab, and every tab keeps its own Back and
 * Forward (`contexts/tabHistory.ts`). This module decides where an open lands
 * (pure, tested without a window) and holds the hook the window's Back/Forward
 * commands reach while Pages is shown.
 */

import {
  PERSONAL_PAGE_TAB_PREFIX,
  TYPE_TAB_PREFIX,
  isPersonalPageTabPath,
  isTrackerTabPath,
  isTypeTabPath,
} from '../../contexts/TabsContext';
import { isCollabUri, parseCollabUri } from '@nimbalyst/collab-protocol';
import { pagesSectionTabFor } from './pagesSectionTabs';

/** How a user asked for an open: `newTab` when Cmd (Ctrl off macOS) was held. */
export interface PagesOpenOptions {
  newTab: boolean;
}

/** True for a tab Pages can navigate in place: a page, typed page, type page, or a section's Search or Types. */
export function isPagesTabPath(filePath: string): boolean {
  return isCollabUri(filePath)
    || isPersonalPageTabPath(filePath)
    || isTrackerTabPath(filePath)
    || isTypeTabPath(filePath)
    || pagesSectionTabFor(filePath) !== null;
}

export type PagesOpenPlan =
  | { action: 'replace'; tabId: string }
  | { action: 'new' };

/**
 * Where a click lands. A plain click replaces the active tab when it is a
 * Pages tab, even if another tab shows the same page. Cmd/Ctrl, no active
 * tab, or one Pages does not navigate (a feedback request) open a new tab,
 * which focuses a tab that already shows the page instead. A Local wiki page
 * is a markdown file tab, so `isLocalPage` says which file tabs are pages.
 */
export function planPagesOpen(
  _targetPath: string,
  options: PagesOpenOptions,
  tabs: { activeTabId: string | null; tabs: ReadonlyMap<string, { id: string; filePath: string }> },
  isLocalPage: (filePath: string) => boolean = () => false,
): PagesOpenPlan {
  if (options.newTab || !tabs.activeTabId) return { action: 'new' };
  const active = tabs.tabs.get(tabs.activeTabId);
  if (!active || !(isPagesTabPath(active.filePath) || isLocalPage(active.filePath))) return { action: 'new' };
  return { action: 'replace', tabId: active.id };
}

// ── Whether a history entry can still be shown ──

/** `unknown` while the list that would say has not loaded. */
export type PageAvailability = 'live' | 'gone' | 'unknown';

/**
 * A page in a section's document list: gone when trashed, or absent from a
 * list that has `loaded` (empty or not). Before then an absent page is unknown.
 */
export function documentAvailability(
  documents: ReadonlyArray<{ documentId: string; trashedAt?: number | null }>,
  documentId: string,
  loaded: boolean,
): PageAvailability {
  const document = documents.find((candidate) => candidate.documentId === documentId);
  if (document) return document.trashedAt == null ? 'live' : 'gone';
  return loaded ? 'gone' : 'unknown';
}

export interface PagesEntryLookup {
  teamPage: (documentId: string) => PageAvailability;
  personalPage: (documentId: string) => PageAvailability;
  typedPage: (itemId: string) => PageAvailability;
  type: (typeId: string) => PageAvailability;
}

/**
 * Back and Forward pass over a page that is gone (trashed, purged, deleted, an
 * archived typed page, a removed type): mounting it would open an empty
 * editable document in its place. Anything this cannot judge is shown.
 */
export function isPagesEntryAvailable(filePath: string, lookup: PagesEntryLookup): boolean {
  let availability: PageAvailability = 'unknown';
  if (isCollabUri(filePath)) {
    try {
      availability = lookup.teamPage(parseCollabUri(filePath).documentId);
    } catch {
      availability = 'unknown';
    }
  } else if (isPersonalPageTabPath(filePath)) {
    availability = lookup.personalPage(filePath.slice(PERSONAL_PAGE_TAB_PREFIX.length));
  } else if (isTrackerTabPath(filePath)) {
    availability = lookup.typedPage(filePath.slice('tracker://'.length));
  } else if (isTypeTabPath(filePath)) {
    availability = lookup.type(filePath.slice(TYPE_TAB_PREFIX.length));
  }
  return availability !== 'gone';
}

// ── The window's Back/Forward commands (Cmd+[ / Cmd+], mouse side buttons) ──

type PagesHistoryNavigator = (direction: -1 | 1) => void;

let activeNavigator: PagesHistoryNavigator | null = null;

/** Pages registers while it is the shown mode; the returned function unregisters. */
export function registerPagesHistoryNavigator(navigator: PagesHistoryNavigator): () => void {
  activeNavigator = navigator;
  return () => {
    if (activeNavigator === navigator) activeNavigator = null;
  };
}

/** Steps the active Pages tab while Pages is shown; false leaves the command to the window's own history. */
export function navigatePagesHistory(direction: -1 | 1): boolean {
  if (!activeNavigator) return false;
  activeNavigator(direction);
  return true;
}
