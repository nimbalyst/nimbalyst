/**
 * Provider API keys that must never reach a CLI agent child process.
 *
 * CLAUDE.md's standing rule: Nimbalyst never lets a key that happens to be in
 * the user's shell become an implicit billing source. A `.env` file left over
 * from unrelated work once billed a user's personal Anthropic account $100+
 * because `process.env.ANTHROPIC_API_KEY` was picked up silently.
 *
 * The scrub lives here — not inline at the one place that builds the env —
 * because the child environment is assembled in two steps: a provider builds a
 * sanitized map, and a protocol merges it over `process.env` when it spawns.
 * Deleting a key in step one does nothing if step two spreads `process.env`
 * afterwards; absence cannot mask a value. So the scrub must be applied to the
 * final map, after every merge, and both sides call the same function.
 */

/** Keys deleted from any CLI agent child environment. */
export const SCRUBBED_PROVIDER_API_KEY_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'OPENROUTER_API_KEY',
  'OPENAI_API_KEY',
  'CURSOR_API_KEY',
  'XAI_API_KEY',
  'GROK_API_KEY',
] as const;

/**
 * Delete every provider API key from `env`, in place, and return it.
 *
 * Call this on the map that is actually handed to `spawn`, never on an
 * intermediate that something else will merge `process.env` back into.
 */
export function scrubProviderApiKeys<T extends Record<string, string | undefined>>(env: T): T {
  for (const key of SCRUBBED_PROVIDER_API_KEY_ENV_VARS) {
    delete env[key];
  }
  return env;
}
