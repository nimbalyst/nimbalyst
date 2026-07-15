/**
 * Shared Collaborative Documents Atoms
 *
 * Manages the list of documents shared to team for the current workspace.
 * Backed by the TeamRoom Durable Object for real-time team-wide sync.
 * Falls back gracefully if team/auth is not available.
 *
 * Multi-project keep-warm: provider instances and per-workspace state are
 * stored in maps keyed by workspace path. The active project's data is
 * exposed via derived atoms so existing UI consumers do not need to change.
 */

import { atom } from 'jotai';
import { atomFamily } from '../debug/atomFamilyRegistry';
import { store } from '@nimbalyst/runtime/store';
import type { TeamSyncProvider as TeamSyncProviderType, FolderNode } from '@nimbalyst/runtime/sync';
import { errorNotificationService } from '../../services/ErrorNotificationService';
import { collabKeyRotationEpochAtom } from './collabEditor';
import { activeWorkspacePathAtom } from './openProjects';
import { pendingDocRegistrations } from './pendingDocRegistrations';
import {
  normalizeCollabPath,
  getCollabParentPath,
  getCollabNodeName,
  computeLegacyFolderRenameUpdates,
} from '../../components/CollabMode/collabTree';

// ============================================================
// Types
// ============================================================

export interface SharedDocument {
  documentId: string;
  title: string;
  documentType: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  /**
   * User id of whoever most recently changed this doc (title OR content).
   * Drives the sidebar unread dot's self-edit suppression. Null for legacy rows.
   */
  lastWriterUserId?: string | null;
  /**
   * First-class folders: the folder this doc lives in. Null/undefined = root.
   * The tree is built from this + folder nodes, not from splitting the title.
   */
  parentFolderId?: string | null;
  /**
   * True when the doc index entry's encrypted title could not be decrypted.
   * Rendered as a locked placeholder in the sidebar; not openable.
   */
  decryptFailed?: boolean;
}

/** A first-class shared folder node projected for the renderer. */
export interface SharedFolder {
  folderId: string;
  /** Null/undefined = root level. */
  parentFolderId?: string | null;
  name: string;
  sortOrder: number;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  /** True when the folder name could not be decrypted (render as locked). */
  decryptFailed?: boolean;
}

type TeamSyncStatus = 'disconnected' | 'connecting' | 'syncing' | 'connected' | 'error';

/** Map a runtime FolderNode projection to the renderer SharedFolder shape. */
function mapFolderNode(f: FolderNode): SharedFolder {
  return {
    folderId: f.folderId,
    parentFolderId: f.parentFolderId ?? null,
    name: f.name,
    sortOrder: f.sortOrder,
    createdBy: f.createdBy,
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
    decryptFailed: f.decryptFailed,
  };
}

/**
 * NIM-1638: reconcile a full-sync ("loaded") snapshot against the rows we
 * already have WITHOUT dropping anything the snapshot happens to omit.
 *
 * A `docIndexSync` / `folderIndexSync` response is fired on every (re)connect
 * and was previously used to wholesale-REPLACE the index. When such a response
 * arrives empty or partial (transient server state, a project-partition race,
 * a decrypt-to-empty pass), the wholesale replace blanked real rows out of the
 * sidebar tree — shared docs like "latest meeting" would simply vanish.
 *
 * Instead we merge by id: the incoming snapshot WINS for any row it contains
 * (fresh titles, moved parents), and any locally-known row the snapshot omits
 * is RESTORED rather than left missing. Genuine removals still flow through the
 * explicit remove callbacks (`onDocumentRemoved` / `onFoldersRemoved`), which
 * are the only paths that shrink the set. Incoming order is preserved, with any
 * surviving local-only rows appended.
 */
function reconcileById<T>(
  existing: T[],
  incoming: T[],
  getId: (row: T) => string,
  merge: (existingRow: T, incomingRow: T) => T = (_existingRow, incomingRow) => incomingRow,
): T[] {
  const existingById = new Map(existing.map(row => [getId(row), row]));
  const incomingIds = new Set(incoming.map(getId));
  // Incoming wins, but merge against the row we already have so a blank/locked
  // field never clobbers a known-good one (NIM-1636).
  const reconciledIncoming = incoming.map(row => {
    const prev = existingById.get(getId(row));
    return prev ? merge(prev, row) : row;
  });
  const survivors = existing.filter(row => !incomingIds.has(getId(row)));
  return [...reconciledIncoming, ...survivors];
}

/** True for a displayable (non-blank, decrypted) title/name. */
function hasVisibleName(name: string | null | undefined): boolean {
  return typeof name === 'string' && name.trim().length > 0;
}

/**
 * NIM-1636: merge a fresh document row over the one we already have so a
 * transient blank name never wins. A raw teamSync pass (before keys arrive) and
 * a broadcast during key transition both surface `title: ''` + `decryptFailed`
 * for a doc we had already decrypted — the row stays but its name goes blank.
 * Incoming wins for every field EXCEPT: when its title is blank/locked, keep the
 * previously-decrypted title (and clear the transient `decryptFailed`). A
 * genuine rename (non-blank incoming) always wins, so the name fills in as soon
 * as a real one arrives.
 */
export function mergeSharedDocument(existing: SharedDocument, incoming: SharedDocument): SharedDocument {
  if (hasVisibleName(incoming.title)) return incoming;
  if (hasVisibleName(existing.title)) {
    return { ...incoming, title: existing.title, decryptFailed: false };
  }
  return incoming;
}

/** NIM-1636: folder counterpart to {@link mergeSharedDocument} (preserves `name`). */
export function mergeSharedFolder(existing: SharedFolder, incoming: SharedFolder): SharedFolder {
  if (hasVisibleName(incoming.name)) return incoming;
  if (hasVisibleName(existing.name)) {
    return { ...incoming, name: existing.name, decryptFailed: false };
  }
  return incoming;
}

