import { v4 as uuidv4 } from 'uuid';
import type { FileLink, FileLinkType } from '../../ai/server/types';

/**
 * Session file link store interface
 */
export interface SessionFileStore {
  ensureReady(): Promise<void>;
  addFileLink(link: Omit<FileLink, 'id'>): Promise<FileLink>;
  getFilesBySession(sessionId: string, linkType?: FileLinkType): Promise<FileLink[]>;
  /**
   * Batch fetch file links for multiple sessions.
   * More efficient than calling getFilesBySession() multiple times.
   */
  getFilesBySessionMany?(sessionIds: string[], linkType?: FileLinkType): Promise<FileLink[]>;
  getSessionsByFile(workspaceId: string, filePath: string, linkType?: FileLinkType): Promise<string[]>;
  /** Batch form of getSessionsByFile: one query for many files, across one or more workspace ids. */
  /** `lastLinkedAt` is the newest link row's time (ms) for that session and file. */
  getSessionsByFiles?(workspaceIds: string[], filePaths: string[], linkType?: FileLinkType): Promise<Array<{ sessionId: string; filePath: string; lastLinkedAt?: number }>>;
  deleteFileLink(id: string): Promise<void>;
  deleteSessionLinks(sessionId: string): Promise<void>;
  hasFileLink(sessionId: string, filePath: string, linkType: FileLinkType): Promise<boolean>;
}

let activeSessionFileStore: SessionFileStore | null = null;

export function setSessionFileStore(store: SessionFileStore | null): void {
  activeSessionFileStore = store;
}

export function hasSessionFileStore(): boolean {
  return activeSessionFileStore !== null;
}

export function getSessionFileStore(): SessionFileStore {
  if (!activeSessionFileStore) {
    throw new Error('Session file store adapter has not been configured');
  }
  return activeSessionFileStore;
}

function requireStore(): SessionFileStore {
  if (!hasSessionFileStore()) {
    throw new Error('Session file store adapter has not been provided to the runtime');
  }
  return getSessionFileStore();
}

/**
 * Repository for managing file-session relationships
 */
export const SessionFilesRepository = {
  setStore(store: SessionFileStore): void {
    setSessionFileStore(store);
  },

  registerStore(store: SessionFileStore): void {
    setSessionFileStore(store);
  },

  clearStore(): void {
    setSessionFileStore(null);
  },

  getStore(): SessionFileStore {
    return requireStore();
  },

  async ensureReady(): Promise<void> {
    await requireStore().ensureReady();
  },

  /**
   * Add a file link to a session
   * Automatically generates ID and prevents duplicates
   */
  async addFileLink(link: Omit<FileLink, 'id'>): Promise<FileLink> {
    const store = requireStore();
    const getEditedSignature = (metadata: Record<string, any> | undefined): string => {
      if (!metadata) return '';
      return JSON.stringify({
        toolName: metadata.toolName,
        operation: metadata.operation,
        bashCommand: metadata.bashCommand,
        linesAdded: metadata.linesAdded,
        linesRemoved: metadata.linesRemoved,
      });
    };

    // Check if link already exists
    const exists = await store.hasFileLink(link.sessionId, link.filePath, link.linkType);
    if (exists) {
      if (link.linkType !== 'edited') {
        // Return existing link without creating duplicate
        const existing = await store.getFilesBySession(link.sessionId, link.linkType);
        const match = existing.find(l => l.filePath === link.filePath && l.linkType === link.linkType);
        if (match) {
          return match;
        }
      } else if ((link.metadata as Record<string, unknown>)?.toolUseId) {
        // Avoid duplicate inserts when reprocessing the same tool use
        const existing = await store.getFilesBySession(link.sessionId, link.linkType);
        const linkToolUseId = (link.metadata as Record<string, unknown>).toolUseId;
        const targetSignature = getEditedSignature(link.metadata);
        const match = existing.find(
          l =>
            l.filePath === link.filePath &&
            l.linkType === link.linkType &&
            (l.metadata as Record<string, unknown>)?.toolUseId === linkToolUseId &&
            getEditedSignature(l.metadata) === targetSignature
        );
        if (match) {
          return match;
        }
      }
    }

    return await store.addFileLink(link);
  },

  /**
   * Get all file links for a session, optionally filtered by type
   */
  async getFilesBySession(sessionId: string, linkType?: FileLinkType): Promise<FileLink[]> {
    return await requireStore().getFilesBySession(sessionId, linkType);
  },

  /**
   * Batch fetch file links for multiple sessions.
   * More efficient than calling getFilesBySession() multiple times.
   */
  async getFilesBySessionMany(sessionIds: string[], linkType?: FileLinkType): Promise<FileLink[]> {
    if (sessionIds.length === 0) return [];
    const store = requireStore();
    if (store.getFilesBySessionMany) {
      return await store.getFilesBySessionMany(sessionIds, linkType);
    }
    // Fallback for stores that don't implement batch query
    const results = await Promise.all(
      sessionIds.map(id => store.getFilesBySession(id, linkType))
    );
    return results.flat();
  },

  /**
   * Get all sessions that have links to a specific file
   */
  async getSessionsByFile(workspaceId: string, filePath: string, linkType?: FileLinkType): Promise<string[]> {
    return await requireStore().getSessionsByFile(workspaceId, filePath, linkType);
  },

  /**
   * Which sessions link to each of `filePaths`, in one query. `workspaceId`
   * may list several ids because link rows are keyed by the path the session
   * ran in (a worktree path or its parent project).
   */
  async getSessionsByFiles(
    workspaceId: string | string[],
    filePaths: string[],
    linkType?: FileLinkType,
  ): Promise<Array<{ sessionId: string; filePath: string; lastLinkedAt?: number }>> {
    const workspaceIds = [...new Set(Array.isArray(workspaceId) ? workspaceId : [workspaceId])];
    if (filePaths.length === 0 || workspaceIds.length === 0) return [];
    const store = requireStore();
    if (!store.getSessionsByFiles) {
      throw new Error('Session file store does not support batched lookups');
    }
    return await store.getSessionsByFiles(workspaceIds, filePaths, linkType);
  },

  /**
   * Delete a specific file link
   */
  async deleteFileLink(id: string): Promise<void> {
    await requireStore().deleteFileLink(id);
  },

  /**
   * Delete all file links for a session
   */
  async deleteSessionLinks(sessionId: string): Promise<void> {
    await requireStore().deleteSessionLinks(sessionId);
  },

  /**
   * Check if a file link already exists
   */
  async hasFileLink(sessionId: string, filePath: string, linkType: FileLinkType): Promise<boolean> {
    return await requireStore().hasFileLink(sessionId, filePath, linkType);
  }
};

export type {
  FileLink,
  FileLinkType
};
