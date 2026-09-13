/**
 * Wrangler auth profiles and the accounts each one can reach.
 *
 * The command surface is narrower than it looks, and the shape of this module
 * is dictated by three facts verified against the installed Wrangler 4.125.0:
 *
 *   1. **`whoami` rejects `--profile`.** It "only works on the currently active
 *      profile". Identity and accounts can therefore only be read by running
 *      `whoami --json` from a directory that resolves to the profile you mean.
 *   2. **`login` rejects `--profile` too**, and `auth create` refuses the
 *      reserved names `default` and `staging`. So re-authenticating the default
 *      profile is a bare `wrangler login`, and creating a named one is
 *      `wrangler auth create <name>`. They are different commands, not one
 *      command with a flag.
 *   3. **There is no `auth current`.** The only way to know which profile a
 *      directory resolves to is `auth list`'s binding map, replicated in
 *      `profileBindings.ts`.
 *
 * Every profile-scoped read therefore runs in a Nimbalyst-owned directory whose
 * resolution has been checked first. Named profiles get that directory bound
 * with `auth activate`; the default profile cannot be bound at all, so its
 * directory must be verified to have no binding above it.
 */

import * as fs from "fs/promises";

import type {
  CloudflareAccount,
  WranglerProfile,
} from "../../../shared/cloudflareSandbox";
import { SandboxOperationError } from "./errors";
import {
  assertResolvesTo,
  isReservedProfileName,
  parseAuthListTable,
  type ProfileBinding,
  resolveProfileForDirectory,
} from "./profileBindings";
import { runWrangler, stripAnsi } from "./wranglerCli";
import { getProfileWorkingDir, isValidProfileName } from "./wranglerPaths";

export interface WhoamiResult {
  email: string | null;
  accounts: CloudflareAccount[];
}

/** The login/logout-managed profile. Cannot be created or bound. */
export const DEFAULT_PROFILE = "default";

/**
 * Parse `wrangler whoami --json`, which prints
 * `{loggedIn, authType, email, accounts, tokenPermissions}`.
 *
 * Account entries carry more than id and name (`type`, `settings`,
 * `legacy_flags`, `created_on` were present on a live probe); everything except
 * id and name is dropped rather than passed toward the renderer.
 */
export function parseWhoamiJson(output: string): WhoamiResult {
  const clean = stripAnsi(output).trim();
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new SandboxOperationError("not-authenticated", "whoami");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(clean.slice(start, end + 1));
  } catch {
    throw new SandboxOperationError("unknown", "whoami-parse");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new SandboxOperationError("unknown", "whoami-parse");
  }

  const record = parsed as Record<string, unknown>;
  if (record.loggedIn === false) {
    throw new SandboxOperationError("not-authenticated", "whoami");
  }

  const accounts: CloudflareAccount[] = [];
  if (Array.isArray(record.accounts)) {
    for (const entry of record.accounts) {
      if (typeof entry !== "object" || entry === null) continue;
      const account = entry as Record<string, unknown>;
      const id = account.id ?? account.account_id;
      const name = account.name ?? account.account_name;
      if (typeof id === "string" && id && typeof name === "string") {
        accounts.push({ id, name });
      }
    }
  }

  const email =
    typeof record.email === "string" && record.email ? record.email : null;
  return { email, accounts };
}

/** Names and bound directories. The only command that enumerates profiles. */
export async function listProfileBindings(): Promise<ProfileBinding[]> {
  const { stdout } = await runWrangler(["auth", "list"]);
  return parseAuthListTable(stdout);
}

/**
 * A Nimbalyst-owned directory that provably resolves to `profileName`.
 *
 * For a named profile this binds the directory if it is not already bound —
 * including for profiles that existed before Nimbalyst saw them, which is why
 * the bind is not limited to profile creation. For the default profile there is
 * nothing to bind, so resolution is verified and refused if some ancestor
 * directory binds a different profile.
 */
let bindingQueue: Promise<unknown> = Promise.resolve();

