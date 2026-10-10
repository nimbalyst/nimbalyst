/**
 * A Pages section's Search and Types open as tabs: `virtual://pages-search/<lane>`
 * and `virtual://pages-types/<lane>`, one of each per section. The old Shared
 * Home tab (`virtual://shared-home`) was the team's document list, which Search
 * replaced, so a leftover one opens as Team Search. This module also says
 * which of a section's fixed rows (Home, Search, Types) the active tab is.
 */

import type { PagesSectionEntry } from '@nimbalyst/collab-client/docs-ui';
import { SHARED_HOME_TAB_URI } from '@nimbalyst/collab-client/docs';

/** A section's Home page id starts with this (collab-client `docs/homePage.ts`). */
const HOME_PAGE_ID_PREFIX = 'home:';

export function isHomePageId(documentId: string): boolean {
  return documentId.startsWith(HOME_PAGE_ID_PREFIX);
}

export type PagesSectionLane = 'team' | 'personal';
export type PagesSectionView = 'search' | 'types';

export const PAGES_SECTION_TAB_PREFIX: Record<PagesSectionView, string> = {
  search: 'virtual://pages-search/',
  types: 'virtual://pages-types/',
};

export const PAGES_SECTION_TAB_TITLE: Record<PagesSectionView, string> = {
  search: 'Search',
  types: 'Types',
};

export function pagesSectionTabPath(view: PagesSectionView, lane: PagesSectionLane): string {
  return `${PAGES_SECTION_TAB_PREFIX[view]}${lane}`;
}

/** The section view a tab shows, or null for any other tab. */
export function pagesSectionTabFor(filePath: string | null | undefined): { view: PagesSectionView; lane: PagesSectionLane } | null {
  if (!filePath) return null;
  if (filePath === SHARED_HOME_TAB_URI) return { view: 'search', lane: 'team' };
  for (const view of ['search', 'types'] as const) {
    if (!filePath.startsWith(PAGES_SECTION_TAB_PREFIX[view])) continue;
    const lane = filePath.slice(PAGES_SECTION_TAB_PREFIX[view].length);
    return lane === 'team' || lane === 'personal' ? { view, lane } : null;
  }
  return null;
}

/** Which of a section's fixed rows the active tab is: its Search, its Types, or its open Home page. */
export function activeSectionEntry(
  lane: PagesSectionLane,
  activeTabPath: string | null | undefined,
  activeDocumentId: string | null | undefined,
): PagesSectionEntry | null {
  const view = pagesSectionTabFor(activeTabPath);
  if (view) return view.lane === lane ? view.view : null;
  return activeDocumentId && isHomePageId(activeDocumentId) ? 'home' : null;
}