/** Reconcile a full-sync document snapshot without dropping known rows or names (NIM-1638/NIM-1636). */
export function reconcileSharedDocuments(
  existing: SharedDocument[],
  incoming: SharedDocument[],
): SharedDocument[] {
  return reconcileById(existing, incoming, d => d.documentId, mergeSharedDocument);
}

/** Reconcile a full-sync folder snapshot without dropping known rows or names (NIM-1638/NIM-1636). */
export function reconcileSharedFolders(
  existing: SharedFolder[],
  incoming: SharedFolder[],
): SharedFolder[] {
  return reconcileById(existing, incoming, f => f.folderId, mergeSharedFolder);
}

// ============================================================
// Per-workspace atom families
// ============================================================

const sharedDocumentsAtomFamily = atomFamily((_workspacePath: string) =>
  atom<SharedDocument[]>([])
);

const sharedFoldersAtomFamily = atomFamily((_workspacePath: string) =>
  atom<SharedFolder[]>([])
);

const teamSyncStatusAtomFamily = atomFamily((_workspacePath: string) =>
  atom<TeamSyncStatus>('disconnected')
);

const workspaceHasTeamAtomFamily = atomFamily((_workspacePath: string) =>
  atom<boolean>(false)
);

const teamOrgIdAtomFamily = atomFamily((_workspacePath: string) =>
  atom<string | null>(null)
);

/**
 * The current user's TEAM member id for the active workspace's org. Used by the
 * doc unread indicator to suppress the user's own edits (compared against a
 * doc's `lastWriterUserId`). Set from the resolved collab config.
 */
const teamUserIdAtomFamily = atomFamily((_workspacePath: string) =>
  atom<string | null>(null)
);

/** The current user's team member id for the active workspace's org. */
export const activeTeamUserIdAtom = atom<string | null>((get) => {
  const path = get(activeWorkspacePathAtom);
  if (!path) return null;
  return get(teamUserIdAtomFamily(path));
});

// ============================================================
// Public atoms — derived from the active workspace
// ============================================================

/**
 * List of shared collaborative documents for the active workspace.
 * Populated from TeamRoom on connect, updated via broadcasts.
 */
export const sharedDocumentsAtom = atom<SharedDocument[], [SharedDocument[] | ((current: SharedDocument[]) => SharedDocument[])], void>(
  (get) => {
    const path = get(activeWorkspacePathAtom);
    if (!path) return [];
    return get(sharedDocumentsAtomFamily(path));
  },
  (get, set, valueOrUpdater) => {
    const path = get(activeWorkspacePathAtom);
    if (!path) return;
    const target = sharedDocumentsAtomFamily(path);
    if (typeof valueOrUpdater === 'function') {
      set(target, valueOrUpdater(get(target)));
    } else {
      set(target, valueOrUpdater);
    }
  }
);

/**
 * First-class shared folders for the active workspace. Populated from TeamRoom
 * on connect, updated via folder broadcasts. The collab tree is built from
 * these nodes plus each document's `parentFolderId`.
 */
export const sharedFoldersAtom = atom<SharedFolder[], [SharedFolder[] | ((current: SharedFolder[]) => SharedFolder[])], void>(
  (get) => {
    const path = get(activeWorkspacePathAtom);
    if (!path) return [];
    return get(sharedFoldersAtomFamily(path));
  },
  (get, set, valueOrUpdater) => {
    const path = get(activeWorkspacePathAtom);
    if (!path) return;
    const target = sharedFoldersAtomFamily(path);
    if (typeof valueOrUpdater === 'function') {
      set(target, valueOrUpdater(get(target)));
    } else {
      set(target, valueOrUpdater);
    }
  }
);

/**
 * Connection status for the active workspace's team sync provider.
 */
export const teamSyncStatusAtom = atom<TeamSyncStatus, [TeamSyncStatus], void>(
  (get) => {
    const path = get(activeWorkspacePathAtom);
    if (!path) return 'disconnected';
    return get(teamSyncStatusAtomFamily(path));
  },
  (get, set, value) => {
    const path = get(activeWorkspacePathAtom);
    if (!path) return;
    set(teamSyncStatusAtomFamily(path), value);
  }
);

/**
 * Whether the active workspace has an active team configured.
 * Set to true when initSharedDocuments successfully resolves team config,
 * false when no team is found. Used to conditionally show team-only UI
 * (e.g., the collab mode nav button).
 */
export const workspaceHasTeamAtom = atom<boolean, [boolean], void>(
  (get) => {
    const path = get(activeWorkspacePathAtom);
    if (!path) return false;
    return get(workspaceHasTeamAtomFamily(path));
  },
  (get, set, value) => {
    const path = get(activeWorkspacePathAtom);
    if (!path) return;
    set(workspaceHasTeamAtomFamily(path), value);
  }
);

/**
 * The team org ID currently in use for the active workspace, if it has a team.
 * Populated alongside team sync initialization. Used to build shareable deep
 * links to shared documents.
 */
export const activeTeamOrgIdAtom = atom<string | null>((get) => {
  const path = get(activeWorkspacePathAtom);
  if (!path) return null;
  return get(teamOrgIdAtomFamily(path));
});

/**
 * Build a deep link to a shared document. The recipient's Nimbalyst app uses
 * the orgId to find the matching team workspace and verify access.
 */
export function buildSharedDocumentDeepLink(documentId: string, orgId: string): string {
  return `nimbalyst://doc/${encodeURIComponent(documentId)}?orgId=${encodeURIComponent(orgId)}`;
}

