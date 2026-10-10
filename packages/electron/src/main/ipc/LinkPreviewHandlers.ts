/**
 * IPC for page link previews: the renderer asks, main fetches (see
 * `LinkPreviewService` for the request limits).
 */

import { safeHandle } from '../utils/ipcRegistry';
import { getLinkPreviewService } from '../services/linkPreview/LinkPreviewService';

export function registerLinkPreviewHandlers(): void {
  safeHandle('link-preview:fetch', async (_event, payload: { url?: unknown }) => {
    if (typeof payload?.url !== 'string' || !payload.url) throw new Error('url is required');
    if (payload.url.length > 2048) return null;
    return getLinkPreviewService().get(payload.url);
  });
}
