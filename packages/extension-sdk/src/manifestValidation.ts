/**
 * Pure (no Node/Electron deps) validation helpers for manifest fields.
 *
 * Runs at both build time (via validate.ts, which reads manifest.json from
 * disk) and runtime (when the host loads an extension and needs to refuse
 * invalid contributions). Keep this file dependency-free so it can be bundled
 * into either context without dragging in fs/path.
 */

import { MAX_BACKEND_MODULES_PER_EXTENSION } from './types/extension.js';
import type {
  BackendModuleContribution,
  BackendModuleRuntime,
  ExtensionPermissionId,
} from './types/permissions.js';

/**
 * Mirrors the host's permission registry. We duplicate the list here so
 * extensions don't have to depend on Electron internals to validate locally.
 * Adding a new id requires updating both this list AND
 * `packages/electron/src/main/extensions/permissionRegistry.ts`.
 */
const KNOWN_PERMISSION_IDS: readonly ExtensionPermissionId[] = [
  'workspace-files',
  'nimbalyst-database-read',
  'nimbalyst-database-write',
  'secrets-read',
  'mcp-server-register',
];

/**
 * Permission ids that used to be in the catalog but never enforced anything
 * meaningful at the backend boundary (ambient Node capabilities). Manifests
 * that still reference them are accepted -- the validator silently drops the
 * id from the effective list -- so we don't break older extensions during
 * the catalog cleanup. Authors get a non-fatal warning issue back.
 */
const DEPRECATED_PERMISSION_IDS: readonly string[] = [
  'spawn-process',
  'network-loopback',
  'network-internet',
  'filesystem',
];

const KNOWN_RUNTIMES: readonly BackendModuleRuntime[] = [
  'utility-process',
  'worker-thread',
];

const BACKEND_MODULE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export interface BackendModuleValidationIssue {
  /** The module being validated, or undefined for whole-extension issues */
  moduleId?: string;
  message: string;
  /**
   * Non-fatal issues (e.g., a deprecated permission id that the validator
   * silently drops) carry `severity: "warning"`. Callers that fail builds
   * on issues should ignore warnings.
   */
  severity?: 'error' | 'warning';
}

/**
 * Validate the `contributions.backendModules` array on a manifest.
 * Returns the list of problems found - empty means valid.
 *
 * Callers decide whether to treat issues as fatal (host loader: refuse the
 * extension) or as warnings (build-time validator: print and continue with
 * non-zero exit).
 */
