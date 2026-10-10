/**
 * A Personal page of an extension type (a drawing, mind map, data model...):
 * the extension's own editor over a body stored in the local database. The
 * body is the type's file format as text, saved through the same versioned
 * queue as a markdown Personal page (`usePersonalPageBody`), so conflicts,
 * failed saves and history behave the same. No file and no server.
 *
 * The host is the file host's shape with the disk swapped out: the editor
 * loads the stored body, and its saves (made on the host's request, as a
 * file-backed extension editor's are) become body edits.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createEditorAPIOwnerToken,
  createExtensionStorage,
  registerEditorAPI,
  unregisterEditorAPI,
  type EditorHost,
  type ExtensionStorage,
} from '@nimbalyst/runtime';
import { store, themeIdAtom } from '@nimbalyst/runtime/store';
import { customEditorRegistry } from '../CustomEditors';
import { collabEditorLookupName } from '../TabEditor/collabEditorAvailability';
import { historyDialogFileAtom } from '../../store/atoms/historyDialog';
import { personalPageHistoryKey as personalPageDocumentPath } from '../../../shared/personalPageUri';
import { usePersonalPageBody } from './usePersonalPageBody';

/** How long after an edit the editor is asked for its content. */
const SAVE_REQUEST_DELAY_MS = 300;

const STUB_STORAGE: ExtensionStorage = {
  get: () => undefined,
  set: async () => {},
  delete: async () => {},
  getGlobal: () => undefined,
  setGlobal: async () => {},
  deleteGlobal: async () => {},
  getSecret: async () => undefined,
  setSecret: async () => {},
  deleteSecret: async () => {},
};

function createPersonalPageEditorHost(options: {
  documentId: string;
  workspacePath: string;
  fileName: string;
  extensionId: string;
  content: string;
  onSave: (content: string) => void;
  /** Shown inside another page: view only, and the page's own tab keeps its editor API. */
  embedded?: boolean;
  /** A newer stored body, pushed to the mounted editor (the embed's live view). */
  subscribeToChanges?: (callback: (content: string) => void) => () => void;
}): { host: EditorHost; dispose: () => void } {
  const embedded = options.embedded === true;
  const filePath = personalPageDocumentPath(options.documentId);
  const saveRequests = new Set<() => void | Promise<void>>();
  const ownerToken = createEditorAPIOwnerToken(`personal:${filePath}`);
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  // Editors re-serialize as they settle after a load; an unchanged body is not an edit.
  let lastSaved = options.content;
  const requestSave = () => {
    for (const request of saveRequests) void request();
  };
  let storage: ExtensionStorage;
  try {
    storage = createExtensionStorage(options.extensionId);
  } catch {
    storage = STUB_STORAGE;
  }
  const host: EditorHost = {
    filePath,
    fileName: options.fileName,
    get theme() { return store.get(themeIdAtom); },
    isActive: true,
    ...(embedded ? { embedded: true, readOnly: true, onReadOnlyChanged: () => () => undefined } : {}),
    workspaceId: options.workspacePath,
    onThemeChanged: (callback) => store.sub(themeIdAtom, () => callback(store.get(themeIdAtom))),
    loadContent: async () => options.content,
    loadBinaryContent: async () => {
      throw new Error('Personal pages store text; this editor needs a binary file.');
    },
    // In a tab, a body changed elsewhere remounts the editor on the stored copy instead.
    onFileChanged: (callback) => options.subscribeToChanges?.(callback) ?? (() => undefined),
    setDirty: (dirty) => {
      if (!dirty || embedded) return;
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        saveTimer = null;
        requestSave();
      }, SAVE_REQUEST_DELAY_MS);
    },
    saveContent: async (content) => {
      if (typeof content !== 'string') throw new Error('Personal pages store text; this editor saved binary content.');
      if (embedded || content === lastSaved) return;
      lastSaved = content;
      options.onSave(content);
    },
    onSaveRequested: (callback) => {
      saveRequests.add(callback);
      return () => { saveRequests.delete(callback); };
    },
    openHistory: () => store.set(historyDialogFileAtom, filePath),
    storage,
    setEditorContext: () => undefined,
    setEditorContextItems: () => undefined,
    registerEditorAPI: (api) => {
      if (embedded) return;
      if (api) registerEditorAPI(filePath, api, requestSave, { ownerToken, priority: 'visible' });
      else unregisterEditorAPI(filePath, ownerToken);
    },
    registerMenuItems: () => undefined,
  };
  return {
    host,
    dispose: () => {
      // The editor is still mounted when this runs on a remount; ask it for its last edit.
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
        requestSave();
      }
      if (!embedded) unregisterEditorAPI(filePath, ownerToken);
    },
  };
}

/** Where an editor's body comes from: the tab's save queue, or the embed's read-only snapshot. */
interface PersonalBodySource {
  status: 'loading' | 'ready' | 'unavailable' | 'error';
  initialContent: string;
  /** Bumped when the body is reloaded under the editor; a new host and a remounted editor. */
  editorEpoch: number;
  retryLoad: () => void;
  notice?: string | null;
  dismissNotice?: () => void;
  onEdit?: (content: string) => void;
  subscribeToChanges?: (callback: (content: string) => void) => () => void;
}

export interface PersonalExtensionPageBodyProps {
  documentId: string;
  workspacePath: string;
  page: { title: string; documentType: string; fileExtension?: string | null };
  className?: string;
}