/**
 * Build a deep link to a shared folder. Same routing semantics as shared
 * documents: the recipient's app uses the orgId to find the matching team
 * workspace, switches to Collab mode, and focuses the folder. Folders carry no
 * key material in the URL — membership-gated, exactly like doc links.
 */
export function buildSharedFolderDeepLink(folderId: string, orgId: string): string {
  return `nimbalyst://folder/${encodeURIComponent(folderId)}?orgId=${encodeURIComponent(orgId)}`;
}

/**
 * Build a deep link to a tracker item. Same routing semantics as shared
 * documents: the recipient's app uses the orgId to find the matching team
 * workspace and opens the tracker in tracker mode.
 */
export function buildTrackerDeepLink(trackerId: string, orgId: string): string {
  return `nimbalyst://tracker/${encodeURIComponent(trackerId)}?orgId=${encodeURIComponent(orgId)}`;
}

/**
 * Pending document to auto-open in CollabMode after switching modes.
 * Set by "Share to Team" action, consumed by CollabMode on activation.
 * Cleared after consumption. Carries initialContent for first-time shares
 * so the collaborative document can be seeded with file content.
 *
 * Single-shot signal; not workspace-scoped.
 */
export interface PendingCollabDocument {
  documentId: string;
  initialContent?: string;
  /**
   * Logical document type for routing. Defaults to 'markdown' for backward
   * compatibility with the original share flow. For non-markdown shares
   * (Excalidraw, Mindmap, etc.) the share callsite supplies the extension
   * so the recipient can route to the right editor on first open.
   */
  documentType?: string;
}
export const pendingCollabDocumentAtom = atom<PendingCollabDocument | null>(null);

/**
 * Pending shared folder to focus in CollabMode after switching modes (folder
 * deep link). Consumed by CollabMode on activation: expand ancestors + select.
 * Single-shot signal; not workspace-scoped.
 */
export const pendingCollabFolderAtom = atom<{ folderId: string } | null>(null);

// ============================================================
// Provider Instances (per workspace)
// ============================================================

const providersByPath = new Map<string, TeamSyncProviderType>();
const pendingRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Get the TeamSyncProvider instance for a workspace.
 *
 * @param workspacePath When omitted, returns the provider for the active
 *   workspace. Pass an explicit path to address an inactive (warm) project.
 */
export function getTeamSyncProvider(workspacePath?: string): TeamSyncProviderType | null {
  const path = workspacePath ?? store.get(activeWorkspacePathAtom);
  if (!path) return null;
  return providersByPath.get(path) ?? null;
}

// ============================================================
// Write Atoms
// ============================================================

/**
 * Add a shared document to the local list (optimistic update).
 * Use registerDocumentInIndex() to also register on the server.
 */
export const addSharedDocumentAtom = atom(
  null,
  (_get, set, doc: SharedDocument) => {
    set(sharedDocumentsAtom, (current) => {
      const filtered = current.filter(d => d.documentId !== doc.documentId);
      return [doc, ...filtered];
    });
  }
);

// ============================================================
// Server Registration
// ============================================================

/**
 * Register a document in the server-side doc index.
 * If connected to TeamRoom, encrypts the title and sends to server.
 * Also adds to local atom optimistically.
 */
export async function registerDocumentInIndex(
  documentId: string,
  title: string,
  documentType: string = 'markdown'
): Promise<void> {
  const now = Date.now();
  store.set(sharedDocumentsAtom, (current) => {
    const filtered = current.filter(d => d.documentId !== documentId);
    return [{
      documentId,
      title,
      documentType,
      createdBy: '',
      createdAt: now,
      updatedAt: now,
    }, ...filtered];
  });

  const provider = getTeamSyncProvider();
  const workspacePath = store.get(activeWorkspacePathAtom);
  if (provider) {
    try {
      await provider.registerDocument(documentId, title, documentType);
    } catch (err) {
      // NIM-1565: a failed send used to vanish (fire-and-forget). Queue it so
      // the next provider connect retries, instead of orphaning the doc.
      console.error('[collabDocuments] Failed to register in index:', err);
      if (workspacePath) {
        pendingDocRegistrations.enqueue(workspacePath, { documentId, title, documentType });
      }
    }
  } else if (workspacePath) {
    // NIM-1565: no team-sync provider yet (doc created/shared before
    // initSharedDocuments connected). Queue the registration for flush on
    // connect rather than silently dropping it — otherwise the doc has content
    // but never a doc-index entry, so it never appears in the Shared Items tree.
    pendingDocRegistrations.enqueue(workspacePath, { documentId, title, documentType });
  }
}

/**
 * Update a shared document title/path in the server-side index and local atom.
 * Used for rename and tree move operations.
 */
export async function updateSharedDocumentTitle(
  documentId: string,
  title: string
): Promise<void> {
  const now = Date.now();

  store.set(sharedDocumentsAtom, (current) => {
    const existing = current.find(doc => doc.documentId === documentId);
    if (!existing) {
      return current;
    }

    const filtered = current.filter(doc => doc.documentId !== documentId);
    return [{
      ...existing,
      title,
      updatedAt: now,
    }, ...filtered];
  });

  const provider = getTeamSyncProvider();
  if (provider) {
    try {
      await provider.updateDocumentTitle(documentId, title);
    } catch (err) {
      console.error('[collabDocuments] Failed to update document title:', err);
    }
  }
}

// ============================================================
// Removal
// ============================================================

/**
 * Remove a shared document from the server-side index and local atom.
 * Sends a docIndexRemove message to the TeamRoom via the provider.
 */
