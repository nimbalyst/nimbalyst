/**
 * Host-side provider-resolution shim for extension-agent providers.
 *
 * Built deliberately as a thin lookup layer rather than a type-system change:
 * sessions today persist `session.provider` as the flat `AIProviderType` string
 * union. Widening that to a discriminated union with an explicit
 * `(extensionId, contributionId)` ref is the structurally correct fix, but it
 * touches the `ai_sessions` schema + every IPC handler that accepts a provider
 * arg. That schema-and-types reshape is flagged for Greg's ratification in the
 * seed PR rather than picked unilaterally.
 *
 * Until that lands, every code path that switches on `session.provider` and
 * throws "Unknown provider" on default calls into this shim first. If the
 * provider id maps to an `aiAgentProviders` contribution in
 * `AgentProviderRegistry`, the path takes the extension-agent branch (defer
 * auth, route to `ProviderFactory.createExtensionAgentProvider`). Otherwise it
 * falls through to the existing built-in switch.
 *
 * Sites this shim guards (each documented in-line at the call site):
 *   - AIService.getApiKeyForProvider           (returns 'not-required')
 *   - AIService session-create auth switch     (skips apiKey requirement)
 *   - AIService 'ai:testConnection' switch     (sets apiKey to 'not-required')
 *   - MessageStreamingHandler per-message init (requiresApiKey = false)
 *   - MessageStreamingHandler createProvider   (routes to createExtensionAgentProvider)
 */

import { getAgentProviderRegistry } from '../../extensions/AgentProviderRegistry';

/** Composite ref for an extension-contributed agent provider. */
export interface ExtensionAgentRef {
  extensionId: string;
  contributionId: string;
}

/**
 * Returns true if `provider` is the contribution id of a registered
 * `aiAgentProviders` contribution.
 *
 * `provider` is the flat string the runtime sees on `session.provider`. If
 * no extension has contributed a provider with this id, returns false and
 * the caller falls through to its built-in switch.
 */
export function isExtensionAgentProvider(provider: string): boolean {
  return getAgentProviderRegistry().findByContributionId(provider) !== undefined;
}

/**
 * Recovers the `(extensionId, contributionId)` ref from a flat provider id.
 *
 * Returns null when the id does not map to a registered extension agent
 * provider, signaling the caller to use the built-in switch path.
 */
export function resolveExtensionAgentRef(provider: string): ExtensionAgentRef | null {
  const entry = getAgentProviderRegistry().findByContributionId(provider);
  if (!entry) return null;
  return { extensionId: entry.extensionId, contributionId: entry.contributionId };
}
