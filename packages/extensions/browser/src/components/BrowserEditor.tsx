import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import type { EditorHostProps } from '@nimbalyst/extension-sdk';
import { useEditorLifecycle } from '@nimbalyst/extension-sdk';
import {
  buildPreviewUrl,
  createBrowserSession,
  destroyBrowserSession,
  getOrCreateSessionIdForHost,
  goBackBrowserSession,
  goForwardBrowserSession,
  navigateBrowserSession,
  reloadBrowserSession,
  subscribeToExternalNav,
  subscribeToStateChanges,
  type BrowserNavigationState,
} from '../browserClient';
import { BrowserSurface } from './BrowserSurface';
import { BrowserToolbar } from './BrowserToolbar';

/**
 * Editor for plain `.html` files.
 *
 * - URL bar is pinned to the local `nim-preview://` URL; navigation is allowed
 *   within the workspace via relative links and within other tabs of the
 *   target site (anchor clicks).
 * - On disk save (via the host file watcher), we reload the view so iterating
 *   on raw HTML feels like editing-and-saving in a regular browser.
 * - Source mode is provided by the host (TabEditor swaps in Monaco for raw
 *   HTML editing); the editor itself does not implement source mode.
 */
export function BrowserEditor({ host }: EditorHostProps): JSX.Element {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [navState, setNavState] = useState<BrowserNavigationState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sessionIdRef = useRef<string>(getOrCreateSessionIdForHost(host, host.filePath));
  const sessionReadyRef = useRef(false);

  // Expose this editor's session to editor-scoped AI tools so the agent can
  // drive the HTML preview the user has open.
  useEffect(() => {
    host.registerEditorAPI?.({ getSessionId: () => sessionIdRef.current });
    return (): void => host.registerEditorAPI?.(null);
  }, [host]);

  // useEditorLifecycle wires theme + load lifecycle. We do not need to "apply"
  // the loaded text -- the BrowserSurface renders the rendered page directly,
  // and reload-on-file-change is what triggers a re-render.
  useEditorLifecycle<string>(host, {
    applyContent: () => {
      // Re-fire a reload so the rendered page picks up disk content changes.
      if (sessionReadyRef.current) {
        void reloadBrowserSession(sessionIdRef.current);
      }
    },
    parse: (raw: string) => raw,
    serialize: (raw: string) => raw,
  });

  // Resolve the file path to a `nim-preview://` URL once at mount. The build
  // step also enforces that the file lives under an active workspace -- if it
  // doesn't, we render an error rather than letting the user see a broken view.
  useEffect(() => {
    let cancelled = false;
    setError(null);
    setPreviewUrl(null);
    buildPreviewUrl(host.filePath, host.workspaceId)
      .then((url) => {
        if (cancelled) return;
        setPreviewUrl(url);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setError(err.message || 'Failed to build preview URL');
      });
    return (): void => {
      cancelled = true;
    };
  }, [host.filePath, host.workspaceId]);

  // Spin up the WebContentsView session once we have a URL.
  useEffect(() => {
    if (!previewUrl) return;
    const sessionId = sessionIdRef.current;
    let cancelled = false;

    createBrowserSession(sessionId, previewUrl)
      .then((state) => {
        if (cancelled) return;
        sessionReadyRef.current = true;
        setNavState(state);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setError(err.message || 'Failed to create browser session');
      });

    const unsubscribeState = subscribeToStateChanges(sessionId, (state) => {
      setNavState(state);
    });
    const unsubscribeExternal = subscribeToExternalNav(sessionId, (url) => {
      // For window.open() and target=_blank, route through the standard
      // workspace open-file flow when it's a local preview URL; for remote,
      // hand off to the OS so we don't surprise users with overlapping views.
      const electronAPI = (window as unknown as { electronAPI?: { invoke: (ch: string, ...args: unknown[]) => Promise<unknown> } }).electronAPI;
      if (url.startsWith('nim-preview://')) {
        // Same scheme as the current view; just navigate in-tab.
        void navigateBrowserSession(sessionId, url);
      } else if (electronAPI?.invoke) {
        void electronAPI.invoke('open-external', url).catch(() => {
          // ignore -- best effort
        });
      }
    });

    return (): void => {
      cancelled = true;
      unsubscribeState();
      unsubscribeExternal();
      sessionReadyRef.current = false;
      void destroyBrowserSession(sessionId);
    };
  }, [previewUrl]);

  if (error) {
    return (
      <div
        className="nim-browser-editor nim-browser-editor-error"
        style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: 16 }}
      >
        <div
          style={{
            padding: 12,
            border: '1px solid var(--nim-error)',
            background: 'color-mix(in srgb, var(--nim-error) 8%, var(--nim-bg))',
            color: 'var(--nim-text)',
            borderRadius: 4,
          }}
        >
          <strong>Cannot preview this file.</strong>
          <div style={{ marginTop: 8, fontSize: 13 }}>{error}</div>
        </div>
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
        pinnedUrlLabel={previewUrl ?? undefined}
      />
      <BrowserSurface sessionId={sessionIdRef.current} visible={!!previewUrl} />
    </div>
  );
}