export function removeSharedDocument(documentId: string): void {
  store.set(sharedDocumentsAtom, (current) =>
    current.filter(d => d.documentId !== documentId)
  );

  const provider = getTeamSyncProvider();
  if (provider) {
    try {
      provider.removeDocument(documentId);
    } catch (err) {
      console.error('[collabDocuments] Failed to remove document from index:', err);
    }
  }
}

/**
 * Reparent a shared document into a folder (null = root). Optimistic local
 * update, then the server docMove. Touches only `parentFolderId` — the document
 * content and its local-to-shared link are untouched.
 */
export function moveSharedDocument(documentId: string, newParentFolderId: string | null): void {
  store.set(sharedDocumentsAtom, (current) =>
    current.map(d => d.documentId === documentId ? { ...d, parentFolderId: newParentFolderId } : d)
  );

  const provider = getTeamSyncProvider();
  if (provider) {
    try {
      provider.moveDocument(documentId, newParentFolderId);
    } catch (err) {
      console.error('[collabDocuments] Failed to move document:', err);
    }
  }
}

// ============================================================
// First-class Folders
// ============================================================

/**
 * Create a shared folder (optimistic local add + server register). Returns the
 * generated folderId so callers can select/expand it. `parentFolderId` null =
 * root level.
 */
export async function createSharedFolder(name: string, parentFolderId: string | null = null): Promise<string> {
  const folderId = crypto.randomUUID();
  const now = Date.now();
  const sortOrder = now; // monotonic-ish; newest sorts last among siblings

  store.set(sharedFoldersAtom, (current) => [
    ...current,
    { folderId, parentFolderId, name, sortOrder, createdBy: '', createdAt: now, updatedAt: now },
  ]);

  const provider = getTeamSyncProvider();
  if (provider) {
    try {
      await provider.registerFolder(folderId, name, parentFolderId, sortOrder);
    } catch (err) {
      console.error('[collabDocuments] Failed to register folder:', err);
    }
  }
  return folderId;
}

/**
 * Rename a LEGACY (path-in-title) folder — one that has no first-class
 * `folderId` yet. Rewrites the folder's segment in every descendant document's
 * title, which both updates the rendered fallback tree and syncs to the server
 * (via `updateSharedDocumentTitle`) so the rename survives and other clients see
 * it. Returns the number of documents retitled.
 */
export async function renameLegacyCollabFolder(folderPath: string, newName: string): Promise<number> {
  const documents = store.get(sharedDocumentsAtom);
  const updates = computeLegacyFolderRenameUpdates(documents, folderPath, newName);
  for (const { documentId, newTitle } of updates) {
    await updateSharedDocumentTitle(documentId, newTitle);
  }
  return updates.length;
}

/** Rename a shared folder in place. */
export async function renameSharedFolder(folderId: string, newName: string): Promise<void> {
  store.set(sharedFoldersAtom, (current) =>
    current.map(f => f.folderId === folderId ? { ...f, name: newName, updatedAt: Date.now() } : f)
  );

  const provider = getTeamSyncProvider();
  if (provider) {
    try {
      await provider.renameFolder(folderId, newName);
    } catch (err) {
      console.error('[collabDocuments] Failed to rename folder:', err);
    }
  }
}

/**
 * Move a shared folder to a new parent (null = root). The server rejects a move
 * into the folder's own subtree; we mirror that guard client-side so the
 * optimistic update never creates a local cycle.
 */
export function moveSharedFolder(folderId: string, newParentFolderId: string | null): void {
  const folders = store.get(sharedFoldersAtom);
  if (newParentFolderId && isDescendantFolder(folders, newParentFolderId, folderId)) {
    console.warn('[collabDocuments] Refusing to move folder into its own subtree:', folderId);
    return;
  }

  store.set(sharedFoldersAtom, (current) =>
    current.map(f => f.folderId === folderId ? { ...f, parentFolderId: newParentFolderId, updatedAt: Date.now() } : f)
  );

  const provider = getTeamSyncProvider();
  if (provider) {
    try {
      provider.moveFolder(folderId, newParentFolderId);
    } catch (err) {
      console.error('[collabDocuments] Failed to move folder:', err);
    }
  }
}

/**
 * Delete a shared folder recursively. Optimistically prunes the folder subtree
 * and its documents locally, then sends the server folderRemove (which cascades
 * the DocumentRoom deletes and broadcasts the removed id sets).
 */
export function removeSharedFolder(folderId: string): void {
  const folders = store.get(sharedFoldersAtom);
  const removedFolderIds = collectFolderSubtree(folders, folderId);
  const removed = new Set(removedFolderIds);

  store.set(sharedFoldersAtom, (current) => current.filter(f => !removed.has(f.folderId)));
  store.set(sharedDocumentsAtom, (current) =>
    current.filter(d => !(d.parentFolderId && removed.has(d.parentFolderId)))
  );

  const provider = getTeamSyncProvider();
  if (provider) {
    try {
      provider.removeFolder(folderId);
    } catch (err) {
      console.error('[collabDocuments] Failed to remove folder:', err);
    }
  }
}

/** Every folderId in the subtree rooted at `folderId` (inclusive). */
export function collectFolderSubtree(folders: SharedFolder[], folderId: string): string[] {
  const byParent = new Map<string | null | undefined, SharedFolder[]>();
  for (const f of folders) {
    const key = f.parentFolderId ?? null;
    const list = byParent.get(key) ?? [];
    list.push(f);
    byParent.set(key, list);
  }
  const out: string[] = [];
  const queue = [folderId];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    for (const child of byParent.get(id) ?? []) queue.push(child.folderId);
  }
  return out;
}

