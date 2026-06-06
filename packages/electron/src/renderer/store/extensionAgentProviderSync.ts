/**
 * Keep ModelIdentifier's set of extension-contributed agent provider ids in
 * sync with the installed/enabled extensions, for the lifetime of the window.
 *
 * Why this exists: provider-from-model derivation (ModelIdentifier.tryParse)
 * only recognizes an extension provider id like "antigravity-gemini-agent"
 * once it has been registered. Registering only at app startup meant a
 * provider contributed by an extension enabled AFTER startup was unparseable
 * until the next relaunch, so its model ids silently fell back to claude-code
 * (#558 review, point 3). This subscribes to the extension loader and re-syncs
 * on every load / re-scan / unload, mirroring ExtensionAIToolsBridge.
 *
 * It deliberately does NOT touch the saved default model. An earlier draft
 * reset the default when its provider dropped out of the set, but that races
 * with async extension loading: during startup the loader fires once per
 * extension, so a non-agent extension loading before the agent extension would
 * see the agent provider "missing" and erase a still-valid saved default before
 * that extension finished loading. Registration is idempotent and self-healing
 * under that ordering; a stale default model is handled where it is consumed.
 */
import { getExtensionLoader } from '@nimbalyst/runtime';
import { ModelIdentifier } from '@nimbalyst/runtime/ai/server/types';

/** Provider ids contributed by every currently-loaded extension. */
function collectAgentProviderIds(): string[] {
  const loader = getExtensionLoader();
  if (!loader) return [];
  const ids: string[] = [];
  for (const ext of loader.getLoadedExtensions()) {
    const providers = ext.manifest.contributions?.aiAgentProviders;
    if (!Array.isArray(providers)) continue;
    for (const provider of providers) {
      if (provider && typeof provider.id === 'string' && provider.id) {
        ids.push(provider.id);
      }
    }
  }
  return ids;
}

let initialized = false;

/**
 * Wire up extension-agent-provider registration for this window. Idempotent.
 */
export function initializeExtensionAgentProviderSync(): void {
  if (initialized) return;
  initialized = true;

  const loader = getExtensionLoader();
  if (!loader) return;

  // Register from already-loaded extensions, then re-sync on every load /
  // re-scan / unload so a provider enabled after startup is recognized
  // immediately and a disabled one stops resolving.
  ModelIdentifier.setExtensionProviders(collectAgentProviderIds());
  loader.subscribe(() => {
    ModelIdentifier.setExtensionProviders(collectAgentProviderIds());
  });
}
