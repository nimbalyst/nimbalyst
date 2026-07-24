/**
 * Session Shares State
 *
 * Tracks which sessions have been shared (have active share links).
 * Used by SessionListItem context menu and AgentSessionHeader to show
 * share state and enable copy/unshare actions.
 *
 * Also tracks encryption keys (URL-safe base64) so that "Copy share link"
 * can reconstruct the full URL including the #key= fragment.
 */

import { atom } from 'jotai';
import { atomFamily } from '../debug/atomFamilyRegistry';

export interface ShareInfo {
  shareId: string;
  sessionId: string;
  title: string;
  sizeBytes: number;
  createdAt: string;
  expiresAt: string | null;
  viewCount: number;
  owningPersonalOrgId: string;
}

/**
 * Map of sessionId -> ShareInfo for all shared sessions.
 * Populated by fetching from server on app launch (if authenticated).
 */
export const sessionSharesMapAtom = atom<Map<string, ShareInfo>>(new Map());

/**
 * Whether shares have been fetched from server.
 */
export const sharesFetchedAtom = atom(false);

/**
 * Map of sessionId -> URL-safe base64 encryption key.
 * Used to reconstruct share URLs with #key= fragments.
 */
export const shareKeysAtom = atom<Map<string, string>>(new Map());

/**
 * Per-session derived atom: returns ShareInfo if shared, null otherwise.
 */
export const sessionShareAtom = atomFamily((sessionId: string) =>
  atom((get) => {
    const sharesMap = get(sessionSharesMapAtom);
    return sharesMap.get(sessionId) ?? null;
  })
);

/**
 * Write atom: fetch shares from server and populate the map.
 * Also fetches encryption keys from local store.
 */
export const fetchSessionSharesAtom = atom(null, async (get, set) => {
  try {
    const [sharesResult, keys] = await Promise.all([
      (window as any).electronAPI?.listShares(),
      (window as any).electronAPI?.getShareKeys(),
    ]);
    if (sharesResult?.success && sharesResult.shares) {
      const map = new Map<string, ShareInfo>();
      for (const share of sharesResult.shares) {
        map.set(share.sessionId, share);
      }
      set(sessionSharesMapAtom, map);
      set(sharesFetchedAtom, true);
    }
    if (keys) {
      const keyMap = new Map<string, string>();
      for (const [sessionId, key] of Object.entries(keys)) {
        keyMap.set(sessionId, key as string);
      }
      set(shareKeysAtom, keyMap);
    }
  } catch (error) {
    console.error('[sessionShares] Failed to fetch shares:', error);
  }
});

/**
 * Write atom: add a share to the local cache after successful upload.
 */
export const addSessionShareAtom = atom(null, (get, set, share: ShareInfo & { encryptionKey?: string }) => {
  const current = get(sessionSharesMapAtom);
  const next = new Map(current);
  next.set(share.sessionId, share);
  set(sessionSharesMapAtom, next);

  // Store the encryption key if provided
  if (share.encryptionKey) {
    const currentKeys = get(shareKeysAtom);
    const nextKeys = new Map(currentKeys);
    nextKeys.set(share.sessionId, share.encryptionKey);
    set(shareKeysAtom, nextKeys);
  }
});

/**
 * Write atom: remove a share from the local cache after successful unshare.
 */
export const removeSessionShareAtom = atom(null, (get, set, sessionId: string) => {
  const current = get(sessionSharesMapAtom);
  const next = new Map(current);
  next.delete(sessionId);
  set(sessionSharesMapAtom, next);

  const currentKeys = get(shareKeysAtom);
  const nextKeys = new Map(currentKeys);
  nextKeys.delete(sessionId);
  set(shareKeysAtom, nextKeys);
});

/**
 * Build the full share URL for a session, including the encryption key fragment if available.
 */
export function buildShareUrl(shareId: string, encryptionKey?: string): string {
  const baseUrl = `https://share.nimbalyst.com/share/${shareId}`;
  return encryptionKey ? `${baseUrl}#key=${encryptionKey}` : baseUrl;
}
