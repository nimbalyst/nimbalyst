/**
 * Codec host: answers the main process's document-conversion requests.
 *
 * Main cannot load extension code, so it cannot hold a complete codec
 * registry. This window can, so main delegates the `Y.Doc <-> file bytes` step
 * here: it sends the document's encoded state plus the file content, we run
 * the codec, and we return a minimal delta (or text/bytes) for main to apply.
 *
 * The conversion itself is transport-agnostic and lives in
 * `@nimbalyst/collab-adapters`; the web console and mobile will run the same
 * `handleCollabConversionRequest` over their own transports. Everything
 * Electron-specific stays in this file and its main-process counterpart,
 * `CollabConversionClient.ts`.
 *
 * Follows IPC_LISTENERS.md: subscribes ONCE at startup from App.tsx.
 */
import { store } from '@nimbalyst/runtime/store';
import {
  handleCollabConversionRequest,
  type CollabConversionRequest,
} from '@nimbalyst/collab-adapters';

import { activeWorkspacePathAtom } from '../atoms/openProjects';
import { registerBuiltinRendererCollabCodecs } from '../../services/rendererCollabCodecs';

const REQUEST_CHANNEL = 'collab-conversion:request';
const HOST_READY_CHANNEL = 'collab-conversion:host-ready';
const HOST_GONE_CHANNEL = 'collab-conversion:host-gone';

type IncomingRequest = CollabConversionRequest & { responseChannel: string };

export function initCollabConversionListeners(): () => void {
  // Populate this process's registry before announcing readiness, so main
  // never routes a request to a window that would answer "no codec".
  registerBuiltinRendererCollabCodecs();

  const cleanups: Array<() => void> = [];
  let disposed = false;

  cleanups.push(
    window.electronAPI.on(REQUEST_CHANNEL, (request: IncomingRequest) => {
      if (!request?.responseChannel) return;
      // `handleCollabConversionRequest` never throws -- a codec failure comes
      // back as `{ ok: false }` so main can fail loudly with the reason
      // instead of hanging on a response that never arrives.
      const response = handleCollabConversionRequest(request);
      window.electronAPI.send(request.responseChannel, response);
    }),
  );

  const announce = (workspacePath: string | null) => {
    if (disposed) return;
    window.electronAPI.send(HOST_READY_CHANNEL, { workspacePath });
  };

  announce(store.get(activeWorkspacePathAtom) ?? null);
  cleanups.push(
    store.sub(activeWorkspacePathAtom, () => {
      announce(store.get(activeWorkspacePathAtom) ?? null);
    }),
  );

  return () => {
    disposed = true;
    window.electronAPI.send(HOST_GONE_CHANNEL);
    cleanups.forEach((cleanup) => cleanup());
  };
}