/** True if `candidateId` is `ancestorId` or lives under it in `folders`. */
export function isDescendantFolder(folders: SharedFolder[], candidateId: string, ancestorId: string): boolean {
  const byId = new Map(folders.map(f => [f.folderId, f]));
  let current: string | null | undefined = candidateId;
  const guard = new Set<string>();
  while (current) {
    if (current === ancestorId) return true;
    if (guard.has(current)) break;
    guard.add(current);
    current = byId.get(current)?.parentFolderId ?? null;
  }
  return false;
}

// ============================================================
// Migration: virtual (path-in-title) folders -> first-class folders
// ============================================================

/** Workspaces whose virtual-folder migration already ran this session. */
const migratedFolderWorkspaces = new Set<string>();

/**
 * Deterministic folderId for a normalized path so every client that runs the
 * migration converges on the SAME id (no duplicate folder rows). Uses SHA-256
 * of `orgId:path` truncated to 24 hex chars — collision-negligible for the
 * folder counts a team realistically has.
 */
async function stableFolderId(orgId: string, normalizedPath: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${orgId}:${normalizedPath}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  return `fld_${hex.slice(0, 24)}`;
}

/**
 * One-time (per session) migration from the legacy virtual-folder model (folder
 * structure encoded in each doc's `A/B/Doc` title) to first-class folder rows.
 *
 * Client-driven because the server cannot read encrypted titles in legacy mode.
 * Idempotent: folder ids are a deterministic hash of the path, so re-running
 * upserts the same rows and re-sets the same `parentFolderId`. Dual-write: the
 * doc TITLE is left untouched (still full-path) so un-upgraded clients keep
 * rendering the tree, while `parentFolderId` becomes the authoritative placement.
 *
 * Only migrates docs whose title contains a `/` and whose `parentFolderId` is
 * still null. Empty local-only folders (the retired `customFolders`) are not
 * carried over — they were never synced.
 */
/**
 * Pure derivation of the first-class folder structure implied by legacy
 * path-in-title documents. Returns every folder path (all ancestor prefixes,
 * shallowest first) and each migratable document's immediate parent path.
 * Documents already first-class (`parentFolderId` set) or at root (no `/`)
 * are skipped. Exported for testing.
 */
export function deriveVirtualFolderStructure(
  documents: SharedDocument[],
): { folderPaths: string[]; docParent: Map<string, string> } {
  const folderPaths = new Set<string>();
  const docParent = new Map<string, string>();
  for (const doc of documents) {
    if (doc.parentFolderId) continue; // already first-class
    // Undecryptable titles are raw ciphertext (base64, which can contain '/')
    // — never derive folders from them or we'd create garbage folder rows.
    if (doc.decryptFailed) continue;
    const path = normalizeCollabPath(doc.title);
    const parent = getCollabParentPath(path);
    if (!parent) continue; // root-level doc, nothing to migrate
    docParent.set(doc.documentId, parent);
    let p: string | null = parent;
    while (p) {
      folderPaths.add(p);
      p = getCollabParentPath(p);
    }
  }
  const sorted = Array.from(folderPaths).sort((a, b) => a.split('/').length - b.split('/').length);
  return { folderPaths: sorted, docParent };
}

/**
 * Build the optimistic first-class folder rows for a legacy migration. Pure so
 * the placement logic (parent linkage, leaf naming, sort order) is unit-testable
 * without the store or a live provider. `sortedFolderPaths` must be
 * shallowest-first so a parent's id resolves before its children.
 */
export function buildMigratedFolderRows(
  sortedFolderPaths: string[],
  idByPath: Map<string, string>,
  createdBy: string,
  now: number,
): SharedFolder[] {
  return sortedFolderPaths.map((path, index) => {
    const parentPath = getCollabParentPath(path);
    return {
      folderId: idByPath.get(path)!,
      parentFolderId: parentPath ? (idByPath.get(parentPath) ?? null) : null,
      name: getCollabNodeName(path),
      sortOrder: index,
      createdBy,
      createdAt: now,
      updatedAt: now,
    };
  });
}

async function migrateVirtualFolders(workspacePath: string, orgId: string): Promise<void> {
  if (migratedFolderWorkspaces.has(workspacePath)) return;

  const provider = providersByPath.get(workspacePath);
  if (!provider) return;

  const documents = store.get(sharedDocumentsAtomFamily(workspacePath));

  const { folderPaths: sorted, docParent } = deriveVirtualFolderStructure(documents);
  // Nothing to migrate YET. This is the common case on the first
  // `onDocumentsLoaded` of a connect, which fires from `teamSync` with raw
  // (undecryptable) titles before the decrypting `docIndexSync` pass arrives.
  // Do NOT consume the one-shot here, or the later decrypted pass — the one that
  // actually has path-in-title folders to migrate — would be blocked forever.
  if (sorted.length === 0) return;

  // We have real, decrypted path-in-title folders to migrate: claim the one-shot
  // now so concurrent `onDocumentsLoaded` callbacks don't double-register.
  migratedFolderWorkspaces.add(workspacePath);

  // Deterministic id per path (parent id resolves before children — `sorted` is
  // shallowest-first).
  const idByPath = new Map<string, string>();
  for (const path of sorted) {
    idByPath.set(path, await stableFolderId(orgId, path));
  }

  const now = Date.now();
  const createdBy = store.get(teamUserIdAtomFamily(workspacePath)) ?? '';
  const migratedFolders = buildMigratedFolderRows(sorted, idByPath, createdBy, now);

  // Optimistically add the folder rows locally FIRST. The server excludes the
  // sender from its folderBroadcast, so without this the migrating client would
  // not see its own folders until the next reconnect — which is exactly the
  // "Shared Items shows no folders" regression. Merge/dedupe by folderId so a
  // re-run (or a concurrent server load) never duplicates rows.
  store.set(sharedFoldersAtomFamily(workspacePath), (current) => {
    const byId = new Map(current.map(f => [f.folderId, f]));
    for (const f of migratedFolders) byId.set(f.folderId, f);
    return Array.from(byId.values());
  });

  // Register a folder row for each path on the server (deterministic id, parent
  // linkage). Parent-before-child by `migratedFolders` order.
  for (const folder of migratedFolders) {
    try {
      await provider.registerFolder(folder.folderId, folder.name, folder.parentFolderId ?? null, folder.sortOrder);
    } catch (err) {
      console.error('[collabDocuments] Folder migration register failed for', folder.name, err);
    }
  }

  // Optimistically point each legacy doc at its first-class parent folder in the
  // local atom, so once the first-class builder takes over (folders present) the
  // docs nest correctly instead of collapsing to root.
  store.set(sharedDocumentsAtomFamily(workspacePath), (current) =>
    current.map(d => {
      const parentPath = docParent.get(d.documentId);
      if (!parentPath) return d;
      const parentId = idByPath.get(parentPath);
      return parentId ? { ...d, parentFolderId: parentId } : d;
    })
  );

  // Persist each doc reparent to the server.
  for (const [documentId, parentPath] of docParent) {
    const parentId = idByPath.get(parentPath);
    if (parentId) {
      try {
        provider.moveDocument(documentId, parentId);
      } catch (err) {
        console.error('[collabDocuments] Folder migration docMove failed for', documentId, err);
      }
    }
  }

  console.log(`[collabDocuments] Migrated ${docParent.size} document(s) into ${sorted.length} first-class folder(s) for ${workspacePath}`);
}

