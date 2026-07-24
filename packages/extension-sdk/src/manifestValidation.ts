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
 * Manifest validation rejects extensions declaring more than this many AI
 * agent providers. Chosen by symmetry with
 * {@link MAX_BACKEND_MODULES_PER_EXTENSION}: an extension that ships more than
 * a handful of agent providers is almost certainly mis-modeled (split it into
 * multiple extensions, or surface them as models on one provider). The cap
 * also keeps the settings UI -- which lists each provider as its own row --
 * from running away.
 */
export const MAX_AGENT_PROVIDERS_PER_EXTENSION = 4;

const AGENT_PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

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

/**
 * Issue surface used by {@link validateAgentProviders}. Shaped to mirror
 * {@link BackendModuleValidationIssue} so callers can pool the two streams
 * (build-time validator, runtime loader) through one error pipeline.
 */
export interface AgentProviderValidationIssue {
  /** The provider being validated, or undefined for whole-extension issues */
  providerId?: string;
  message: string;
  /**
   * Non-fatal issues carry `severity: "warning"`. Callers that fail builds
   * on issues should ignore warnings.
   */
  severity?: 'error' | 'warning';
}

/**
 * Extract the set of declared backend-module ids from a manifest's
 * `contributions.backendModules` array. Used by
 * {@link validateAgentProviders} so the `backendModuleId` cross-check does
 * not need the caller to pre-compute the set.
 *
 * Returns an empty set if `backendModules` is missing or malformed. Exported
 * so build tooling can reuse the same extraction logic when checking entry
 * files against the declared modules.
 */
export function extractBackendModuleIds(backendModules: unknown): Set<string> {
  const ids = new Set<string>();
  if (!Array.isArray(backendModules)) return ids;
  for (const raw of backendModules) {
    if (!raw || typeof raw !== 'object') continue;
    const id = (raw as { id?: unknown }).id;
    if (typeof id === 'string' && id.length > 0) {
      ids.add(id);
    }
  }
  return ids;
}

/**
 * Validate the `contributions.aiAgentProviders` array on a manifest.
 *
 * AI agent providers are surfaced in Nimbalyst's chat / agent UI as selectable
 * providers (alongside built-in Claude Code, Claude, OpenAI, etc.). Each
 * provider is implemented by a backend module that runs outside the renderer
 * (so it can drive a CLI, hold long-lived processes, or speak a custom
 * protocol). The contribution shape, in practice:
 *
 *   {
 *     id: string,                       // unique within the extension
 *     displayName: string,              // shown in the provider dropdown
 *     backendModuleId: string,          // must match a declared backendModule
 *     models?: Array<{ id, name, ... }> // models the provider advertises
 *     toolFileLinks?: { [toolName]: ... } // optional UI hint table
 *   }
 *
 * This validator checks the manifest-side wiring; it does not introspect the
 * bundle. See {@link validateExtensionBundle} (Node-only) for the bundle-side
 * check that the referenced backend module actually exports an
 * `activate`/`createAgentProvider` function.
 *
 * Returns the list of problems found - empty means valid.
 */
