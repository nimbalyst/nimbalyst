/**
 * Tells the genuine `claude` CLI that our loopback observation proxy is a
 * faithful passthrough to Anthropic, not a third-party inference gateway.
 *
 * WHY. We point the CLI at the proxy with `ANTHROPIC_BASE_URL`. The CLI
 * treats any base URL whose host isn't `api.anthropic.com` as a gateway and
 * withholds behavior it can't assume a gateway supports, including the
 * small/fast model (Haiku) it normally runs the WebSearch / WebFetch side query
 * on. Denied Haiku, that side query falls back to the MAIN model while keeping
 * its hardcoded `thinking: {type: "disabled"}` and inheriting the session's
 * `output_config.effort`. At effort `max` the API rejects the pair:
 *
 *   400 output_config.effort 'max' is not supported when thinking is disabled
 *       on this model. Use effort 'high' or below, or enable thinking.
 *
 * so every web search failed for anyone running at max effort. Measured on CLI
 * 2.1.220 by teeing the outbound `/v1/messages`:
 *
 *   without the flag  model=claude-opus-5           thinking=disabled  effort=max  -> 400
 *   with the flag     model=claude-haiku-4-5-...    thinking=disabled  (no effort) -> 200
 *
 * Note the main conversation is NOT affected: those requests keep
 * `thinking: {type: "adaptive"}` either way. Only the web-tool side query breaks.
 *
 * WHEN WE MAY SAY IT. Only when the proxy really does forward to
 * `api.anthropic.com`, which is the default. A user who configured
 * `claudeCode.apiUpstreamUrl` (token compression, cache, their own gateway) gets
 * no declaration: we would be making a promise about someone else's endpoint,
 * and the CLI would send tool_reference blocks and first-party-only betas that
 * the middleware may not forward.
 *
 * The flag is an internal CLI escape hatch (leading underscore). If a future CLI
 * drops it, the failure mode is a return to today's behavior, not a broken
 * session, so it stays a best-effort hint, never a launch precondition.
 */

/**
 * CLI env var that short-circuits its `ANTHROPIC_BASE_URL` host check and makes
 * every first-party-only code path behave as if we were talking to
 * `api.anthropic.com` directly.
 */
export const ASSUME_FIRST_PARTY_BASE_URL_ENV = '_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL';

/** The one host the CLI itself accepts as first-party. */
const FIRST_PARTY_HOST = 'api.anthropic.com';

/**
 * True when the observation proxy forwards to Anthropic unchanged. Unset/blank
 * upstream means the proxy's own default (`https://api.anthropic.com`).
 */
function forwardsToAnthropic(upstreamUrl: string | undefined): boolean {
  const trimmed = upstreamUrl?.trim();
  if (!trimmed) return true;
  try {
    return new URL(trimmed).hostname === FIRST_PARTY_HOST;
  } catch {
    // Unparseable: assume nothing.
    return false;
  }
}

/**
 * Env overrides to spawn the CLI with, given the proxy's configured upstream.
 * Empty object when we can't honestly claim first-party.
 */
export function buildProxyPassthroughEnv(
  upstreamUrl: string | undefined,
): Record<string, string> {
  return forwardsToAnthropic(upstreamUrl) ? { [ASSUME_FIRST_PARTY_BASE_URL_ENV]: '1' } : {};
}
