/**
 * Local wiki pages open in Pages mode as ordinary file tabs. A rename or move
 * in the tree renames the file (and its folder), so an open tab follows its
 * page to the new path and takes the page's title, the way Files mode follows
 * a renamed file.
 */
import { useEffect, useRef } from 'react';
import { getSharedDocumentDisplayName, type SharedDocument } from '@nimbalyst/collab-client/docs';
import type { TabData } from '../../contexts/TabsContext';
import { getPersonalCollabHost } from '../../store/atoms/collabDocuments';
import { DocumentModelRegistry } from '../../services/document-model/DocumentModelRegistry';

interface TabUpdater {
  updateTab: (tabId: string, updates: Partial<TabData>) => void;
}

export function useLocalWikiFileTabs(
  workspacePath: string,
  documents: readonly SharedDocument[],
  tabs: readonly TabData[],
  tabsActions: TabUpdater,
): void {
  const previousPaths = useRef<ReadonlyMap<string, string>>(new Map());
  useEffect(() => {
    const source = getPersonalCollabHost(workspacePath).source();
    const paths = new Map(source.filePathsById());
    const before = previousPaths.current;
    previousPaths.current = paths;
    const titleById = new Map(documents.map((document) => [
      document.documentId,
      getSharedDocumentDisplayName(document.title, document.documentId),
    ]));
    const idByOldPath = new Map([...before].map(([id, path]) => [path, id]));
    for (const tab of tabs) {
      const id = idByOldPath.get(tab.filePath) ?? source.documentIdForFile(tab.filePath);
      if (!id) continue;
      const nextPath = paths.get(id);
      const title = titleById.get(id);
      const updates: Partial<TabData> = {};
      if (nextPath && nextPath !== tab.filePath) {
        // Re-key first so the open editor keeps its buffer (see useIPCHandlers onFileRenamed).
        DocumentModelRegistry.rename(tab.filePath, nextPath);
        updates.filePath = nextPath;
      }
      if (title && tab.fileName !== title) updates.fileName = title;
      if (Object.keys(updates).length > 0) tabsActions.updateTab(tab.id, updates);
    }
  }, [workspacePath, documents, tabs, tabsActions]);
}
