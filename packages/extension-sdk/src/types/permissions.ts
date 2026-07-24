/**
 * Extension permission types.
 *
 * The catalog of valid permission ids is owned by the host (Nimbalyst core).
 * Extensions reference permission ids; they cannot register new ids.
 *
 * Scope of what this catalog actually enforces
 * --------------------------------------------
 * The catalog only contains permissions for capabilities Nimbalyst exposes
 * through main-process brokers (database, workspace files, MCP registration,
 * secrets). Brokers can refuse a call when the grant is missing, so these
 * checks are real.
 *
 * The catalog deliberately does NOT contain ids for ambient Node capabilities
 * like spawn-process, raw fs access, or arbitrary network. Once a backend
 * module is granted (see BackendModuleContribution below), it can call
 * `require('child_process')`, `require('fs')`, `require('net')` directly --
 * there is no in-process sandbox that can prevent that. Listing those as
 * granular permissions would advertise enforcement we cannot deliver.
 *
 * Instead, granting a backend module is itself the consent that "this
 * extension may run native code on this machine with the same trust as your
 * user account." The first-use prompt says this verbatim. Anything finer
 * than that requires OS sandboxing or a different runtime model and is not
 * in scope here.
 *
 * Risk tiers shape how the consent prompt groups brokered permissions:
 *   low      - routine, low-impact (e.g., reading workspace files)
 *   elevated - non-trivial but bounded (e.g., registering MCP tools)
 *   high     - powerful, broad impact (e.g., writing the host DB, reading
 *              secrets)
 */

export type PermissionRiskTier = 'low' | 'elevated' | 'high';

/**
 * The full set of permission ids understood by the host. Every entry here is
 * a host-brokered capability: the renderer or backend module calls a main-
 * process surface that consults the grant before running.
 *
 * Adding a new id here is a coordinated host change: the runtime catalog
 * in the privileged host's `permissionRegistry` must gain a matching entry.
 *
 * Database access splits into read and write so extensions can declare
 * least-privilege intent without composing two grants into one.
 */
export type ExtensionPermissionId =
  | 'workspace-files'
  | 'nimbalyst-database-read'
  | 'nimbalyst-database-write'
  | 'secrets-read'
  | 'mcp-server-register';

/**
 * Backend module runtime. The privileged host loads the module in one of two
 * isolated runtimes. Choose based on workload:
 *
 *   utility-process - separate OS process via Electron `utilityProcess.fork`.
 *                     Use for process-spawning, networked, or crash-prone
 *                     backends (kernels, language servers, daemons).
 *   worker-thread   - `node:worker_threads`. Use for lighter compute / indexing
 *                     helpers that share the main-process Node lifecycle but
 *                     run off the event loop.
 */
export type BackendModuleRuntime = 'utility-process' | 'worker-thread';

/**
 * How a privileged capability is enabled.
 *
 * `default: 'disabled'` is the only supported value today. Capabilities are
 * always opt-in by the user.
 *
 * `promptOn: 'firstUse'` defers the consent prompt until the user takes an
 * action that needs the capability. This avoids first-launch consent walls.
 *
 * `purpose` is a one-sentence, human-readable description shown verbatim in
 * the consent prompt. It is the actual security copy the user reads, so
 * write it from the user's perspective ("Run Jupyter kernels and execute
 * notebook cells locally."), not the implementation's.
 */
export interface BackendModuleEnablement {
  default: 'disabled';
  promptOn: 'firstUse';
  purpose: string;
}

/**
 * A backend module contributed by an extension.
 *
 * Backend modules live outside the renderer in the privileged host. They are
 * inert until the user grants the module at first use.
 *
 * Granting a backend module is itself the consent to run native code on the
 * user's machine. The catalog ids in `permissions` only cover ADDITIONAL
 * host-brokered capabilities (Nimbalyst DB, secrets, MCP registration). They
 * do NOT enumerate raw Node capabilities the module already has via standard
 * `require()`. See the catalog docs at the top of this file.
 *
 * Any extension may declare a backend module. There is no provenance gate --
 * installing an extension and approving its first-use consent prompt IS the
 * decision to let it run native code. Built-in extensions ship inside the app
 * bundle (same trust domain as the app), so the host auto-grants them and
 * skips the prompt.
 *
 * `entry` is a path relative to the extension root pointing at a compiled JS
 * file. The file is loaded inside the chosen runtime, never in Electron main.
 */
export interface BackendModuleContribution {
  /** Unique within the extension (e.g., "jupyter-runtime") */
  id: string;

  /** Path to compiled JS entry, relative to extension root */
  entry: string;

  /** Which isolated runtime hosts the module */
  runtime: BackendModuleRuntime;

  /**
   * Additional host-brokered permissions this module requires beyond the
   * implicit "run native code" grant. Optional -- a module that only needs
   * ambient Node capabilities (fs, net, child_process) declares an empty
   * array. The consent prompt always shows the "run native code" line; the
   * brokered ids here appear as additional checkboxes grouped by risk tier.
   *
   * The runtime gate refuses any host-brokered RPC call whose permission is
   * not in this list and not in the user's grant set.
   */
  permissions: ExtensionPermissionId[];

  /** How/when the user is asked to enable this module */
  enablement: BackendModuleEnablement;
}
