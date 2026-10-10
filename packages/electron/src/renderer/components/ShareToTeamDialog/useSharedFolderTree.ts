/**
 * The shared-folder tree machinery both folder pickers need.
 *
 * Two surfaces choose a team-files folder now: the share-to-team dialog (where
 * does this file go) and the feedback destination picker (where does this
 * request's set of subjects go). They render the same rows over the same index
 * and need the same three things, so those live here rather than being typed
 * twice:
 *
 * - **A live refresh on every open.** The cached folder atom can be stale by an
 *   arbitrary amount, and a picker that paints a folder the team deleted sends
 *   a document somewhere the author did not choose. Callers must not paint the
 *   tree while `isRefreshing` is true.
 * - **Path lookups in both directions.** A folder id is what gets stored; a
 *   path is what a human reads. Callers need to go both ways -- id to label for
 *   display, path to id for reconciling a legacy persisted path.
 * - **Expansion state, including "reveal this folder".** Seeding a selection
 *   deep in the tree has to open its ancestors or the selection is invisible.
 *
 * Deliberately NOT here: which folder starts selected, and what creating a
 * folder means. Those are policy and they differ per surface -- the share
 * dialog seeds from the last-used folder and creates eagerly; the feedback
 * picker seeds from the request's destination and defers creation until the
 * send actually publishes. Putting either here would force one surface to
 * inherit the other's behaviour.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { atom, useAtomValue } from 'jotai';
import {
  activeCollabScopeAtom,
  getPersonalCollabDocsSession,
  refreshSharedFolders,
  sharedFoldersAtom,
  type SharedFolder,
} from '../../store/atoms/collabDocuments';
import { activeWorkspacePathAtom } from '../../store/atoms/openProjects';
import { buildShareFolderTree, type ShareFolderNode } from './shareFolderTree';

export interface SharedFolderTreeState {
  folders: SharedFolder[];
  tree: ShareFolderNode[];
  /** Every folder id in the tree, for validating a persisted selection. */
  ids: Set<string>;
  pathById: Map<string, string>;
  idByPath: Map<string, string>;
  isRefreshing: boolean;
  /** The refresh could not reach TeamRoom; the tree must not be trusted. */
  refreshFailed: boolean;
  expandedFolders: Set<string>;
  toggleFolder(folderId: string): void;
  /** Open every ancestor so a selection deep in the tree is actually visible. */
  revealFolder(folderId: string | null): void;
  expandFolder(folderId: string): void;
}

/** Which Pages section the tree lists: the team's (from TeamRoom) or this project's Personal pages. */
export type SharedFolderSection = 'team' | 'personal';

const NO_FOLDERS = atom<SharedFolder[]>([]);

export function useSharedFolderTree(isOpen: boolean, section: SharedFolderSection = 'team'): SharedFolderTreeState {
  const collabScope = useAtomValue(activeCollabScopeAtom);
  const workspacePath = useAtomValue(activeWorkspacePathAtom);
  const teamFolders = useAtomValue(sharedFoldersAtom);
  // Personal pages are local, so there is nothing to refresh and nothing that can be stale.
  const personalFolders = useAtomValue(
    section === 'personal' && workspacePath ? getPersonalCollabDocsSession(workspacePath).atoms.sharedFolders : NO_FOLDERS,
  );
  const folders = section === 'personal' ? personalFolders : teamFolders;

  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!isOpen) return;
    if (section === 'personal') {
      setRefreshFailed(!workspacePath);
      setIsRefreshing(false);
      return;
    }
    let cancelled = false;
    setIsRefreshing(true);
    setRefreshFailed(false);
    // A scope belonging to a different workspace is not a stale tree, it is the
    // wrong team's tree. Refuse rather than paint it.
    if (!collabScope || collabScope.scopeKey !== workspacePath) {
      setRefreshFailed(true);
      setIsRefreshing(false);
      return;
    }
    void refreshSharedFolders(collabScope)
      .then((refreshed) => {
        if (!cancelled && !refreshed) setRefreshFailed(true);
      })
      .catch(() => {
        if (!cancelled) setRefreshFailed(true);
      })
      .finally(() => {
        if (!cancelled) setIsRefreshing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [collabScope, isOpen, section, workspacePath]);

  const tree = useMemo(() => buildShareFolderTree(folders), [folders]);

  const lookups = useMemo(() => {
    const ids = new Set<string>();
    const pathById = new Map<string, string>();
    const idByPath = new Map<string, string>();
    const walk = (nodes: ShareFolderNode[]) => {
      for (const node of nodes) {
        ids.add(node.folderId);
        pathById.set(node.folderId, node.path);
        idByPath.set(node.path, node.folderId);
        walk(node.children);
      }
    };
    walk(tree);
    return { ids, pathById, idByPath };
  }, [tree]);

  const toggleFolder = useCallback((folderId: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });
  }, []);

  const expandFolder = useCallback((folderId: string) => {
    setExpandedFolders((prev) => {
      if (prev.has(folderId)) return prev;
      const next = new Set(prev);
      next.add(folderId);
      return next;
    });
  }, []);

  const revealFolder = useCallback(
    (folderId: string | null) => {
      const expanded = new Set<string>();
      let cursor = folderId ? folders.find((folder) => folder.folderId === folderId) : undefined;
      // A malformed parent chain must not spin forever.
      const seen = new Set<string>();
      while (cursor && !seen.has(cursor.folderId)) {
        seen.add(cursor.folderId);
        expanded.add(cursor.folderId);
        cursor = cursor.parentFolderId
          ? folders.find((folder) => folder.folderId === cursor!.parentFolderId)
          : undefined;
      }
      setExpandedFolders(expanded);
    },
    [folders],
  );

  return {
    folders,
    tree,
    ...lookups,
    isRefreshing,
    refreshFailed,
    expandedFolders,
    toggleFolder,
    revealFolder,
    expandFolder,
  };
}
