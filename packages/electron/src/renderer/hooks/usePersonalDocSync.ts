/**
 * usePersonalDocSync
 *
 * Placeholder hook for personal document sync (mobile markdown sync).
 *
 * In the new architecture, file content sync happens via a background
 * ProjectSyncProvider in the main process (one WebSocket per project),
 * NOT per-file DocumentSyncProviders in the renderer.
 *
 * Yjs editor integration (WS4) will be added here once ProjectSyncProvider
 * exists -- at that point, opening a .md tab will upgrade the file from
 * markdown phase to Yjs phase for live CRDT sync.
 *
 * For now, this returns null (no collaboration config), which means
 * TabEditor operates in normal disk-only mode. Background sync handles
 * pushing encrypted markdown content to the ProjectSyncRoom DO.
 */

import { useMemo } from 'react';
import type { Doc } from 'yjs';
import type { Provider } from '@lexical/yjs';

interface UsePersonalDocSyncResult {
  collaborationConfig: {
    providerFactory: (id: string, yjsDocMap: Map<string, Doc>) => Provider;
    shouldBootstrap: boolean;
    initialContent?: string;
    username?: string;
    cursorColor?: string;
    personalSync: boolean;
  } | null;
  /** Whether sync is still being resolved */
  loading: boolean;
}

/**
 * Hook to set up personal document sync for a .md file in TabEditor.
 *
 * Currently returns null -- Yjs editor integration will be added when
 * ProjectSyncProvider (WS2) and Yjs editor integration (WS4) are built.
 *
 * @param filePath - Absolute path to the .md file
 * @param initialContent - Content loaded from disk (used to seed Y.Doc on first sync)
 * @param isMarkdown - Whether this file is a markdown file (sync only applies to .md)
 */
export function usePersonalDocSync(
  _filePath: string,
  _initialContent: string,
  _isMarkdown: boolean,
): UsePersonalDocSyncResult {
  // TODO: WS4 - When ProjectSyncProvider exists, this hook will:
  // 1. Get a reference to the project's ProjectSyncProvider (from main process)
  // 2. Check if this file has Yjs state (hasYjs from project sync manifest)
  // 3. On first edit, send fileYjsInit to upgrade to Yjs phase
  // 4. Create a CollabLexicalProvider backed by the project's WebSocket
  // 5. Return collaborationConfig for MarkdownEditor

  return useMemo(() => ({
    collaborationConfig: null,
    loading: false,
  }), []);
}
