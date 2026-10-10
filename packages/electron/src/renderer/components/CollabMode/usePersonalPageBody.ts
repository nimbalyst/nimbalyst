/**
 * Load and save a personal page's markdown body through the local
 * `personal-pages:*` IPC. The body lives in the local database, never in a
 * file, and needs no account or server.
 *
 * The body is read once. Edits are debounced into a single save that carries
 * the version it was based on; saves never overlap, so each one is made against
 * the version the previous one returned. When the stored body moved on
 * elsewhere (another window, an agent), the save is refused with the stored
 * copy: the editor remounts on it and a one-line notice says so.
 *
 * The user's text is never dropped. A refused draft (and anything typed after
 * it) is written to the page's local history before the stored copy replaces
 * it, whether or not the tab is still open. A failing save retries with
 * backoff while the tab is open; after the tab closes, or once the retries run
 * out, the unsaved text goes to local history instead.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { PERSONAL_TYPED_PAGE_HISTORY_PREFIX, personalPageHistoryKey } from '../../../shared/personalPageUri';
import { restorePersonalTypedPageBody } from '../../services/personalAgentEdit';

const DEFAULT_SAVE_DELAY_MS = 800;
/** Delays before each retry of a failed save; one initial attempt plus these. */
export const PERSONAL_PAGE_SAVE_RETRY_DELAYS_MS = [1000, 2000, 4000];

interface PersonalPageBody {
  content: string;
  version: number;
}

type UpdateBodyResult = { version: number } | { conflict: true; version: number; content: string };

const PERSONAL_PAGE_HISTORY_PREFIX = 'personal-doc://';

const RESTORE_CONFLICT = 'This page changed while restoring. Its current text was kept; try again.';

/** What an open editor for a page lets other surfaces do through its save queue. */
interface OpenPage {
  /** Save now and wait. */
  flush: () => Promise<void>;
  /** Replace the body with a history snapshot and show it in the editor. */
  restore: (markdown: string) => Promise<void>;
}

/** Open editors, by workspace and page. */
const openPages = new Map<string, OpenPage>();
const openPageKey = (workspacePath: string, documentId: string) => `${workspacePath}\x1f${documentId}`;

/**
 * Save whatever an open editor for this page has not stored yet, and wait for
 * it. Resolves at once when no editor has the page open; rejects when the edit
 * could not be saved. Callers that copy the stored body run this first.
 */
export function flushPersonalPageBody(workspacePath: string, documentId: string): Promise<void> {
  return openPages.get(openPageKey(workspacePath, documentId))?.flush() ?? Promise.resolve();
}

/** The local-history key main records personal page snapshots under. */
export { personalPageHistoryKey };

/**
 * Restore a local-history snapshot into a personal page or Personal typed
 * page body. Returns false for any other history key so the caller can take
 * its own path. A page open in an editor restores through that editor's save
 * queue, so the editor shows the restored text and its next save is made
 * against the restored version. Otherwise the body is saved at its current
 * version. Either way it rejects, without overwriting, if the body moved on
 * since it was read.
 */
export async function restoreHistoryToPersonalPage(
  historyKey: string,
  content: string,
  workspacePath: string | undefined,
): Promise<boolean> {
  if (historyKey.startsWith(PERSONAL_TYPED_PAGE_HISTORY_PREFIX)) {
    await restorePersonalTypedPageBody(historyKey.slice(PERSONAL_TYPED_PAGE_HISTORY_PREFIX.length), content);
    return true;
  }
  if (!historyKey.startsWith(PERSONAL_PAGE_HISTORY_PREFIX)) return false;
  const documentId = historyKey.slice(PERSONAL_PAGE_HISTORY_PREFIX.length);
  if (!workspacePath) throw new Error('No workspace is open to restore this page into.');
  const open = openPages.get(openPageKey(workspacePath, documentId));
  if (open) {
    await open.restore(content);
    return true;
  }
  const current = (await window.electronAPI.invoke(
    'personal-pages:get-body',
    workspacePath,
    documentId,
  )) as PersonalPageBody | null;
  if (!current) throw new Error('This page is unavailable. Restore it from Trash before restoring its history.');
  const result = (await window.electronAPI.invoke(
    'personal-pages:update-body',
    workspacePath,
    documentId,
    content,
    current.version,
  )) as UpdateBodyResult;
  if ('conflict' in result && result.conflict) {
    throw new Error(RESTORE_CONFLICT);
  }
  return true;
}