export function resolvedProfileDir(
  profileName: string,
  bindings?: ProfileBinding[]
): Promise<string> {
  // `auth activate` rewrites Wrangler's shared binding map. Two windows must
  // not launch simultaneous read/modify/write commands and lose a binding.
  const result = bindingQueue.then(() =>
    resolveProfileDirUnlocked(profileName, bindings)
  );
  bindingQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

async function resolveProfileDirUnlocked(
  profileName: string,
  bindings?: ProfileBinding[]
): Promise<string> {
  assertProfileName(profileName);
  const dir = getProfileWorkingDir(profileName);
  await fs.mkdir(dir, { recursive: true });

  let current = bindings ?? (await listProfileBindings());

  if (profileName !== DEFAULT_PROFILE) {
    // Bind on demand, including for profiles that existed before Nimbalyst saw
    // them. Without a binding this directory would resolve to `default`.
    if (resolveProfileForDirectory(dir, current).profile !== profileName) {
      await runWrangler(["auth", "activate", profileName, dir], { cwd: dir });
      current = await listProfileBindings();
    }
  }

  // Fail closed. For `default` this is the whole guard: it can never be bound
  // (`auth activate default` is refused as a reserved name), so it is only
  // reachable from a directory that nothing above it binds. If some ancestor
  // does, running here would silently authenticate as that other profile.
  assertResolvesTo(dir, profileName, current);
  return dir;
}

/**
 * Identity and accounts for one profile.
 *
 * Runs `whoami --json` with NO `--profile` flag, from the profile's verified
 * directory. Passing the flag is a hard CLI error, not a fallback.
 */
export async function whoami(
  profileName: string,
  bindings?: ProfileBinding[]
): Promise<WhoamiResult> {
  const cwd = await resolvedProfileDir(profileName, bindings);
  const { stdout } = await runWrangler(["whoami", "--json"], { cwd });
  return parseWhoamiJson(stdout);
}

/** Full profile list, including the default profile when it is signed in. */
export async function listProfiles(): Promise<WranglerProfile[]> {
  const bindings = await listProfileBindings();
  const names = new Set(bindings.map((binding) => binding.name));
  // `auth list` only reports profiles with a config file. The default profile
  // is managed by login/logout and may be signed in without appearing there,
  // so it is probed unconditionally and dropped if it is not authenticated.
  names.add(DEFAULT_PROFILE);

  const profiles = await Promise.all(
    [...names].map(async (name) => {
      const boundDirectories =
        bindings.find((binding) => binding.name === name)?.boundDirectories ??
        [];
      try {
        const info = await whoami(name, bindings);
        return {
          name,
          identity: info.email,
          authenticated: true,
          boundDirectories,
        } satisfies WranglerProfile;
      } catch {
        return {
          name,
          identity: null,
          authenticated: false,
          boundDirectories,
        } satisfies WranglerProfile;
      }
    })
  );

  return profiles.filter(
    (profile) => profile.name !== DEFAULT_PROFILE || profile.authenticated
  );
}

/**
 * Sign in, either creating/re-authenticating a named profile or refreshing the
 * default one. The only place Nimbalyst causes a sign-in, and only ever from an
 * explicit click in the settings panel.
 */
export async function createOrReauthenticateProfile(
  name: string,
  reauthenticate: boolean
): Promise<WranglerProfile> {
  assertProfileName(name);

  const existing = await listProfileBindings();
  const alreadyExists =
    name === DEFAULT_PROFILE ||
    existing.some((binding) => binding.name === name);
  if (alreadyExists && !reauthenticate) {
    throw new SandboxOperationError("profile-exists", "auth-create");
  }

  if (isReservedProfileName(name)) {
    if (name !== DEFAULT_PROFILE) {
      // `staging` is reserved by Wrangler but is not the login-managed profile,
      // so there is no command that could sign it in.
      throw new SandboxOperationError("unknown", "reserved-profile");
    }
    // `auth create default` is refused by validateProfileName; the default
    // profile is the one `login` manages, and login rejects `--profile`.
    await runWrangler(["login"], { interactive: true });
  } else {
    await runWrangler(["auth", "create", name], { interactive: true });
  }

  const bindings = await listProfileBindings();
  const info = await whoami(name, bindings);
  return {
    name,
    identity: info.email,
    authenticated: true,
    boundDirectories:
      (await listProfileBindings()).find((binding) => binding.name === name)
        ?.boundDirectories ?? [],
  };
}

/** Accounts reachable by a profile. Never guesses when there is exactly one. */
export async function listAccounts(
  profileName: string
): Promise<CloudflareAccount[]> {
  return (await whoami(profileName)).accounts;
}

function assertProfileName(name: string): void {
  if (!isValidProfileName(name)) {
    throw new SandboxOperationError("unknown", "invalid-profile-name");
  }
}