/** A Personal page's tab: its editor saves to the body. */
export const PersonalExtensionPageBody: React.FC<PersonalExtensionPageBodyProps> = (props) => {
  const body = usePersonalPageBody({ workspacePath: props.workspacePath, documentId: props.documentId, saveDelayMs: 100 });
  return <PersonalExtensionEditor {...props} body={body} embedded={false} />;
};

/**
 * The stored body, read only, for an embed. Re-read when `revision` (the
 * page's `updatedAt`) moves, and handed to the mounted editor as a file change
 * so it keeps its view. Not the tab's save queue: that registers the page as
 * open, which agent edits and history restores rely on reaching the tab.
 */
function usePersonalPageSnapshot(workspacePath: string, documentId: string, revision: number | undefined): PersonalBodySource {
  const [status, setStatus] = useState<PersonalBodySource['status']>('loading');
  const [initialContent, setInitialContent] = useState('');
  const [loadAttempt, setLoadAttempt] = useState(0);
  const latestRef = useRef<string | null>(null);
  const listenersRef = useRef(new Set<(content: string) => void>());
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const body = (await window.electronAPI.invoke('personal-pages:get-body', workspacePath, documentId)) as { content: string } | null;
        if (cancelled) return;
        if (!body) {
          setStatus('unavailable');
          return;
        }
        if (latestRef.current === null) {
          setInitialContent(body.content);
          setStatus('ready');
        } else if (body.content !== latestRef.current) {
          for (const listener of listenersRef.current) listener(body.content);
        }
        latestRef.current = body.content;
      } catch (error) {
        if (cancelled) return;
        console.error('[PersonalExtensionPageView] Failed to load page body:', error);
        if (latestRef.current === null) setStatus('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspacePath, documentId, revision, loadAttempt]);
  const subscribeToChanges = useCallback((callback: (content: string) => void) => {
    listenersRef.current.add(callback);
    return () => { listenersRef.current.delete(callback); };
  }, []);
  const retryLoad = useCallback(() => setLoadAttempt((attempt) => attempt + 1), []);
  return { status, initialContent, editorEpoch: 0, retryLoad, subscribeToChanges };
}

/** A Personal page shown inside another page: view only, following the stored body. */
export const PersonalExtensionPageView: React.FC<PersonalExtensionPageBodyProps & { revision?: number }> = ({ revision, ...props }) => {
  const body = usePersonalPageSnapshot(props.workspacePath, props.documentId, revision);
  return <PersonalExtensionEditor {...props} body={body} embedded />;
};

const PersonalExtensionEditor: React.FC<PersonalExtensionPageBodyProps & { body: PersonalBodySource; embedded: boolean }> = ({
  documentId,
  workspacePath,
  page,
  className,
  body,
  embedded,
}) => {
  const onEditRef = useRef(body.onEdit);
  onEditRef.current = body.onEdit;
  const fileExtension = page.fileExtension ?? undefined;
  const registration = useMemo(
    () => customEditorRegistry.findRegistrationForFile(
      collabEditorLookupName({ fileName: page.title, fileExtension, title: page.title, documentType: page.documentType }),
    ),
    [page.title, page.documentType, fileExtension],
  );

  const ready = body.status === 'ready' && registration;
  const hosted = useMemo(() => (ready
    ? createPersonalPageEditorHost({
      documentId,
      workspacePath,
      fileName: `${page.title}${fileExtension ?? ''}`,
      extensionId: registration.extensionId ?? page.documentType,
      content: body.initialContent,
      onSave: (content) => onEditRef.current?.(content),
      embedded,
      subscribeToChanges: body.subscribeToChanges,
    })
    : null),
  // A new epoch is a reloaded body: a new host and a remounted editor.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [ready, documentId, workspacePath, body.editorEpoch, body.initialContent, embedded]);
  useEffect(() => () => hosted?.dispose(), [hosted]);

  if (!registration) {
    return (
      <div className={`personal-extension-page-body py-4 text-center text-sm text-nim-faint ${className ?? ''}`} role="status">
        No installed extension opens {page.documentType} pages. Install the extension that made this page to edit it.
      </div>
    );
  }
  const Editor = registration.component as React.ComponentType<{ host: EditorHost }>;
  return (
    <>
      {body.notice && (
        <div className="personal-page-tab-notice flex shrink-0 items-center gap-2 px-6 py-1.5 text-sm text-nim-muted" role="status">
          <span className="flex-1">{body.notice}</span>
          <button type="button" className="text-xs text-nim-muted hover:text-nim" onClick={body.dismissNotice}>Dismiss</button>
        </div>
      )}
      <div className={`personal-extension-page-body relative flex min-h-0 flex-1 flex-col ${className ?? ''}`} data-file-path={personalPageDocumentPath(documentId)}>
        {hosted ? (
          <Editor key={`${documentId}-${body.editorEpoch}`} host={hosted.host} />
        ) : (
          <div className="py-4 text-center text-sm text-nim-faint" role="status">
            {body.status === 'unavailable'
              ? 'This page is unavailable on this device. It may have been deleted. Check Wiki Trash for a recoverable copy.'
              : body.status === 'error' ? 'This page could not be loaded.' : 'Loading...'}
            {(body.status === 'unavailable' || body.status === 'error') && (
              <button type="button" className="ml-2 text-nim-link hover:underline" onClick={body.retryLoad}>Try again</button>
            )}
          </div>
        )}
      </div>
    </>
  );
};
