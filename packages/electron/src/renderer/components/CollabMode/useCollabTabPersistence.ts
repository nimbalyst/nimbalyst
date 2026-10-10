/**
 * Pages mode's open-tab list across restarts: restore on mount, persist on
 * every tab change, in tab order with pinned state.
 *
 * Doc tabs need the team scope. Without one (signed out, no team, or still
 * resolving) their entries are held and persisted after the open tabs, so a
 * session without a team never forgets the team tabs, and they open once the
 * team scope arrives. Item, type and personal page tabs need no scope.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CollabScope } from '@nimbalyst/collab-client/core';
import { isCollabUri, parseCollabUri } from '@nimbalyst/collab-protocol';
import type { TabData, useTabsActions } from '../../contexts/TabsContext';
import { getCollabConfig, openCollabDocumentViaIPC } from '../../utils/collabDocumentOpener';
import {
  isPersistedCollabPageEntry,
  loadOpenCollabTabs,
  persistOpenCollabDocs,
  type PersistedCollabEntry,
  type PersistedCollabTabEntry,
} from '../../utils/collabOpenDocsPersistence';
import type { SharedDocument, SharedFolder } from '../../store/atoms/collabDocuments';
import { openPageTab, toPersistedPageEntry } from './collabPageTabs';
import { getSharedDocumentDisplayPathWithFallback } from './collabTree';
import { pageDisplayName } from '@nimbalyst/collab-client/docs';
import { isSharedHomeTab } from './sharedHomeTab';

interface CollabTabPersistenceInput {
  workspacePath: string;
  teamScope: CollabScope | null;
  personalScope: CollabScope;
  tabs: TabData[];
  tabsActions: ReturnType<typeof useTabsActions>;
  sharedDocuments: SharedDocument[];
  sharedFolders: SharedFolder[];
}

/** Returns true once the saved tabs have been reopened. */
export function useCollabTabPersistence({
  workspacePath,
  teamScope,
  personalScope,
  tabs,
  tabsActions,
  sharedDocuments,
  sharedFolders,
}: CollabTabPersistenceInput): boolean {
  const [restored, setRestored] = useState(false);
  const heldDocEntriesRef = useRef<PersistedCollabEntry[]>([]);
  const teamScopeRef = useRef(teamScope);
  teamScopeRef.current = teamScope;
  // The open-tabs list lives in the workspace's state, which the team scope's
  // key already names; persistence reads only the key.
  const persistenceScope = useMemo<CollabScope>(
    () => teamScope ?? { ...personalScope, scopeKey: workspacePath },
    [teamScope, personalScope, workspacePath],
  );

  const docEntryForTab = useCallback((tab: TabData, scope: CollabScope): PersistedCollabEntry | null => {
    if (!isCollabUri(tab.filePath)) return null;
    try {
      const { documentId } = parseCollabUri(tab.filePath);
      const document = sharedDocuments.find((candidate) => candidate.documentId === documentId);
      const registeredPath = getCollabConfig(scope, tab.filePath)?.displayPath;
      const displayPath = document
        ? getSharedDocumentDisplayPathWithFallback(
            document,
            sharedFolders,
            registeredPath || tab.fileName,
          )
        : registeredPath || tab.fileName;
      return {
        documentId,
        documentType: document?.documentType ?? 'markdown',
        metadataVersion: document?.metadataVersion,
        fileExtension: document?.fileExtension,
        editorId: document?.editorId,
        displayPath,
        isPinned: tab.isPinned,
      };
    } catch {
      return null;
    }
  }, [sharedDocuments, sharedFolders]);

  /** Resolves false when the document could not be opened. */
  const openDocEntry = useCallback(async (scope: CollabScope, entry: PersistedCollabEntry): Promise<boolean> => {
    try {
      await openCollabDocumentViaIPC({
        scope,
        documentId: entry.documentId,
        // The tab reads like the tree row: bare name, no ".md" on a page.
        title: entry.displayPath ? pageDisplayName(entry.displayPath, entry.documentType) : undefined,
        displayPath: entry.displayPath,
        documentType: entry.documentType,
        metadataVersion: entry.metadataVersion,
        fileExtension: entry.fileExtension,
        editorId: entry.editorId,
        analyticsSource: 'restart_restore',
        isPinned: entry.isPinned,
        addTab: tabsActions.addTab,
      });
      return true;
    } catch (err) {
      console.warn('[CollabMode] Failed to restore collab document:', entry.documentId, err);
      return false;
    }
  }, [tabsActions]);

  // The team scope went away: hold its doc tabs, and the team-only home tab,
  // rather than leave them open on a scope that no longer resolves.
  const previousTeamScopeRef = useRef(teamScope);
  useEffect(() => {
    const previous = previousTeamScopeRef.current;
    previousTeamScopeRef.current = teamScope;
    if (!previous || teamScope) return;
    for (const tab of tabs) {
      const entry = docEntryForTab(tab, previous);
      if (entry) heldDocEntriesRef.current.push(entry);
      if (entry || isSharedHomeTab(tab.filePath)) tabsActions.removeTab(tab.id);
    }
  }, [teamScope, tabs, docEntryForTab, tabsActions]);

  // Persist open document, item page, type page and personal page entries,
  // including tab order and pinned state, whenever tabs change.
  // documentType is required at restore time so the right editor is mounted;
  // without it CollaborativeTabEditor falls back to markdown for everything
  // and renders an Excalidraw / mockup Y.Doc as blank.
  useEffect(() => {
    if (!restored) return; // Don't persist until we've finished restoring
    const entries: PersistedCollabTabEntry[] = tabs
      .map<PersistedCollabTabEntry | null>((t) =>
        toPersistedPageEntry(t) ?? (teamScope ? docEntryForTab(t, teamScope) : null))
      .filter((entry): entry is PersistedCollabTabEntry => entry !== null);
    // A held entry whose tab is already open (its reopen is still settling)
    // is written once, as the tab.
    const openDocumentIds = new Set(entries.flatMap((entry) => ('documentId' in entry ? [entry.documentId] : [])));
    const held = heldDocEntriesRef.current.filter((entry) => !openDocumentIds.has(entry.documentId));
    persistOpenCollabDocs(persistenceScope, [...entries, ...held]);
  }, [tabs, teamScope, persistenceScope, docEntryForTab, restored]);

  // Restore previously open collab documents and pages on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const savedEntries = await loadOpenCollabTabs(persistenceScope);
      // Open each saved document. We don't need to wait for sharedDocumentsAtom
      // because openCollabDocumentViaIPC resolves auth/keys via IPC directly.
      // Use the last-known logical path as a warm display fallback. Legacy
      // entries have no path and render a neutral placeholder until index sync.
      for (const entry of savedEntries) {
        if (cancelled) break;
        if (isPersistedCollabPageEntry(entry)) {
          openPageTab(tabsActions.addTab, entry);
          continue;
        }
        const scope = teamScopeRef.current;
        if (scope) await openDocEntry(scope, entry);
        else heldDocEntriesRef.current.push(entry);
      }
      if (!cancelled) setRestored(true);
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // TabsProvider is keyed by workspace; tabsActions is stable per mount.

  // The team scope arrived: open the doc tabs held while it was missing. An
  // entry leaves the held list only once its tab opened; one that fails stays
  // held and persisted, and is tried again the next time a team scope arrives
  // (once per arrival, not on every re-run of this effect).
  const reopenedForScopeRef = useRef<CollabScope | null>(null);
  useEffect(() => {
    if (!teamScope) {
      reopenedForScopeRef.current = null;
      return;
    }
    if (!restored || reopenedForScopeRef.current === teamScope) return;
    reopenedForScopeRef.current = teamScope;
    if (heldDocEntriesRef.current.length === 0) return;
    const held = [...heldDocEntriesRef.current];
    void (async () => {
      for (const entry of held) {
        if (!(await openDocEntry(teamScope, entry))) continue;
        heldDocEntriesRef.current = heldDocEntriesRef.current.filter((candidate) => candidate !== entry);
      }
    })();
  }, [restored, teamScope, openDocEntry]);

  return restored;
}