export function validateAgentProviders(
  aiAgentProviders: unknown,
  backendModules: unknown
): AgentProviderValidationIssue[] {
  if (aiAgentProviders === undefined) {
    return [];
  }
  if (!Array.isArray(aiAgentProviders)) {
    return [
      { message: 'contributions.aiAgentProviders must be an array' },
    ];
  }

  const issues: AgentProviderValidationIssue[] = [];

  if (aiAgentProviders.length > MAX_AGENT_PROVIDERS_PER_EXTENSION) {
    issues.push({
      message:
        `contributions.aiAgentProviders declares ${aiAgentProviders.length} providers; ` +
        `the maximum is ${MAX_AGENT_PROVIDERS_PER_EXTENSION}. ` +
        'Split into multiple extensions, or surface variants as models on a single provider.',
    });
  }

  const knownBackendModuleIds = extractBackendModuleIds(backendModules);
  const seenProviderIds = new Set<string>();

  for (let i = 0; i < aiAgentProviders.length; i += 1) {
    const raw = aiAgentProviders[i];
    if (!raw || typeof raw !== 'object') {
      issues.push({
        message: `aiAgentProviders[${i}] must be an object`,
      });
      continue;
    }
    const provider = raw as Record<string, unknown>;
    const providerLabel =
      typeof provider.id === 'string' && provider.id.length > 0
        ? provider.id
        : `index ${i}`;

    // (b) id presence + shape + uniqueness within the extension.
    if (
      typeof provider.id !== 'string' ||
      !AGENT_PROVIDER_ID_PATTERN.test(provider.id)
    ) {
      issues.push({
        providerId: typeof provider.id === 'string' ? provider.id : undefined,
        message:
          `aiAgentProviders[${providerLabel}].id must be a lowercase string matching ` +
          `${AGENT_PROVIDER_ID_PATTERN.source} (got ${JSON.stringify(provider.id)})`,
      });
    } else if (seenProviderIds.has(provider.id)) {
      issues.push({
        providerId: provider.id,
        message: `aiAgentProviders contains duplicate id "${provider.id}"`,
      });
    } else {
      seenProviderIds.add(provider.id);
    }

    // displayName: non-empty string. Surfaced verbatim in the provider
    // dropdown, so it has to be readable; not currently length-capped because
    // we have no signal yet on what the UI tolerates. Matches the
    // AiAgentProviderContribution type, which names this field `displayName`.
    if (typeof provider.displayName !== 'string' || provider.displayName.trim().length === 0) {
      issues.push({
        providerId:
          typeof provider.id === 'string' ? provider.id : undefined,
        message:
          `aiAgentProviders[${providerLabel}].displayName must be a non-empty string ` +
          '(shown verbatim in the provider dropdown).',
      });
    }

    // (a) backendModuleId must reference a real backendModules[*].id.
    if (
      typeof provider.backendModuleId !== 'string' ||
      provider.backendModuleId.length === 0
    ) {
      issues.push({
        providerId:
          typeof provider.id === 'string' ? provider.id : undefined,
        message:
          `aiAgentProviders[${providerLabel}].backendModuleId must be a non-empty string ` +
          'referencing a backendModules[*].id declared on the same manifest.',
      });
    } else if (!knownBackendModuleIds.has(provider.backendModuleId)) {
      issues.push({
        providerId:
          typeof provider.id === 'string' ? provider.id : undefined,
        message:
          `aiAgentProviders[${providerLabel}].backendModuleId "${provider.backendModuleId}" ` +
          'does not match any contributions.backendModules[*].id. ' +
          'Agent providers must be implemented by a declared backend module on the same extension.',
      });
    }

    // (c) models, if present, must be an array of { id, name }. These are
    // the only required fields on the AiAgentProviderModel type; the host
    // derives the provider from the contribution id, so models carry no
    // per-entry provider field.
    if (provider.models !== undefined) {
      if (!Array.isArray(provider.models)) {
        issues.push({
          providerId:
            typeof provider.id === 'string' ? provider.id : undefined,
          message:
            `aiAgentProviders[${providerLabel}].models must be an array (or omitted).`,
        });
      } else {
        const seenModelIds = new Set<string>();
        for (let m = 0; m < provider.models.length; m += 1) {
          const rawModel = provider.models[m];
          const modelLabel = `models[${m}]`;
          if (!rawModel || typeof rawModel !== 'object') {
            issues.push({
              providerId:
                typeof provider.id === 'string' ? provider.id : undefined,
              message:
                `aiAgentProviders[${providerLabel}].${modelLabel} must be an object`,
            });
            continue;
          }
          const model = rawModel as Record<string, unknown>;
          if (
            typeof model.id !== 'string' ||
            model.id.trim().length === 0
          ) {
            issues.push({
              providerId:
                typeof provider.id === 'string' ? provider.id : undefined,
              message:
                `aiAgentProviders[${providerLabel}].${modelLabel}.id must be a non-empty string`,
            });
          } else if (seenModelIds.has(model.id)) {
            issues.push({
              providerId:
                typeof provider.id === 'string' ? provider.id : undefined,
              message:
                `aiAgentProviders[${providerLabel}].models contains duplicate id "${model.id}"`,
            });
          } else {
            seenModelIds.add(model.id);
          }
          if (
            typeof model.name !== 'string' ||
            model.name.trim().length === 0
          ) {
            issues.push({
              providerId:
                typeof provider.id === 'string' ? provider.id : undefined,
              message:
                `aiAgentProviders[${providerLabel}].${modelLabel}.name must be a non-empty string`,
            });
          }
        }
      }
    }

    // (d) toolFileLinks, if present, must be a plain object whose keys are
    // non-empty strings (tool names). We deliberately do NOT validate the
    // values: the host-side schema for the link payload is still in flux,
    // and rejecting unknown value shapes here would force every shape change
    // through this SDK file. Keys are the only contract this validator
    // pins.
    if (provider.toolFileLinks !== undefined) {
      if (
        typeof provider.toolFileLinks !== 'object' ||
        provider.toolFileLinks === null ||
        Array.isArray(provider.toolFileLinks)
      ) {
        issues.push({
          providerId:
            typeof provider.id === 'string' ? provider.id : undefined,
          message:
            `aiAgentProviders[${providerLabel}].toolFileLinks must be a plain object ` +
            'mapping tool names to link descriptors (or omitted).',
        });
      } else {
        for (const key of Object.keys(provider.toolFileLinks)) {
          if (typeof key !== 'string' || key.length === 0) {
            issues.push({
              providerId:
                typeof provider.id === 'string' ? provider.id : undefined,
              message:
                `aiAgentProviders[${providerLabel}].toolFileLinks contains an empty/invalid tool name key`,
            });
          }
        }
      }
    }
  }

  return issues;
}

/**
 * Convenience wrapper that throws if any fatal aiAgentProviders issues are
 * found. Mirrors {@link assertBackendModulesValid}. Use this in main-process
 * load paths where invalid manifests should refuse the extension outright.
 */
export function assertAgentProvidersValid(
  extensionId: string,
  aiAgentProviders: unknown,
  backendModules: unknown
): void {
  const issues = validateAgentProviders(aiAgentProviders, backendModules);
  const fatal = issues.filter((i) => i.severity !== 'warning');
  if (fatal.length === 0) {
    return;
  }
  const lines = fatal.map((i) =>
    i.providerId ? `  - [${i.providerId}] ${i.message}` : `  - ${i.message}`
  );
  throw new Error(
    `Extension ${extensionId} has invalid aiAgentProviders declarations:\n${lines.join('\n')}`
  );
}
