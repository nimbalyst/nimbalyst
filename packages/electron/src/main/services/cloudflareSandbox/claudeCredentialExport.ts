/**
 * Reading this machine's Claude Code subscription credential so it can be
 * copied into the sandbox.
 *
 * The sandbox runs the real Claude Code agent, and the only way it can use the
 * user's subscription is to hold the same OAuth credential file the CLI writes
 * locally. `CLAUDE_CODE_OAUTH_TOKEN` is stripped from the container's
 * environment, so the file is the route.
 *
 * Rules this module exists to keep:
 *
 *  - **Read-only, and only from where the CLI actually put it.** On macOS that
 *    is the Keychain, whose entry name depends on `CLAUDE_CONFIG_DIR`; reading
 *    the unscoped name under an override returns a different account's
 *    credential (#975). `resolveClaudeKeychainServiceNames` owns that cascade.
 *  - **Never `process.env` as a credential source.** This reads what the Claude
 *    CLI stored, never an API key a user happened to export for something else.
 *    See the CLAUDE.md rule and the $100 incident behind it.
 *  - **Nothing is logged and nothing is cached.** The bytes are returned to the
 *    caller, handed to the provisioner, and dropped. They are never written to
 *    disk on the desktop and never included in an error.
 *  - **Passed through verbatim.** The container's CLI parses this file itself;
 *    re-serializing it here would silently drop any field this codebase does
 *    not happen to know about.
 */

import { execFile } from "child_process";
import { readFile } from "fs/promises";

import {
  resolveClaudeCredentialsPath,
  type ClaudeConfigEnv,
} from "@nimbalyst/runtime/ai/server/providers/claudeCode/claudeConfigDir";
import { resolveClaudeKeychainServiceNames } from "@nimbalyst/runtime/ai/server/providers/claudeCode/claudeKeychain";

import { SandboxOperationError } from "./errors";

const SIGN_IN_MESSAGE =
  "Nimbalyst could not find a Claude Code subscription login on this Mac, so the sandbox has nothing to run the agent with. Sign in to Claude Code here first, then connect the node again.";

/** Injection seam. Deliberately not `promisify(execFile)`: `promisify.custom`
 * resolves against the real implementation and would slip past a test's spy,
 * making a "no keychain read happened" assertion silently pass. */
export type SecurityRunner = (args: string[]) => Promise<string>;

export interface ClaudeCredentialExportDeps {
  env?: ClaudeConfigEnv;
  platform?: NodeJS.Platform;
  runSecurity?: SecurityRunner;
  readCredentialsFile?: (path: string) => Promise<string>;
}

/**
 * The credential file's contents, exactly as they should land in the container
 * at `/home/nimbalyst/.claude/.credentials.json`.
 *
 * Throws rather than returning null: a sandbox with no credential cannot run a
 * turn, and provisioning one anyway would produce a node that fails on its
 * first prompt with a 401 the user has no way to explain.
 */
export async function exportClaudeCredential(
  deps: ClaudeCredentialExportDeps = {},
): Promise<string> {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const runSecurity = deps.runSecurity ?? runSecurityCommand;
  const readCredentialsFile = deps.readCredentialsFile ?? ((path) => readFile(path, "utf8"));

  if (platform === "darwin") {
    for (const serviceName of resolveClaudeKeychainServiceNames(env)) {
      let raw: string;
      try {
        raw = await runSecurity(["find-generic-password", "-s", serviceName, "-w"]);
      } catch {
        // "not found" is the ordinary answer for every entry but one, so a
        // failure here moves to the next name rather than ending the search.
        continue;
      }
      const credential = usableCredential(raw);
      if (credential) return credential;
    }
    // Secure storage is unavailable in some setups (headless, SSH), and the CLI
    // falls back to a plain file there. Keep looking before giving up.
  }

  try {
    const credential = usableCredential(await readCredentialsFile(resolveClaudeCredentialsPath(env)));
    if (credential) return credential;
  } catch {
    // Fall through to the single curated failure below. The underlying error
    // names a path, and a path is the least useful half of the answer.
  }

  throw new SandboxOperationError("not-authenticated", "claude-credential-missing", SIGN_IN_MESSAGE);
}

/**
 * Accept the payload only if it is JSON carrying a non-empty OAuth access
 * token. A stale Keychain entry holding `{}` is worse than a miss: it would be
 * copied into the sandbox and fail there, far from anything the user can see.
 */
function usableCredential(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as { claudeAiOauth?: { accessToken?: unknown } };
    const token = parsed?.claudeAiOauth?.accessToken;
    if (typeof token !== "string" || token.length === 0) return null;
  } catch {
    return null;
  }
  return trimmed;
}

/**
 * `security` with an argv array, never a shell string: the service name comes
 * from a hash of a user-controlled config dir, and interpolating it into a
 * shell would put that under `sh -c`.
 */
function runSecurityCommand(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "security",
      args,
      { encoding: "utf8", timeout: 5000, maxBuffer: 256 * 1024 },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
}
