/**
 * Where the CLI observation proxy forwards `/v1/messages`.
 *
 * The proxy sits on the CLI's `ANTHROPIC_BASE_URL`, which hides any base URL
 * the user set in Claude's own settings `env` (a local model router, say). An
 * explicit Nimbalyst upstream wins; otherwise a loopback base URL from Claude
 * settings is followed so the CLI reaches the same endpoint it would outside
 * Nimbalyst. A non-loopback one is refused: the requests carry the
 * subscription OAuth token and must not leave the machine.
 */

import { isValidClaudeCodeApiUpstreamUrl } from '../../../utils/store';

export interface ProxyUpstreamDecision {
  upstreamUrl: string | undefined;
  /** Set when Claude settings named a base URL that we could not follow. */
  ignoredClaudeSettingsBaseUrl?: string;
}

export function resolveClaudeCliProxyUpstream(
  explicitUpstreamUrl: string | undefined,
  claudeSettingsBaseUrl: string | undefined,
): ProxyUpstreamDecision {
  if (explicitUpstreamUrl) return { upstreamUrl: explicitUpstreamUrl };
  if (!claudeSettingsBaseUrl) return { upstreamUrl: undefined };
  return isValidClaudeCodeApiUpstreamUrl(claudeSettingsBaseUrl)
    ? { upstreamUrl: claudeSettingsBaseUrl }
    : { upstreamUrl: undefined, ignoredClaudeSettingsBaseUrl: claudeSettingsBaseUrl };
}