export interface UsePersonalPageBodyOptions {
  workspacePath: string;
  documentId: string;
  saveDelayMs?: number;
}

export interface PersonalPageBodyState {
  status: 'loading' | 'ready' | 'unavailable' | 'error';
  retryLoad: () => void;
  /** The body the editor mounts with; replaced when a conflict reloads it. */
  initialContent: string;
  /** Bumped when the body is reloaded under the editor; key the editor on it. */
  editorEpoch: number;
  /** One-line notice (conflict reload, failed save), or null. */
  notice: string | null;
  dismissNotice: () => void;
  /** Report the editor's current markdown after a change. */
  onEdit: (markdown: string) => void;
}

export function usePersonalPageBody({
  workspacePath,
  documentId,
  saveDelayMs = DEFAULT_SAVE_DELAY_MS,
}: UsePersonalPageBodyOptions): PersonalPageBodyState {
  const [status, setStatus] = useState<PersonalPageBodyState['status']>('loading');
  const [initialContent, setInitialContent] = useState('');
  const [editorEpoch, setEditorEpoch] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const retryLoad = useCallback(() => setLoadAttempt((attempt) => attempt + 1), []);

  // Even an empty page has a row and version; a missing row is not editable.
  const versionRef = useRef<number | undefined>(undefined);
  const pendingRef = useRef<string | null>(null);
  const inFlightRef = useRef(false);
  const inFlightSaveRef = useRef<Promise<void> | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadedRef = useRef(false);
  const mountedRef = useRef(true);
  const failedAttemptsRef = useRef(0);
  /** Counts refused saves, so a restore can tell the body moved on under it. */
  const conflictsRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    loadedRef.current = false;
    setStatus('loading');
    (async () => {
      try {
        const body = (await window.electronAPI.invoke(
          'personal-pages:get-body',
          workspacePath,
          documentId,
        )) as PersonalPageBody | null;
        if (cancelled) return;
        if (!body) {
          setStatus('unavailable');
          return;
        }
        versionRef.current = body.version;
        setInitialContent(body.content);
        loadedRef.current = true;
        setStatus('ready');
      } catch (error) {
        if (cancelled) return;
        console.error('[usePersonalPageBody] Failed to load page body:', error);
        setStatus('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspacePath, documentId, loadAttempt]);

  /** Keep text that cannot become the body in the page's local history. */
  const keepInHistory = useCallback((markdown: string, description: string) => {
    void (window.electronAPI.invoke(
      'history:create-snapshot',
      personalPageHistoryKey(documentId),
      markdown,
      'manual',
      description,
    ) as Promise<unknown>).catch((error) => {
      console.error('[usePersonalPageBody] Failed to keep unsaved text in history:', error);
    });
  }, [documentId]);

  const flush = useCallback(() => {
    if (inFlightRef.current || pendingRef.current === null) return;
    const markdown = pendingRef.current;
    pendingRef.current = null;
    inFlightRef.current = true;
    inFlightSaveRef.current = (window.electronAPI.invoke(
      'personal-pages:update-body',
      workspacePath,
      documentId,
      markdown,
      versionRef.current,
    ) as Promise<UpdateBodyResult>)
      .then((result) => {
        inFlightRef.current = false;
        failedAttemptsRef.current = 0;
        versionRef.current = result.version;
        if ('conflict' in result && result.conflict) {
          conflictsRef.current += 1;
          // The stored copy wins the body. The refused draft, or anything typed
          // over it since, goes to history so it can be restored.
          const draft = pendingRef.current ?? markdown;
          pendingRef.current = null;
          keepInHistory(draft, 'Unsaved edits kept after a conflict');
          if (!mountedRef.current) return;
          setInitialContent(result.content);
          setEditorEpoch((epoch) => epoch + 1);
          setNotice('This page changed elsewhere; your edits were kept in local history.');
          return;
        }
        if (pendingRef.current !== null && timerRef.current === null) flush();
      })
      .catch((error) => {
        inFlightRef.current = false;
        console.error('[usePersonalPageBody] Failed to save page body:', error);
        // A newer edit supersedes this text; otherwise it is still the latest.
        if (pendingRef.current === null) pendingRef.current = markdown;
        if (!mountedRef.current) {
          keepInHistory(pendingRef.current, 'Unsaved edits kept after a failed save');
          pendingRef.current = null;
          return;
        }
        const attempt = failedAttemptsRef.current;
        if (attempt >= PERSONAL_PAGE_SAVE_RETRY_DELAYS_MS.length) {
          // Out of retries: the text stays pending for the next edit to retry.
          failedAttemptsRef.current = 0;
          setNotice('This page could not be saved. Your next edit will retry.');
          return;
        }
        failedAttemptsRef.current = attempt + 1;
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
          timerRef.current = null;
          flush();
        }, PERSONAL_PAGE_SAVE_RETRY_DELAYS_MS[attempt]);
      });
  }, [workspacePath, documentId, keepInHistory]);

  const onEdit = useCallback((markdown: string) => {
    if (!loadedRef.current) return;
    pendingRef.current = markdown;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      flush();
    }, saveDelayMs);
  }, [flush, saveDelayMs]);

  // Save now instead of after the debounce, and wait until nothing is pending
  // or in flight. A failed save leaves the text pending, so a few rounds bound
  // the wait before reporting it.
  const saveNow = useCallback(async () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    for (let round = 0; round < 4 && (inFlightRef.current || pendingRef.current !== null); round += 1) {
      flush();
      await inFlightSaveRef.current;
    }
    if (inFlightRef.current || pendingRef.current !== null) {
      throw new Error('This page has edits that could not be saved.');
    }
  }, [flush]);

  // A history restore saves through this queue and remounts the editor on the
  // restored text, so the editor never shows the replaced body and its next
  // save is made against the restored version.
  const restore = useCallback(async (markdown: string) => {
    if (!loadedRef.current) throw new Error('This page is unavailable or still loading. Try again after it loads.');
    // An unsaved draft is stored first: it becomes a body, and so a history
    // entry, instead of being dropped by the restore.
    const conflictsBefore = conflictsRef.current;
    await saveNow();
    if (conflictsRef.current !== conflictsBefore) throw new Error(RESTORE_CONFLICT);

    // Hold the queue: an edit typed meanwhile waits behind the restore.
    inFlightRef.current = true;
    const write = window.electronAPI.invoke(
      'personal-pages:update-body',
      workspacePath,
      documentId,
      markdown,
      versionRef.current,
    ) as Promise<UpdateBodyResult>;
    inFlightSaveRef.current = write.then(() => undefined, () => undefined);
    let result: UpdateBodyResult;
    try {
      result = await write;
    } finally {
      inFlightRef.current = false;
    }
    versionRef.current = result.version;
    // Text typed while the restore saved was typed over the replaced body.
    if (pendingRef.current !== null) {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
      keepInHistory(pendingRef.current, 'Unsaved edits kept before a restore');
      pendingRef.current = null;
    }
    // On a conflict the editor reloads on the stored copy; it has no draft left to lose.
    const storedCopy = 'conflict' in result && result.conflict ? result.content : null;
    if (mountedRef.current) {
      setInitialContent(storedCopy ?? markdown);
      setEditorEpoch((epoch) => epoch + 1);
    }
    if (storedCopy !== null) {
      conflictsRef.current += 1;
      throw new Error(RESTORE_CONFLICT);
    }
  }, [workspacePath, documentId, saveNow, keepInHistory]);

  useEffect(() => {
    const key = openPageKey(workspacePath, documentId);
    const page: OpenPage = { flush: saveNow, restore };
    openPages.set(key, page);
    return () => {
      if (openPages.get(key) === page) openPages.delete(key);
    };
  }, [workspacePath, documentId, saveNow, restore]);

  // Closing the tab must not drop the last edit. A save still in flight takes
  // any pending text with it when it settles (see flush).
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      flush();
    };
  }, [flush]);

  const dismissNotice = useCallback(() => setNotice(null), []);

  return { status, retryLoad, initialContent, editorEpoch, notice, dismissNotice, onEdit };
}