export function validateBackendModules(
  backendModules: unknown
): BackendModuleValidationIssue[] {
  if (backendModules === undefined) {
    return [];
  }
  if (!Array.isArray(backendModules)) {
    return [{ message: 'contributions.backendModules must be an array' }];
  }

  const issues: BackendModuleValidationIssue[] = [];

  if (backendModules.length > MAX_BACKEND_MODULES_PER_EXTENSION) {
    issues.push({
      message:
        `contributions.backendModules declares ${backendModules.length} modules; ` +
        `the maximum is ${MAX_BACKEND_MODULES_PER_EXTENSION}. ` +
        'Consolidate modules to keep the consent prompt manageable.',
    });
  }

  const seenIds = new Set<string>();
  for (let i = 0; i < backendModules.length; i += 1) {
    const raw = backendModules[i];
    if (!raw || typeof raw !== 'object') {
      issues.push({ message: `backendModules[${i}] must be an object` });
      continue;
    }
    const module = raw as Partial<BackendModuleContribution> & Record<string, unknown>;
    const moduleLabel = typeof module.id === 'string' ? module.id : `index ${i}`;

    if (typeof module.id !== 'string' || !BACKEND_MODULE_ID_PATTERN.test(module.id)) {
      issues.push({
        moduleId: typeof module.id === 'string' ? module.id : undefined,
        message:
          `backendModules[${moduleLabel}].id must be a lowercase string matching ` +
          `${BACKEND_MODULE_ID_PATTERN.source} (got ${JSON.stringify(module.id)})`,
      });
    } else if (seenIds.has(module.id)) {
      issues.push({
        moduleId: module.id,
        message: `backendModules contains duplicate id "${module.id}"`,
      });
    } else {
      seenIds.add(module.id);
    }

    if (typeof module.entry !== 'string' || module.entry.length === 0) {
      issues.push({
        moduleId: typeof module.id === 'string' ? module.id : undefined,
        message: `backendModules[${moduleLabel}].entry must be a non-empty relative path string`,
      });
    } else if (module.entry.startsWith('/') || module.entry.includes('..')) {
      // Refuse absolute paths and parent-directory traversal so a module
      // can't escape its extension root. The host resolves entry relative
      // to the extension directory; only safe relative paths belong here.
      issues.push({
        moduleId: typeof module.id === 'string' ? module.id : undefined,
        message:
          `backendModules[${moduleLabel}].entry must be a relative path within the extension root ` +
          `(no leading "/", no ".." segments)`,
      });
    }

    if (!KNOWN_RUNTIMES.includes(module.runtime as BackendModuleRuntime)) {
      issues.push({
        moduleId: typeof module.id === 'string' ? module.id : undefined,
        message:
          `backendModules[${moduleLabel}].runtime must be one of: ${KNOWN_RUNTIMES.join(', ')} ` +
          `(got ${JSON.stringify(module.runtime)})`,
      });
    }

    if (module.permissions !== undefined && !Array.isArray(module.permissions)) {
      issues.push({
        moduleId: typeof module.id === 'string' ? module.id : undefined,
        message:
          `backendModules[${moduleLabel}].permissions must be an array of ` +
          `host-brokered capability ids (or omitted). The implicit "run native ` +
          `code" grant is conferred by enabling the module itself, not by an ` +
          `entry in this array.`,
      });
    } else if (Array.isArray(module.permissions)) {
      const uniquePermissions = new Set<string>();
      for (const permission of module.permissions as unknown[]) {
        if (typeof permission !== 'string') {
          issues.push({
            moduleId: typeof module.id === 'string' ? module.id : undefined,
            message: `backendModules[${moduleLabel}].permissions contains non-string entry`,
          });
          continue;
        }
        if (DEPRECATED_PERMISSION_IDS.includes(permission)) {
          // Older manifests still ship these. They never meaningfully gated
          // anything inside the backend runtime (ambient Node access), and
          // the catalog cleanup removed them. Warn the author and silently
          // drop the id from the effective list.
          issues.push({
            severity: 'warning',
            moduleId: typeof module.id === 'string' ? module.id : undefined,
            message:
              `backendModules[${moduleLabel}].permissions includes deprecated id "${permission}". ` +
              `This id is unenforceable inside a Node backend (the module can require child_process/fs/net ` +
              `directly) and has been removed from the catalog. Granting the module is itself the consent ` +
              `to run native code; drop this id from your manifest.`,
          });
          continue;
        }
        if (!KNOWN_PERMISSION_IDS.includes(permission as ExtensionPermissionId)) {
          issues.push({
            moduleId: typeof module.id === 'string' ? module.id : undefined,
            message:
              `backendModules[${moduleLabel}].permissions contains unknown id "${permission}". ` +
              `Valid ids: ${KNOWN_PERMISSION_IDS.join(', ')}`,
          });
        }
        if (uniquePermissions.has(permission)) {
          issues.push({
            moduleId: typeof module.id === 'string' ? module.id : undefined,
            message: `backendModules[${moduleLabel}].permissions contains duplicate "${permission}"`,
          });
        }
        uniquePermissions.add(permission);
      }
    }

    const enablement = module.enablement as Partial<BackendModuleContribution['enablement']> | undefined;
    if (!enablement || typeof enablement !== 'object') {
      issues.push({
        moduleId: typeof module.id === 'string' ? module.id : undefined,
        message: `backendModules[${moduleLabel}].enablement is required`,
      });
    } else {
      if (enablement.default !== 'disabled') {
        issues.push({
          moduleId: typeof module.id === 'string' ? module.id : undefined,
          message:
            `backendModules[${moduleLabel}].enablement.default must be "disabled". ` +
            'Privileged capabilities are always opt-in.',
        });
      }
      if (enablement.promptOn !== 'firstUse') {
        issues.push({
          moduleId: typeof module.id === 'string' ? module.id : undefined,
          message: `backendModules[${moduleLabel}].enablement.promptOn must be "firstUse"`,
        });
      }
      if (typeof enablement.purpose !== 'string' || enablement.purpose.trim().length === 0) {
        issues.push({
          moduleId: typeof module.id === 'string' ? module.id : undefined,
          message:
            `backendModules[${moduleLabel}].enablement.purpose must be a non-empty string. ` +
            'This is shown verbatim in the consent prompt - write it from the user\'s perspective.',
        });
      } else if (enablement.purpose.length > 280) {
        issues.push({
          moduleId: typeof module.id === 'string' ? module.id : undefined,
          message:
            `backendModules[${moduleLabel}].enablement.purpose is too long (${enablement.purpose.length} chars). ` +
            'Keep it under 280 characters; long copy doesn\'t fit the consent prompt.',
        });
      }
    }
  }

  return issues;
}

/**
 * Convenience wrapper that throws if any fatal issues are found. Warnings
 * (currently: deprecated permission ids) are surfaced via the issues array
 * but never throw, so an extension that still references `spawn-process`
 * keeps loading -- the host just drops the id when computing effective
 * permissions.
 *
 * Use this in main-process load paths where invalid manifests should refuse
 * the extension outright.
 */
export function assertBackendModulesValid(
  extensionId: string,
  backendModules: unknown
): void {
  const issues = validateBackendModules(backendModules);
  const fatal = issues.filter((i) => i.severity !== 'warning');
  if (fatal.length === 0) {
    return;
  }
  const lines = fatal.map((i) =>
    i.moduleId ? `  - [${i.moduleId}] ${i.message}` : `  - ${i.message}`
  );
  throw new Error(
    `Extension ${extensionId} has invalid backendModules declarations:\n${lines.join('\n')}`
  );
}

/**
 * Filter a raw `permissions` array on a backend-module contribution down to
 * the ids the host actually understands. Deprecated catalog ids
 * (`spawn-process`, `network-loopback`, `network-internet`, `filesystem`)
 * are dropped silently -- they never gated anything inside the backend
 * runtime, so the host treats them as no-ops. Unknown ids are also dropped;
 * `validateBackendModules` raises a separate error for those, so the loader
 * will refuse the module before this is consulted in earnest.
 */
export function effectiveModulePermissions(
  raw: unknown
): ExtensionPermissionId[] {
  if (!Array.isArray(raw)) return [];
  const out: ExtensionPermissionId[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    if (seen.has(entry)) continue;
    seen.add(entry);
    if (KNOWN_PERMISSION_IDS.includes(entry as ExtensionPermissionId)) {
      out.push(entry as ExtensionPermissionId);
    }
  }
  return out;
}
