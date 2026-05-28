/**
 * Backend Module Allowlist
 *
 * Decides whether a given extension is allowed to declare `backendModules` at
 * load time. Any extension that does not pass this check has its
 * `contributions.backendModules` stripped before the manifest reaches the
 * privileged host -- so no consent prompt is offered and no module can start,
 * regardless of what the manifest claims.
 *
 * Why this gate exists
 * --------------------
 * A backend module runs native code in a privileged Node runtime. Once it is
 * granted, it has ambient access to `fs`, `child_process`, `net`, etc. Those
 * capabilities cannot be sandboxed away in-process. The granular catalog
 * permissions only gate host-brokered RPC; they do NOT constrain what raw
 * Node APIs the module can call.
 *
 * So the meaningful security control is "who is allowed to ship one in the
 * first place." This file is that control.
 *
 * Policy
 * ------
 *   - Built-in extensions (bundled in the app's resources/extensions dir or
 *     the in-repo packages/extensions dir) are allowed unconditionally. They
 *     ship with the app and are reviewed by core before release.
 *
 *   - Extensions whose id is in `MARKETPLACE_ALLOWLIST` below are allowed.
 *     This list is reviewed in PRs; adding an id is an explicit decision.
 *
 *   - Symlinked user extensions (created via `extensions:dev-install` for
 *     local development) are allowed ONLY when the env var
 *     `NIMBALYST_ALLOW_DEV_BACKEND_MODULES=1` is set, AND the app is running
 *     in development mode (not a packaged build). This lets extension
 *     authors iterate without accidentally enabling the same path in
 *     packaged shipping builds for end users.
 *
 *   - Everything else (non-symlinked user-installed extensions not on the
 *     marketplace allowlist) is REFUSED. The extension still loads; the
 *     `backendModules` contribution is silently dropped and a structured
 *     error is logged so the author can debug.
 */

import { app } from 'electron';

/**
 * Marketplace extensions that have been reviewed and approved to ship a
 * backend module. Adding an id here means: we've read the extension's source,
 * we believe its declared purpose, and we're willing to surface its consent
 * prompt to users who install it.
 *
 * Keep this list small. If a marketplace extension only needs renderer-side
 * features, do not allowlist it -- contribute those features via the panel
 * SDK instead.
 */
const MARKETPLACE_ALLOWLIST: ReadonlySet<string> = new Set<string>([
  // Reserved. Add reviewed marketplace extension ids here.
]);

export type BackendModuleAllowReason =
  | 'builtin'
  | 'marketplace-allowlist'
  | 'dev-symlink';

export type BackendModuleDenyReason =
  | 'not-on-marketplace-allowlist'
  | 'dev-symlink-flag-not-set'
  | 'dev-symlink-in-packaged-build';

export type BackendModuleAllowResult =
  | { allowed: true; reason: BackendModuleAllowReason }
  | { allowed: false; reason: BackendModuleDenyReason; detail?: string };

export interface BackendModuleAllowInputs {
  extensionId: string;
  /** True if discovered under the built-in extensions directory. */
  isBuiltin: boolean;
  /**
   * True if the extension entry is a symlink (e.g., dev-installed). Symlinks
   * are how local extension development is wired up; allow them only under
   * the dev opt-in.
   */
  isSymlink: boolean;
}

/**
 * Pure decision function -- no IO, no logging. The caller drops backendModules
 * from the manifest when `allowed` is false and logs the structured reason.
 */
export function isAllowedToContributeBackendModules(
  inputs: BackendModuleAllowInputs
): BackendModuleAllowResult {
  if (inputs.isBuiltin) {
    return { allowed: true, reason: 'builtin' };
  }
  if (MARKETPLACE_ALLOWLIST.has(inputs.extensionId)) {
    return { allowed: true, reason: 'marketplace-allowlist' };
  }
  if (inputs.isSymlink) {
    if (app.isPackaged) {
      return {
        allowed: false,
        reason: 'dev-symlink-in-packaged-build',
        detail:
          'Dev-installed extensions cannot contribute backend modules in a packaged build. ' +
          'Run a dev build of Nimbalyst to test, then submit the extension for marketplace review.',
      };
    }
    if (process.env.NIMBALYST_ALLOW_DEV_BACKEND_MODULES !== '1') {
      return {
        allowed: false,
        reason: 'dev-symlink-flag-not-set',
        detail:
          'Set NIMBALYST_ALLOW_DEV_BACKEND_MODULES=1 to enable backend modules for dev-installed extensions.',
      };
    }
    return { allowed: true, reason: 'dev-symlink' };
  }
  return {
    allowed: false,
    reason: 'not-on-marketplace-allowlist',
    detail:
      'User-installed extensions must be on the marketplace allowlist to contribute backend modules. ' +
      'Contact Nimbalyst core to request review.',
  };
}
