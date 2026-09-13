/**
 * Thin invoke wrapper shared by the Cloudflare Sandboxes panel and its
 * subcomponents. The preload `invoke` is untyped and a missing handler rejects,
 * so this normalizes both into the contract's response shape — an unregistered
 * channel reads as an ordinary, renderable failure rather than an unhandled
 * rejection or, worse, a silently "successful" undefined.
 */

import type { CloudflareSandboxResponse } from '../../../../shared/cloudflareSandbox';

export async function invokeSandbox<T>(
  channel: string,
  payload?: unknown,
): Promise<CloudflareSandboxResponse<T>> {
  try {
    const raw = payload === undefined
      ? await window.electronAPI.invoke(channel)
      : await window.electronAPI.invoke(channel, payload);
    if (raw && typeof raw === 'object' && typeof (raw as { success?: unknown }).success === 'boolean') {
      return raw as CloudflareSandboxResponse<T>;
    }
    return {
      success: false,
      error: { code: 'unknown', message: 'Cloudflare sandbox support is unavailable in this build.' },
    };
  } catch (err: unknown) {
    return {
      success: false,
      error: { code: 'unknown', message: err instanceof Error ? err.message : 'Unexpected error' },
    };
  }
}
