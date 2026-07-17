import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import type { EditorHostProps } from '@nimbalyst/extension-sdk';
import { useEditorLifecycle } from '@nimbalyst/extension-sdk';
import {
  BROWSER_VIRTUAL_PREFIX,
  createBrowserSession,
  destroyBrowserSession,
  getOrCreateSessionIdForHost,
  goBackBrowserSession,
  goForwardBrowserSession,
  navigateBrowserSession,
  parseVirtualBrowserPath,
  reloadBrowserSession,
  subscribeToExternalNav,
  subscribeToStateChanges,
  type BrowserNavigationState,
} from '../browserClient';
import { BrowserSurface } from './BrowserSurface';
import { BrowserToolbar } from './BrowserToolbar';

export interface BrowserSessionDocument {
  version: number;
  mode?: 'url' | 'localPreview';
  title?: string;
  url: string;
  viewportPreset?: 'desktop' | 'tablet' | 'mobile';
  autoReloadOnSave?: boolean;
}

function parseDocument(raw: string): BrowserSessionDocument {
  if (!raw.trim()) {
    return { version: 1, url: 'about:blank' };
  }
  const data = JSON.parse(raw);
  if (typeof data !== 'object' || data === null) {
    throw new Error('Browser session document must be a JSON object');
  }
  const url = typeof data.url === 'string' ? data.url : 'about:blank';
  return {
    version: typeof data.version === 'number' ? data.version : 1,
    mode: data.mode === 'localPreview' ? 'localPreview' : 'url',
    title: typeof data.title === 'string' ? data.title : undefined,
    url,
    viewportPreset:
      data.viewportPreset === 'tablet' || data.viewportPreset === 'mobile'
        ? data.viewportPreset
        : 'desktop',
    autoReloadOnSave: !!data.autoReloadOnSave,
  };
}

function serializeDocument(doc: BrowserSessionDocument): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/**
 * Editor for `.browser.json` persistent browser sessions.
 *
 * The document holds the target URL + preferences; the WebContentsView is
 * created on mount and torn down on unmount. Saves happen when the user edits
 * the URL bar (the new URL is persisted back into the document so the session
 * survives restart).
 */
export function BrowserSessionEditor({ host }: EditorHostProps): JSX.Element {
  // Fileless ("virtual://com.nimbalyst.browser/…") tabs carry their URL in the
  // path; .browser.json tabs load it from file content. For virtual tabs we also
  // mirror the *live* URL into extension storage so restore reopens the last
  // page rather than the one the tab was first opened with.
  const isVirtual = host.filePath.startsWith(BROWSER_VIRTUAL_PREFIX);
  const virtualRef = useRef(isVirtual ? parseVirtualBrowserPath(host.filePath) : null);
  const urlStorageKey = virtualRef.current ? `vbrowser-url:${virtualRef.current.tabId}` : '';

  const initialVirtualUrl = (() => {
    if (!virtualRef.current) return 'about:blank';
    const saved = host.storage?.get?.<string>(urlStorageKey);
    return (typeof saved === 'string' && saved) || virtualRef.current.url;
  })();

  const docRef = useRef<BrowserSessionDocument>({ version: 1, url: initialVirtualUrl });
  const [navState, setNavState] = useState<BrowserNavigationState | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Virtual tabs have their URL ready synchronously; file tabs wait for load.
  const [docLoaded, setDocLoaded] = useState(isVirtual);

  const sessionIdRef = useRef<string>(
    virtualRef.current
      ? virtualRef.current.sessionId
      : getOrCreateSessionIdForHost(host, host.filePath),
  );

  // Expose this editor's session to editor-scoped AI tools (browser.click,
  // browser.navigate, etc.) so the agent can drive the tab the user has open.
  useEffect(() => {
    host.registerEditorAPI?.({ getSessionId: () => sessionIdRef.current });
    return (): void => host.registerEditorAPI?.(null);
  }, [host]);

  const { markDirty } = useEditorLifecycle<BrowserSessionDocument>(host, {
    applyContent: (doc) => {
      // Virtual tabs derive their URL from the path/storage, not file content.
      if (isVirtual) {
        setDocLoaded(true);
        return;
      }
      docRef.current = doc;
      setDocLoaded(true);
    },
    getCurrentContent: () => docRef.current,
    parse: parseDocument,
    serialize: serializeDocument,
  });

  // Create the WebContentsView once the document URL is known.
  useEffect(() => {
    if (!docLoaded) return;
    const sessionId = sessionIdRef.current;
    let cancelled = false;

    createBrowserSession(sessionId, docRef.current.url || 'about:blank')
      .then((state) => {
        if (cancelled) return;
        setNavState(state);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setError(err.message || 'Failed to create browser session');
      });

    const unsubscribe = subscribeToStateChanges(sessionId, (state) => {
      setNavState(state);
      // Mirror the live URL so a restored virtual tab reopens the last page.
      if (virtualRef.current && state.url && state.url !== 'about:blank') {
        void host.storage?.set?.(urlStorageKey, state.url);
      }
    });
    const unsubscribeExternal = subscribeToExternalNav(sessionId, (url) => {
      const electronAPI = (window as unknown as { electronAPI?: { invoke: (ch: string, ...args: unknown[]) => Promise<unknown> } }).electronAPI;
      if (url.startsWith('nim-preview://')) {
        void navigateBrowserSession(sessionId, url);
      } else if (electronAPI?.invoke) {
        void electronAPI.invoke('open-external', url).catch(() => {
          // ignore -- best effort
        });
      }
    });

    return (): void => {
      cancelled = true;
      unsubscribe();
      unsubscribeExternal();
      void destroyBrowserSession(sessionId);
    };
  }, [docLoaded]);

  if (error) {
    return (
      <div className="nim-browser-editor nim-browser-editor-error" style={{ padding: 16 }}>
        <strong>Browser session error.</strong>
        <div style={{ marginTop: 8, fontSize: 13 }}>{error}</div>
      </div>
    );
  }

  return (
    <div
      className="nim-browser-editor"
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        position: 'relative',
      }}
    >
      <BrowserToolbar
        state={navState}
        onNavigate={(url): void => {
          docRef.current = { ...docRef.current, url };
          // Virtual tabs don't persist to a file, so don't flag them dirty;
          // their URL is mirrored to storage via the state-change subscription.
          if (!isVirtual) markDirty();
          void navigateBrowserSession(sessionIdRef.current, url).catch((err) => {
            setError(String(err?.message ?? err));
          });
        }}
        onBack={(): void => {
          void goBackBrowserSession(sessionIdRef.current);
        }}
        onForward={(): void => {
          void goForwardBrowserSession(sessionIdRef.current);
        }}
        onReload={(): void => {
          void reloadBrowserSession(sessionIdRef.current);
        }}
        onToggleSourceMode={
          host.supportsSourceMode && host.toggleSourceMode
            ? (): void => host.toggleSourceMode?.()
            : undefined
        }
        autoFocusUrl={isVirtual && initialVirtualUrl === 'about:blank'}
      />
      <BrowserSurface sessionId={sessionIdRef.current} visible={docLoaded} />
    </div>
  );
}
