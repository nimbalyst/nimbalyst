/**
 * An editor page (drawing, mind map, spreadsheet, data model, mockup, calc
 * sheet) in the browser view: the extension's own editor component over the
 * file-mode host (`wikiFileEditorHost.ts`), which reads and writes the page's
 * file through `nim wiki serve`.
 *
 * The bundle loads the first time a page of its type opens. The host saves
 * after a short pause, on Cmd+S, and before the page closes; an outside write
 * under unsaved edits shows a bar to load the file or keep these edits.
 */
import { Component, useContext, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from 'react';
import { loadBrowserExtension } from '@nimbalyst/web-editors/registry';
import type { ExtensionEditorComponent } from '@nimbalyst/collab-bundle/editor';
import { wikiApi, wikiChanges } from '../api/client';
import { isStaticSite } from '../api/staticSite';
import { DraftStoreContext } from '../app/drafts';
import type { SaveState } from '../app/PageEditor';
import { createWikiFileEditorHost, type WikiFileEditorState } from '../host/wikiFileEditorHost';
import { currentTheme, onThemeChange } from '../theme';
import type { WikiEditorMatch } from './editorPageTypes';

export function editorSaveState(state: WikiFileEditorState): { state: SaveState; error: string | null } {
  if (state.error) return { state: 'error', error: state.error };
  if (state.saving) return { state: 'saving', error: null };
  if (state.dirty || state.conflict) return { state: 'unsaved', error: null };
  return { state: 'saved', error: null };
}

/** An editor that throws while rendering shows its error instead of blanking the app. */
class EditorErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    return this.state.error
      ? <div className="wiki-web-banner mx-8 my-2 text-xs text-nim-error" role="alert">This editor stopped: {this.state.error.message}</div>
      : this.props.children;
  }
}

export function ExtensionPageEditor({
  pageId,
  fileName,
  filePath,
  editor,
  onSaveState,
  embedded = false,
}: {
  pageId: string;
  fileName: string;
  filePath: string;
  editor: WikiEditorMatch;
  onSaveState?: (state: SaveState, error: string | null) => void;
  /** Inside a canvas card: the editor is told so, and the page's own shortcuts stay with the page. */
  embedded?: boolean;
}) {
  const drafts = useContext(DraftStoreContext);
  const [EditorComponent, setEditorComponent] = useState<ExtensionEditorComponent | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // One host per page; `fileName` changes on rename without reopening the file.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const host = useMemo(() => createWikiFileEditorHost({ pageId, fileName, filePath, embedded, theme: currentTheme(), api: wikiApi, changes: wikiChanges, readOnly: isStaticSite() }), [pageId]);
  const [state, setState] = useState(host.getState());

  useEffect(() => {
    let live = true;
    setLoadError(null);
    loadBrowserExtension(editor.extensionId).then((loaded) => {
      if (!live) return;
      const found = loaded.components[editor.component];
      if (found) setEditorComponent(() => found);
      else setLoadError(`The ${editor.displayName} editor is missing from its bundle`);
    }).catch((error: unknown) => {
      if (live) setLoadError(error instanceof Error ? error.message : String(error));
    });
    return () => {
      live = false;
    };
  }, [editor.extensionId, editor.component, editor.displayName]);

  useEffect(() => {
    setState(host.getState());
    const unsubscribeState = host.subscribeState(setState);
    const unsubscribeTheme = onThemeChange((theme) => host.setTheme(theme));
    const detach = drafts.attach({
      pageId,
      dirty: () => host.getState().dirty,
      conflicted: () => host.getState().conflict !== null,
      save: async (overwrite) => {
        if (overwrite && host.getState().conflict) await host.resolveConflict('mine');
        else await host.requestSave();
        const after = host.getState();
        return after.conflict ? 'conflict' : after.error ? 'error' : after.dirty ? 'error' : 'saved';
      },
      discard: () => {},
    });
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void host.requestSave();
      }
    };
    const onHide = () => void host.requestSave();
    window.addEventListener('keydown', onKey);
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pagehide', onHide);
      detach();
      unsubscribeTheme();
      unsubscribeState();
    };
  }, [drafts, host, pageId]);

  // Last edits are written on the way out; the host stops listening after. This
  // is a layout cleanup because it must run before the editor unmounts: React
  // runs a class editor's `componentWillUnmount` before any passive cleanup, and
  // Excalidraw empties its scene there, so a save from `useEffect` wrote an
  // empty drawing over the file.
  useLayoutEffect(() => () => {
    void host.requestSave().finally(() => host.dispose());
  }, [host]);

  useEffect(() => {
    const save = editorSaveState(state);
    onSaveState?.(save.state, save.error);
  }, [state, onSaveState]);

  return (
    <div className="wiki-web-extension-editor flex min-h-0 flex-1 flex-col" data-testid="wiki-web-extension-editor" data-extension-id={editor.extensionId}>
      {state.conflict ? (
        <div className="wiki-web-conflict mx-8 my-2 flex flex-wrap items-center gap-2 rounded border border-nim bg-nim-secondary px-3 py-2 text-xs text-nim" role="alert">
          <span className="flex-1">This file changed on disk while you were editing it.</span>
          <button type="button" className="rounded border border-nim px-2 py-1 hover:bg-nim-hover" onClick={() => void host.resolveConflict('theirs')}>
            Use the file
          </button>
          <button type="button" className="rounded border border-nim px-2 py-1 hover:bg-nim-hover" onClick={() => void host.resolveConflict('mine')}>
            Keep mine
          </button>
        </div>
      ) : null}
      {loadError ? <div className="wiki-web-banner mx-8 my-2 text-xs text-nim-error" role="alert">{loadError}</div> : null}
      <div className={`wiki-web-extension-editor-host relative flex-1 select-none ${embedded ? 'min-h-0' : 'min-h-[320px]'}`}>
        <div className="absolute inset-0">
          {EditorComponent ? (
            <EditorErrorBoundary>
              <EditorComponent host={host} />
            </EditorErrorBoundary>
          ) : loadError ? null : (
            <div className="p-8 text-xs text-nim-faint">Loading the {editor.displayName} editor…</div>
          )}
        </div>
      </div>
    </div>
  );
}
