/**
 * Filesystem locations for the Wrangler subprocesses Nimbalyst spawns.
 *
 * Two properties matter and both come from the working directory:
 *
 * 1. **No `.env` pickup.** Wrangler loads dotenv files relative to its working
 *    directory. Running it inside a user workspace would let a repository's
 *    `.env` inject `CLOUDFLARE_API_TOKEN` even though we scrubbed the inherited
 *    environment. Everything therefore runs in a Nimbalyst-owned directory
 *    under `userData`, which never contains a `.env`.
 *
 * 2. **Profile resolution for remote bindings.** `--profile` is honoured by the
 *    top-level CLI, but the remote-bindings auth path resolves its profile from
 *    `process.cwd()` alone: `getRemoteBindingsAuthHook()` calls
 *    `profileStore.resolve({ cwd: profileDir ?? process.cwd() })`, and
 *    `profileDir` is never assigned anywhere in the wrangler 4.125.0 bundle. So
 *    the control helper only reaches the right account if it is *spawned* in a
 *    directory bound to the profile via `wrangler auth activate`. Each profile
 *    gets its own subdirectory here for exactly that binding.
 */

import * as path from "path";
import { createHash } from "crypto";
import { app } from "electron";

/** Root for all Cloudflare sandbox scratch state. Created lazily by callers. */
export function getCloudflareSandboxRoot(): string {
  return path.join(app.getPath("userData"), "cloudflare-sandbox");
}

/**
 * Working directory for commands that are not profile-scoped (version probe,
 * `auth list`). Deliberately not bound to any profile.
 */
export function getNeutralWorkingDir(): string {
  return path.join(getCloudflareSandboxRoot(), "cli");
}

/**
 * Per-profile working directory. `wrangler auth activate <profile> <dir>` binds
 * the profile here so remote-binding auth resolves correctly from cwd.
 *
 * Profile names are validated by {@link isValidProfileName} before reaching
 * this function, so the join cannot escape the root.
 */
export function getProfileWorkingDir(profileName: string): string {
  if (!isValidProfileName(profileName)) {
    throw new Error(`Invalid Wrangler profile name: ${profileName}`);
  }
  // Wrangler names are case-sensitive; macOS/Windows directories commonly are
  // not. A digest prevents `Work` and `work` from sharing an auth-bound cwd.
  const suffix = createHash("sha256")
    .update(profileName)
    .digest("hex")
    .slice(0, 16);
  return path.join(
    getCloudflareSandboxRoot(),
    "profiles",
    `${profileName}-${suffix}`
  );
}

/** Directory holding the generated deployable Wrangler project. */
export function getArtifactDir(): string {
  return path.join(getCloudflareSandboxRoot(), "artifact");
}

/**
 * Wrangler's own rule, copied from `validateProfileName` in the CLI bundle:
 * alphanumerics, hyphens and underscores only. `default` is reserved there for
 * the login/logout-managed profile. It remains a valid read target here;
 * the caller uses plain `login` when re-authentication is requested. Also reject
 * a leading hyphen so a profile cannot be interpreted as a CLI flag.
 */
const PROFILE_NAME_PATTERN = /^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/;

export function isValidProfileName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    PROFILE_NAME_PATTERN.test(name)
  );
}
