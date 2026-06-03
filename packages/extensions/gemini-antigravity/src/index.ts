/**
 * Google Gemini (Antigravity) extension - standalone marketplace package.
 *
 * Contributes ONE AI agent provider:
 *   - antigravity-gemini-agent  (agent, tool-loop over GetModelResponse)
 *
 * The Antigravity language server lifecycle (spawn + HTTPS RPC against the
 * self-signed cert at 127.0.0.1) runs as a backend module utility-process.
 * Auth rides the user's ~/.gemini login - no API key is stored by nimbalyst.
 *
 * Exports:
 *   - aiProviders.AntigravityAgentProvider  (matches manifest aiAgentProviders[].component reference)
 *   - settingsPanel.AntigravityAgentSettings
 */

// AntigravityAgentProvider class moved into the backend module
// (src/backend/agent.ts -> dist/agent.js). The renderer-side surface is now
// just the settings panel + the activate hook.
import { AntigravityAgentSettings } from './components/AntigravityAgentSettings';

/** Provider IDs we contribute (must match manifest aiAgentProviders[].id). */
const CONTRIBUTED_PROVIDER_IDS = [
  'antigravity-gemini-agent',
] as const;

interface PersistedProviderSettings {
  enabled?: boolean;
  [key: string]: unknown;
}

interface AISettingsSnapshot {
  providerSettings?: Record<string, PersistedProviderSettings | undefined>;
  [key: string]: unknown;
}

/**
 * Idempotent enable-on-activate.
 *
 * Reads the current provider settings, then for the contributed provider:
 *   - If the user has explicitly set `enabled: false`, leave it alone (opt-out wins).
 *   - Otherwise (missing entry OR `enabled !== false`), write `enabled: true`.
 *
 * Replaces the previous sentinel-based first-install flow. The sentinel was
 * fragile: if the original install's write failed silently, the sentinel could
 * still be set, leaving the provider permanently disabled until the user
 * intervened. This approach self-heals on every relaunch.
 *
 * After the enable pass, runs a one-shot Test connection so the user sees a
 * green check (or a clear error) without clicking anything.
 */
async function runActivationEnable(): Promise<void> {
  const api = (globalThis as { window?: Window }).window?.electronAPI as
    | {
        aiGetSettings?: () => Promise<AISettingsSnapshot>;
        aiSaveSettings?: (settings: unknown) => Promise<unknown>;
        aiTestConnection?: (
          provider: string,
          workspacePath?: string,
        ) => Promise<{ success: boolean; error?: string }>;
        aiClearModelCache?: () => Promise<unknown>;
      }
    | undefined;

  if (!api?.aiGetSettings || !api?.aiSaveSettings || !api?.aiTestConnection) {
    console.warn(
      '[gemini-antigravity] electronAPI unavailable in renderer; skipping enable-on-activate',
    );
    return;
  }

  // 1) Read current settings to honour user opt-out.
  let currentProviderSettings: Record<string, PersistedProviderSettings | undefined> = {};
  try {
    const snapshot = await api.aiGetSettings();
    currentProviderSettings = snapshot?.providerSettings ?? {};
  } catch (err) {
    console.error('[gemini-antigravity] enable-on-activate: aiGetSettings failed:', err);
    // Fall through with empty snapshot; write-through still enables the provider.
  }

  // 2) Determine which contributed providers need to be enabled.
  const slicesToWrite: Record<string, PersistedProviderSettings> = {};
  for (const providerId of CONTRIBUTED_PROVIDER_IDS) {
    const existing = currentProviderSettings[providerId];
    // Respect explicit opt-out. Any other shape (missing, partial, enabled:true) gets enabled:true.
    if (existing?.enabled === false) {
      console.log(
        `[gemini-antigravity] enable-on-activate: ${providerId} is user-disabled; leaving as-is`,
      );
      continue;
    }
    // Preserve any other fields the user/host may have set (e.g. defaultModel).
    slicesToWrite[providerId] = { ...(existing ?? {}), enabled: true };
  }

  if (Object.keys(slicesToWrite).length === 0) {
    console.log('[gemini-antigravity] enable-on-activate: nothing to do');
  } else {
    try {
      await api.aiSaveSettings({ providerSettings: slicesToWrite });
      console.log(
        '[gemini-antigravity] enable-on-activate: wrote enabled:true for',
        Object.keys(slicesToWrite).join(', '),
      );
    } catch (err) {
      console.error('[gemini-antigravity] enable-on-activate: aiSaveSettings failed:', err);
    }
  }

  // 3) Fire a one-shot Test connection so the user sees a green check.
  try {
    if (api.aiClearModelCache) {
      await api.aiClearModelCache();
    }
    const result = await api.aiTestConnection('antigravity-gemini-agent');
    if (result?.success) {
      console.log('[gemini-antigravity] auto-test: connection OK');
    } else {
      console.warn(
        '[gemini-antigravity] auto-test: connection failed:',
        result?.error ?? '(unknown error)',
      );
    }
  } catch (err) {
    console.warn('[gemini-antigravity] auto-test: aiTestConnection threw:', err);
  }
}

export async function activate(_context: unknown): Promise<void> {
  console.log('[gemini-antigravity] Extension activated');
  // Run idempotent enable + auto-test in the background so we don't block
  // activation on the connection probe (the underlying server cold-start can
  // take 5-10s). Self-heals: if a previous activation's write failed, this
  // run picks it up. Honours explicit user opt-out.
  void runActivationEnable().catch((err: unknown) => {
    console.warn('[gemini-antigravity] enable-on-activate failed:', err);
  });
}

export async function deactivate(): Promise<void> {
  console.log('[gemini-antigravity] Extension deactivated');
}

/**
 * Settings panel components, keyed by the manifest `settingsPanelComponent`
 * name. The provider class itself lives in the backend module entry now.
 */
export const settingsPanel = {
  AntigravityAgentSettings,
};

// Re-export the contributed IDs for any host integration that wants to know
// which providers this extension owns (used by sidebar usage chip targeting).
export { CONTRIBUTED_PROVIDER_IDS };
