/**
 * RendererGhCliService - Renderer-side facade for the `gh` CLI detector.
 *
 * Thin wrapper over the preload bridge methods registered in Phase A of
 * issue #307. Used by the PR review panel's onboarding banner to surface
 * GitHub CLI install/auth state without exposing any credentials.
 */

import type { GhCliStatus as MainGhCliStatus } from '../../main/services/GhCliDetector';

// Re-export the type as a module-scoped alias so consumers can
// `import type { GhCliStatus } from '.../RendererGhCliService'`.
export type GhCliStatus = MainGhCliStatus;

export class RendererGhCliService {
  async getStatus(): Promise<GhCliStatus> {
    if (!window.electronAPI) {
      throw new Error('electronAPI not available');
    }

    const response = await window.electronAPI.ghCliStatus();
    if (!response.success || !response.data) {
      throw new Error(response.error || 'Failed to get gh CLI status');
    }
    return response.data;
  }

  async refreshStatus(): Promise<GhCliStatus> {
    if (!window.electronAPI) {
      throw new Error('electronAPI not available');
    }

    const response = await window.electronAPI.ghCliRefreshStatus();
    if (!response.success || !response.data) {
      throw new Error(response.error || 'Failed to refresh gh CLI status');
    }
    return response.data;
  }

  onStatusChanged(callback: (status: GhCliStatus) => void): () => void {
    if (!window.electronAPI) {
      throw new Error('electronAPI not available');
    }
    return window.electronAPI.onGhCliStatusChanged(callback);
  }
}

let instance: RendererGhCliService | null = null;

export function getGhCliService(): RendererGhCliService {
  if (!instance) {
    instance = new RendererGhCliService();
  }
  return instance;
}
