/**
 * Environment sanitation for every Wrangler subprocess Nimbalyst spawns.
 *
 * Nimbalyst authenticates to Cloudflare exclusively through Wrangler's own
 * browser SSO, scoped to a named profile. That guarantee is only as good as the
 * environment the child process inherits: a single `CLOUDFLARE_API_TOKEN` left
 * over from unrelated work silently outranks every profile, and the user would
 * deploy to whatever account that token belongs to without ever being asked.
 *
 * The variable names below were read out of the Wrangler bundle we ship
 * (`getEnvironmentVariableFactory({ variableName: ... })` call sites in
 * wrangler 4.125.0), not guessed. Two categories are removed:
 *
 *   1. Credential-bearing. Wrangler's `getAuthFromEnv()` prefers the global
 *      API key pair, then `CLOUDFLARE_API_TOKEN`, over anything in the profile
 *      store. `CLOUDFLARE_CF_AUTH` swaps in an entirely different auth stack.
 *   2. Implicit selection. Account, environment, and the OAuth endpoint set.
 *      An inherited `CLOUDFLARE_ACCOUNT_ID` would pick an account the user
 *      never chose; an inherited `WRANGLER_AUTH_URL` would point the sign-in
 *      browser window at an attacker's host.
 *
 * Dotenv auto-loading is disabled here too, but the primary defence is that
 * Wrangler runs in a Nimbalyst-owned directory outside any workspace, so there
 * is no `.env` next to it to load in the first place. See `wranglerPaths.ts`.
 */

/** Variables that carry, or redirect, authentication material. */
export const CREDENTIAL_ENV_VARS = [
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_API_KEY",
  "CLOUDFLARE_EMAIL",
  "CLOUDFLARE_CF_AUTH",
  "WRANGLER_CF_AUTHORIZATION_TOKEN",
  "WRANGLER_R2_SQL_AUTH_TOKEN",
  "CLOUDFLARE_ACCESS_CLIENT_ID",
  "CLOUDFLARE_ACCESS_CLIENT_SECRET",
  "CF_PAGES_UPLOAD_JWT",
  // Not read by wrangler 4.125.0, but common in older tooling and shell
  // profiles. Cheap to strip; expensive to discover we needed to.
  "CF_API_TOKEN",
  "CF_API_KEY",
  "CF_EMAIL",
] as const;

/**
 * Variables that would choose an account, environment, or endpoint on the
 * user's behalf. Every one of these must come from an explicit argument.
 */
export const IMPLICIT_SELECTION_ENV_VARS = [
  "CLOUDFLARE_ACCOUNT_ID",
  "CF_ACCOUNT_ID",
  "CLOUDFLARE_ENV",
  "CLOUDFLARE_API_BASE_URL",
  "CF_API_BASE_URL",
  "CLOUDFLARE_COMPLIANCE_REGION",
  "CLOUDFLARE_CLIENT_ID",
  "CLOUDFLARE_INCLUDE_PROCESS_ENV",
  "CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV",
  "WRANGLER_API_ENVIRONMENT",
  "WRANGLER_AUTH_DOMAIN",
  "WRANGLER_AUTH_URL",
  "WRANGLER_TOKEN_URL",
  "WRANGLER_REVOKE_URL",
  "WRANGLER_CLIENT_ID",
  "WRANGLER_CI_OVERRIDE_NAME",
  "WRANGLER_CI_MATCH_TAG",
  "WRANGLER_CI_OVERRIDE_NETWORK_MODE_HOST",
] as const;

const STRIPPED = new Set<string>(
  [...CREDENTIAL_ENV_VARS, ...IMPLICIT_SELECTION_ENV_VARS].map((name) =>
    name.toLowerCase()
  )
);

/** True when `name` is removed from every Wrangler subprocess environment. */
export function isStrippedWranglerEnvVar(name: string): boolean {
  return STRIPPED.has(name.toLowerCase());
}

/**
 * Build the environment for a Wrangler subprocess.
 *
 * Matching is case-insensitive because Windows environment variables are, so
 * `Cloudflare_Api_Token` has to go the same way as `CLOUDFLARE_API_TOKEN`.
 *
 * @throws if an override would reintroduce a stripped variable. That is always
 * a programming error, and failing loudly beats silently handing Wrangler a
 * credential we promised the user we would never touch.
 */
export function sanitizeWranglerEnv(
  base: NodeJS.ProcessEnv,
  overrides: Record<string, string> = {}
): Record<string, string> {
  for (const name of Object.keys(overrides)) {
    if (isStrippedWranglerEnvVar(name)) {
      throw new Error(
        `Refusing to set ${name} for a Wrangler subprocess: Nimbalyst never supplies Cloudflare credentials or account selection through the environment.`
      );
    }
  }

  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (isStrippedWranglerEnvVar(name)) continue;
    result[name] = value;
  }

  return { ...result, ...overrides };
}
