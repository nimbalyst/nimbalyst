/**
 * App-wide guard against unhandled `window.open` calls (NIM-1487).
 *
 * No workspace window ever installed a `setWindowOpenHandler`, so any
 * renderer navigation the UI failed to intercept — most notably relative
 * file links in markdown docs (`./samples/foo.ts`) — spawned a default
 * Electron child window that resolved the path against the renderer origin
 * and rendered blank white. This guard makes that impossible:
 *
 * - `collab-asset://` opens are allowed (the protocol handler serves the
 *   decrypted attachment; see CollabAssetService / collabAssetProtocol.ts)
 * - external http(s)/mailto URLs open in the system browser
 * - everything else (file:, leaked same-origin relative links, unknown
 *   schemes) is denied and logged
 *
 * The in-app browser (BrowserSessionService) installs its own
 * `setWindowOpenHandler` on its webContents after creation, which replaces
 * this one — its behavior is unchanged.
 */

import { app, shell } from 'electron';

export type WindowOpenDecision = 'allow' | 'open-external' | 'deny';

export function decideWindowOpen(url: string, openerUrl: string | null): WindowOpenDecision {
  if (url.startsWith('collab-asset://')) {
    return 'allow';
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'deny';
  }

  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    // A relative editor link resolves against the renderer's own origin
    // (the Vite dev server in dev builds). That is a leaked file link, not
    // a website — never forward it to the system browser.
    if (openerUrl) {
      try {
        if (new URL(openerUrl).origin === parsed.origin) {
          return 'deny';
        }
      } catch {
        // opener URL unparseable (e.g. empty) — treat as external below
      }
    }
    return 'open-external';
  }

  if (parsed.protocol === 'mailto:') {
    return 'open-external';
  }

  return 'deny';
}

export function installWindowOpenGuard(): void {
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      const decision = decideWindowOpen(url, contents.getURL() || null);
      if (decision === 'allow') {
        return { action: 'allow' };
      }
      if (decision === 'open-external') {
        void shell.openExternal(url);
      } else {
        console.warn('[MAIN] Blocked window.open for URL:', url);
      }
      return { action: 'deny' };
    });
  });
}