// ============================================================
// Initialization
// ============================================================

/**
 * Initialize shared documents by connecting to the TeamRoom.
 * Resolves auth/keys via IPC, then creates and connects a TeamSyncProvider.
 * The TeamRoom provides both team state and document index in a single WebSocket.
 *
 * Multi-project: a provider is created per workspace path. Calling this for
 * a workspace that already has a connected provider is a no-op. Switching
 * the active project does not tear down inactive providers.
 */
export async function initSharedDocuments(workspacePath: string, retryCount = 0): Promise<void> {
  if (providersByPath.has(workspacePath)) {
    return;
  }

  const existingRetry = pendingRetryTimers.get(workspacePath);
  if (existingRetry) {
    clearTimeout(existingRetry);
    pendingRetryTimers.delete(workspacePath);
  }

  if (!window.electronAPI?.documentSync?.resolveIndexConfig) {
    return;
  }

  try {
    const result = await window.electronAPI.documentSync.resolveIndexConfig(workspacePath);
    if (!result.success || !result.config) {
      const isNotAuthenticated = result.error?.includes('Not authenticated');
      const isNoTeam = result.error?.includes('No team found');
      const isTransient = result.error && !isNotAuthenticated && !isNoTeam;
      if (!isTransient) {
        store.set(workspaceHasTeamAtomFamily(workspacePath), false);
      }
      const maxRetries = 5;
      if (isTransient && retryCount < maxRetries) {
        const delayMs = Math.min(3000 * Math.pow(2, retryCount), 30000);
        const timer = setTimeout(() => {
          pendingRetryTimers.delete(workspacePath);
          initSharedDocuments(workspacePath, retryCount + 1);
        }, delayMs);
        pendingRetryTimers.set(workspacePath, timer);
      }
      return;
    }

    store.set(workspaceHasTeamAtomFamily(workspacePath), true);
    const { orgId, teamProjectId, keyCustody, orgKeyBase64, legacyOrgKeysBase64, orgKeyFingerprint, serverUrl, userId, personalOrgId } = result.config;
    store.set(teamOrgIdAtomFamily(workspacePath), orgId);
    store.set(teamUserIdAtomFamily(workspacePath), userId ?? null);

    const { TeamSyncProvider } = await import('@nimbalyst/runtime/sync');

    // Epic H2: server-managed teams sync doc-index titles as plaintext (the
    // server encrypts at rest with the team DEK), so there is no org key to
    // import.
    const serverManaged = keyCustody === 'server-managed';
    const encryptionKey = serverManaged
      ? undefined
      : await crypto.subtle.importKey(
          'raw',
          Uint8Array.from(atob(orgKeyBase64), c => c.charCodeAt(0)),
          { name: 'AES-GCM', length: 256 },
          false,
          ['encrypt', 'decrypt']
        );

    // NIM-906/910: in server-managed mode, import every retained legacy org-key
    // EPOCH (current + archived) so the provider can read and self-heal
    // PRE-MIGRATION ciphertext titles even when the org key was rotated and
    // titles span epochs. Absent any, such titles render as locked entries,
    // never raw base64.
    const legacyOrgKeys: CryptoKey[] = [];
    if (serverManaged && Array.isArray(legacyOrgKeysBase64)) {
      for (const b64 of legacyOrgKeysBase64) {
        if (!b64) continue;
        legacyOrgKeys.push(
          await crypto.subtle.importKey(
            'raw',
            Uint8Array.from(atob(b64), c => c.charCodeAt(0)),
            { name: 'AES-GCM', length: 256 },
            false,
            ['encrypt', 'decrypt']
          )
        );
      }
    }

    const provider = new TeamSyncProvider({
      serverUrl,
      orgId,
      // Epic H3 P0/A: tag doc-index registers with the resolved project so the
      // server's project-partitioned index attributes docs to the right project.
      teamProjectId,
      userId,
      // Announced to the TeamRoom on connect so inbox-event fanout can reach
      // this member's PersonalIndexRoom. Undefined when personal sync is not
      // yet configured locally.
      personalOrgId,
      keyCustody: serverManaged ? 'server-managed' : 'legacy-e2e',
      encryptionKey,
      legacyOrgKeys,
      orgKeyFingerprint,
      getJwt: async () => {
        const jwtResult = await window.electronAPI.documentSync.getJwt(orgId);
        if (!jwtResult.success || !jwtResult.jwt) {
          throw new Error(jwtResult.error || 'Failed to get JWT');
        }
        return jwtResult.jwt;
      },

      onTeamStateLoaded: (state) => {
        if (state.documents.length > 0) {
          const incoming = state.documents.map(d => ({
            documentId: d.documentId,
            title: d.title,
            documentType: d.documentType,
            createdBy: d.createdBy,
            createdAt: d.createdAt,
            updatedAt: d.updatedAt,
            lastWriterUserId: d.lastWriterUserId,
            parentFolderId: d.parentFolderId,
            decryptFailed: d.decryptFailed,
          }));
          // NIM-1638: reconcile rather than replace so a partial teamSync
          // snapshot never blanks known rows.
          store.set(sharedDocumentsAtomFamily(workspacePath), (current) =>
            reconcileSharedDocuments(current, incoming)
          );
        }
        const incomingFolders = state.folders.map(mapFolderNode);
        store.set(sharedFoldersAtomFamily(workspacePath), (current) =>
          reconcileSharedFolders(current, incomingFolders)
        );
      },

      onDocumentsLoaded: (documents) => {
        const incoming = documents.map(d => ({
          documentId: d.documentId,
          title: d.title,
          documentType: d.documentType,
          createdBy: d.createdBy,
          createdAt: d.createdAt,
          updatedAt: d.updatedAt,
          lastWriterUserId: d.lastWriterUserId,
          parentFolderId: d.parentFolderId,
          decryptFailed: d.decryptFailed,
        }));
        // NIM-1638: a docIndexSync response fires on every (re)connect and used
        // to wholesale-replace the list; an empty/partial one blanked the tree.
        // Reconcile so briefly-dropped docs are restored, never left missing.
        store.set(sharedDocumentsAtomFamily(workspacePath), (current) =>
          reconcileSharedDocuments(current, incoming)
        );
        // One-time client-driven migration of legacy path-in-title folders into
        // first-class folder rows (idempotent, dual-write; no-op once migrated).
        void migrateVirtualFolders(workspacePath, orgId);
      },

      onDocumentChanged: (document) => {
        const incoming: SharedDocument = {
          documentId: document.documentId,
          title: document.title,
          documentType: document.documentType,
          createdBy: document.createdBy,
          createdAt: document.createdAt,
          updatedAt: document.updatedAt,
          lastWriterUserId: document.lastWriterUserId,
          parentFolderId: document.parentFolderId,
          decryptFailed: document.decryptFailed,
        };
        store.set(sharedDocumentsAtomFamily(workspacePath), (current) => {
          // NIM-1636: a broadcast during key transition can arrive with a
          // blank/locked title — merge so it never blanks a name we already have.
          const existing = current.find(d => d.documentId === incoming.documentId);
          const merged = existing ? mergeSharedDocument(existing, incoming) : incoming;
          const filtered = current.filter(d => d.documentId !== incoming.documentId);
          return [merged, ...filtered];
        });
      },

      onDocumentRemoved: (documentId) => {
        store.set(sharedDocumentsAtomFamily(workspacePath), (current) =>
          current.filter(d => d.documentId !== documentId)
        );
      },

      onFoldersLoaded: (folders) => {
        const incoming = folders.map(mapFolderNode);
        // NIM-1638: reconcile rather than replace so an empty/partial
        // folderIndexSync (fired on every reconnect) never wipes the tree.
        store.set(sharedFoldersAtomFamily(workspacePath), (current) =>
          reconcileSharedFolders(current, incoming)
        );
      },

      onFolderChanged: (folder) => {
        const incoming = mapFolderNode(folder);
        store.set(sharedFoldersAtomFamily(workspacePath), (current) => {
          // NIM-1636: keep a known folder name if this broadcast decrypts to empty.
          const existing = current.find(f => f.folderId === incoming.folderId);
          const merged = existing ? mergeSharedFolder(existing, incoming) : incoming;
          const filtered = current.filter(f => f.folderId !== incoming.folderId);
          return [...filtered, merged];
        });
      },

      onFoldersRemoved: (folderIds, documentIds) => {
        const removedFolders = new Set(folderIds);
        const removedDocs = new Set(documentIds);
        store.set(sharedFoldersAtomFamily(workspacePath), (current) =>
          current.filter(f => !removedFolders.has(f.folderId))
        );
        store.set(sharedDocumentsAtomFamily(workspacePath), (current) =>
          current.filter(d => !removedDocs.has(d.documentId))
        );
      },

      onMemberAdded: (member) => {
        (window as any).electronAPI.team.autoWrapNewMembers(orgId).catch((err: unknown) => {
          console.error('[collabDocuments] auto-wrap after memberAdded failed:', err);
        });
        // Epic H1: keep the local org_members projection live.
        (window as any).electronAPI.org
          .applyMemberUpserted(orgId, member.userId, member.email ?? null, member.role)
          .catch((err: unknown) => {
            console.error('[collabDocuments] applyMemberUpserted failed:', err);
          });
      },

      onMemberRoleChanged: (userId, role) => {
        (window as any).electronAPI.org
          .applyMemberRoleChanged(orgId, userId, role)
          .catch((err: unknown) => {
            console.error('[collabDocuments] applyMemberRoleChanged failed:', err);
          });
      },

      onMemberRemoved: (userId) => {
        (window as any).electronAPI.org
          .applyMemberRemoved(orgId, userId)
          .catch((err: unknown) => {
            console.error('[collabDocuments] applyMemberRemoved failed:', err);
          });
      },

      onProjectAccessChanged: (projectId, userId, projectRole) => {
        (window as any).electronAPI.org
          .applyProjectAccess(projectId, userId, projectRole)
          .catch((err: unknown) => {
            console.error('[collabDocuments] applyProjectAccess failed:', err);
          });
      },

      onIdentityKeyUploaded: (_userId) => {
        (window as any).electronAPI.team.autoWrapNewMembers(orgId).catch((err: unknown) => {
          console.error('[collabDocuments] auto-wrap after identityKeyUploaded failed:', err);
        });
      },

      onOrgKeyRotated: (fingerprint) => {
        // The org encryption key was rotated. ALL providers holding the old
        // key must be torn down and recreated with the new key.
        errorNotificationService.showInfo(
          'Team encryption key updated',
          'Reconnecting with the new key...',
          { duration: 5000 }
        );

        (window as any).electronAPI.invoke('team:handle-org-key-rotated', orgId, fingerprint)
          .then(async (result: { success: boolean; keyRefreshed?: boolean; error?: string }) => {
            if (result?.success && result.keyRefreshed) {
              destroyTeamSync(workspacePath);
              await initSharedDocuments(workspacePath);

              try {
                (window as any).electronAPI.invoke('tracker-sync:restart-for-workspace', workspacePath);
              } catch (trackerErr) {
                console.error('[collabDocuments] Failed to restart tracker sync:', trackerErr);
              }

              store.set(collabKeyRotationEpochAtom, (prev: number) => prev + 1);

              errorNotificationService.showInfo(
                'Encryption key updated',
                'All sync providers reconnected with the new key.',
                { duration: 5000 }
              );
            } else if (result?.success && !result.keyRefreshed) {
              errorNotificationService.showWarning(
                'Waiting for updated key',
                'An admin needs to share the updated encryption key with you. Some items may be temporarily unreadable.',
                { duration: 10000 }
              );
            }
          })
          .catch((err: unknown) => {
            console.error('[collabDocuments] Failed to handle org key rotation:', err);
            errorNotificationService.showWarning(
              'Key rotation failed',
              'Failed to fetch the updated encryption key. Try reopening the workspace.',
              { duration: 10000 }
            );
          });
      },

      onStatusChange: (status) => {
        store.set(teamSyncStatusAtomFamily(workspacePath), status);
      },
    });

    // Connect first; only cache the provider once it has actually attached.
    // Caching before connect leaves a dead provider in the map if connect()
    // throws, and `initSharedDocuments` short-circuits on subsequent calls
    // for that path because `providersByPath.has(...)` returns true. The
    // user is then unable to retry team sync for that workspace without
    // reopening it.
    try {
      await provider.connect();
      providersByPath.set(workspacePath, provider);
      // NIM-1565: flush any registrations queued while this workspace had no
      // connected provider (e.g. a doc created/shared during startup). The
      // provider itself queues sends across a socket blip; this covers the
      // earlier window where no provider existed at all.
      void pendingDocRegistrations.flush(workspacePath, provider).then(({ flushed, failed }) => {
        if (flushed > 0) {
          console.log(`[collabDocuments] Flushed ${flushed} pending doc registration(s) for ${workspacePath}`);
        }
        if (failed.length > 0) {
          console.warn(`[collabDocuments] ${failed.length} pending doc registration(s) still unsent for ${workspacePath}`);
        }
      }).catch((flushErr) => {
        console.warn('[collabDocuments] Failed to flush pending doc registrations:', flushErr);
      });
    } catch (connectErr) {
      provider.destroy();
      throw connectErr;
    }
  } catch (err) {
    console.error('[collabDocuments] Failed to initialize team sync:', err);
    store.set(teamSyncStatusAtomFamily(workspacePath), 'error');
  }
}

