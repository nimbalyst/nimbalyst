/**
 * Backend Module Provenance
 *
 * Classifies whether an extension is built-in or user-installed. This is NOT a
 * gate: any extension may declare `backendModules`. Installing an extension and
 * consenting to its first-use native-code prompt IS the trust decision -- the
 * same model other extensible developer tools use. The single control on
 * whether a backend module actually runs is that consent prompt (raised in
 * `PrivilegedExtensionHost.runStartAttempt`), not where the extension came
 * from.
 *
 * Why there is no provenance gate
 * -------------------------------
 * A backend module runs native code in a privileged Node runtime with ambient
 * access to `fs`, `child_process`, `net`, etc. That capability cannot be
 * sandboxed away in-process, so it can only be granted wholesale. Refusing to
 * even offer the consent prompt to a user-installed extension would just stop
 * the user from running code they chose to install -- it does not make the
 * capability any safer. So the decision is handed to the user, explicitly, via
 * the consent prompt. Malformed `backendModules` are still stripped by shape
 * validation (`validateBackendModules`); that is a correctness check, not a
 * security gate.
 *
 * Built-in extensions ship inside the app bundle (same trust domain as the app
 * itself), so callers auto-grant them and skip the prompt. That is the only
 * behavioral use of this classification.
 */

export type BackendModuleAllowReason = 'builtin' | 'user-installed';

export type BackendModuleAllowResult = { allowed: true; reason: BackendModuleAllowReason };

export interface BackendModuleAllowInputs {
  extensionId: string;
  /** True if discovered under the built-in extensions directory. */
  isBuiltin: boolean;
  /** True if the extension entry is a symlink (e.g., dev-installed). */
  isSymlink: boolean;
}

/**
 * Pure classification -- no IO, no logging, never refuses. Returns whether the
 * extension is built-in (auto-granted) or user-installed (consent prompt).
 */
export function isAllowedToContributeBackendModules(
  inputs: BackendModuleAllowInputs
): BackendModuleAllowResult {
  return {
    allowed: true,
    reason: inputs.isBuiltin ? 'builtin' : 'user-installed',
  };
}
