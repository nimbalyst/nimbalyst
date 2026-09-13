/**
 * Local setup check. Wrangler only.
 *
 * There is deliberately no container-runtime probe. The deployable image is a
 * pre-built registry reference, and Cloudflare pulls it server-side, so a local
 * container runtime is not part of a user's setup.
 *
 * `supportsProfiles` is a real capability gate, not a version comparison for
 * its own sake: named auth profiles are what make per-account, no-token SSO
 * possible, and they are experimental in the Wrangler versions that have them.
 */

import type {
  CloudflareSandboxPrerequisites,
  WranglerPrerequisite,
} from "../../../shared/cloudflareSandbox";
import { runWrangler, stripAnsi } from "./wranglerCli";

/** First Wrangler release carrying `auth create` / `auth list`. */
export const MIN_PROFILE_WRANGLER_VERSION = [4, 125, 0] as const;

/** Extract a semver-ish triple from `wrangler --version` output. */
export function parseWranglerVersion(output: string): string | null {
  const match = stripAnsi(output).match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

/** True when `version` is at or above the profile-capable floor. */
export function supportsAuthProfiles(version: string | null): boolean {
  if (!version) return false;
  const parts = version.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 3 || parts.some(Number.isNaN)) return false;

  for (let index = 0; index < 3; index += 1) {
    const actual = parts[index] as number;
    const required = MIN_PROFILE_WRANGLER_VERSION[index];
    if (actual > required) return true;
    if (actual < required) return false;
  }
  return true;
}

export async function getPrerequisites(): Promise<CloudflareSandboxPrerequisites> {
  const wrangler = await probeWrangler();
  return {
    wrangler,
    ready: wrangler.installed && wrangler.supportsProfiles,
  };
}

async function probeWrangler(): Promise<WranglerPrerequisite> {
  try {
    const { stdout } = await runWrangler(["--version"], { timeoutMs: 15_000 });
    const version = parseWranglerVersion(stdout);
    return {
      installed: true,
      version,
      supportsProfiles: supportsAuthProfiles(version),
    };
  } catch {
    // Absent, unreadable, or too old to run at all. All three are "not usable
    // yet" from the user's side, and the panel's next step is the same.
    return { installed: false, version: null, supportsProfiles: false };
  }
}