/**
 * Disconnect and clean up a workspace's team sync provider.
 *
 * @param workspacePath When omitted, destroys the active workspace's
 *   provider. Pass an explicit path to tear down a warm (inactive) project,
 *   for example when removing it from the project rail.
 */
export function destroyTeamSync(workspacePath?: string): void {
  const path = workspacePath ?? store.get(activeWorkspacePathAtom);
  if (!path) return;

  const provider = providersByPath.get(path);
  if (!provider) return;

  provider.destroy();
  providersByPath.delete(path);

  const retryTimer = pendingRetryTimers.get(path);
  if (retryTimer) {
    clearTimeout(retryTimer);
    pendingRetryTimers.delete(path);
  }

  store.set(teamSyncStatusAtomFamily(path), 'disconnected');
  store.set(workspaceHasTeamAtomFamily(path), false);
  store.set(teamOrgIdAtomFamily(path), null);
}

/**
 * Drop every cached collab/team-sync slot for `workspacePath`. Use when a
 * project is closed from the rail so we don't leak atom-family entries or
 * a connected provider after `destroyTeamSync` has run.
 */
export function pruneCollabDocumentsWorkspaceState(workspacePath: string): void {
  // Provider should already have been torn down via destroyTeamSync; if it
  // is still around, clean it up now.
  const provider = providersByPath.get(workspacePath);
  if (provider) {
    try {
      provider.destroy();
    } catch (err) {
      console.error('[collabDocuments] destroy during prune failed:', err);
    }
    providersByPath.delete(workspacePath);
  }
  const retryTimer = pendingRetryTimers.get(workspacePath);
  if (retryTimer) {
    clearTimeout(retryTimer);
    pendingRetryTimers.delete(workspacePath);
  }
  sharedDocumentsAtomFamily.remove(workspacePath);
  teamSyncStatusAtomFamily.remove(workspacePath);
  workspaceHasTeamAtomFamily.remove(workspacePath);
}
