/**
 * Tracker item pages (`tracker://<itemId>`), type pages (`type://<typeId>`),
 * database personal pages (`personal://<documentId>`) and Local wiki pages
 * (their markdown files, by absolute path)
 * open as tabs inside Pages mode's own tab strip, beside shared documents. This
 * module maps between those tabs, the artifact refs that open them, and the
 * entries that persist them across a restart.
 */

import { globalRegistry } from '@nimbalyst/tracker-schema';
import { localWikiFilePathForItem } from '../../services/localWikiTrackerRecords';
import {
  PERSONAL_PAGE_TAB_PREFIX,
  TYPE_TAB_PREFIX,
  isPersonalPageTabPath,
  isTrackerTabPath,
  isTypeTabPath,
  type TabData,
} from '../../contexts/TabsContext';
import type {
  PersistedCollabPageEntry,
  PersistedCollabPageKind,
} from '../../utils/collabOpenDocsPersistence';
import { PAGES_SECTION_TAB_PREFIX, PAGES_SECTION_TAB_TITLE, pagesSectionTabFor } from './pagesSectionTabs';

const TRACKER_TAB_PREFIX = 'tracker://';

const PAGE_TAB_PREFIX: Record<PersistedCollabPageKind, string> = {
  tracker: TRACKER_TAB_PREFIX,
  type: TYPE_TAB_PREFIX,
  personal: PERSONAL_PAGE_TAB_PREFIX,
  file: '',
  ...PAGES_SECTION_TAB_PREFIX,
};

/** A plain file tab: in Pages mode only a Local wiki page opens as one. */
function isAbsoluteFilePath(filePath: string): boolean {
  return filePath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(filePath);
}

function pageKindOf(filePath: string): PersistedCollabPageKind | null {
  if (isTypeTabPath(filePath)) return 'type';
  if (isTrackerTabPath(filePath)) return 'tracker';
  if (isPersonalPageTabPath(filePath)) return 'personal';
  // A leftover Shared Home tab persists as the Team Search it now shows.
  return pagesSectionTabFor(filePath)?.view ?? (isAbsoluteFilePath(filePath) ? 'file' : null);
}

type AddTab = (
  filePath: string,
  content?: string,
  switchToTab?: boolean,
  displayName?: string,
  initialState?: Pick<TabData, 'isPinned'>,
) => string | null;

export function pageTabPath(kind: PersistedCollabPageEntry['kind'], artifactId: string): string {
  return `${PAGE_TAB_PREFIX[kind]}${artifactId}`;
}

/** The type's plural name, or its id until the schema registry knows it. */
export function typePageTitle(typeId: string): string {
  return globalRegistry.get(typeId)?.displayNamePlural || typeId;
}

export function openPageTab(
  addTab: AddTab,
  page: Pick<PersistedCollabPageEntry, 'kind' | 'artifactId'> & Partial<PersistedCollabPageEntry>,
): string | null {
  // A typed page of the Local wiki is a markdown file: it opens as that file.
  const filePath = page.kind === 'tracker' ? localWikiFilePathForItem(page.artifactId) : null;
  if (filePath) return addTab(filePath, '', true, page.title, page.isPinned === undefined ? undefined : { isPinned: page.isPinned });
  const title = page.title ?? (page.kind === 'type'
    ? typePageTitle(page.artifactId)
    : page.kind === 'search' || page.kind === 'types' ? PAGES_SECTION_TAB_TITLE[page.kind] : undefined);
  return addTab(
    pageTabPath(page.kind, page.artifactId),
    '',
    true,
    title,
    page.isPinned === undefined ? undefined : { isPinned: page.isPinned },
  );
}

/**
 * The tree row an open tab stands for, so the sidebar can highlight and reveal
 * it. Item and type tabs name no lane: each section marks the row only if its
 * tree holds it.
 */
export function activePageRow(filePath: string | null | undefined): { itemId: string | null; typeId: string | null } {
  const kind = filePath ? pageKindOf(filePath) : null;
  const artifactId = filePath && kind ? filePath.slice(pageTabPath(kind, '').length) || null : null;
  return {
    itemId: kind === 'tracker' ? artifactId : null,
    typeId: kind === 'type' ? artifactId : null,
  };
}

/** The persisted form of an item, type or personal page tab; null for any other tab. */
export function toPersistedPageEntry(tab: TabData): PersistedCollabPageEntry | null {
  const kind = pageKindOf(tab.filePath);
  if (!kind) return null;
  const section = pagesSectionTabFor(tab.filePath);
  const artifactId = section ? section.lane : tab.filePath.slice(pageTabPath(kind, '').length);
  if (!artifactId) return null;
  // An item tab's fileName is its id until a title was passed in; the tab bar
  // resolves the live title, so an id is not worth keeping as one.
  // A section view's title is fixed (and a Shared Home tab's old one is wrong).
  const title = !section && tab.fileName && tab.fileName !== artifactId ? tab.fileName : undefined;
  return {
    kind,
    artifactId,
    ...(title ? { title } : {}),
    isPinned: tab.isPinned,
  };
}
