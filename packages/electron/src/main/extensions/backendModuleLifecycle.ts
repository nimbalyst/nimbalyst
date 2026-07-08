/**
 * Backend-module start-on-enable / stop-on-disable lifecycle.
 *
 * Backend modules (utility-process runtimes declared in a manifest's
 * `contributions.backendModules`) historically never started on their own —
 * `PrivilegedExtensionHost.startModule()` had no caller in the extension-loading
 * pipeline. This module is that caller. It is the keystone that makes a backend
 * module (e.g. the memory engine) actually run so its `registerMcpTools` tools
 * become live on the unified MCP surface and the voice agent.
 *
 * Keyed per (extensionId, moduleId, workspacePath): a module runs once per open
 * workspace. `startModule` is idempotent (returns the running snapshot if a
 * module is already up), so the start paths below — enable, startup, and
 * workspace-open — can overlap safely.
 *
 * The orchestration is dependency-injected so the decision logic is unit-tested
 * against a mocked host + manifest scan with zero Electron coupling. The default
 * deps wire to the real host, store, scan, and registry.
 */
import type { BackendModuleContribution } from '@nimbalyst/extension-sdk';
import type { ModuleHandle, StartModuleArgs } from './PrivilegedExtensionHost';
import { getPrivilegedExtensionHost } from './PrivilegedExtensionHost';
import {
  listExtensionBackendModules,
  resolveExtensionBackendModules,
} from '../ipc/ExtensionHandlers';
import { getExtensionEnabled } from '../utils/store';
import { getRegisteredWorkspacePaths } from '../mcp/mcpWorkspaceResolver';
import { clearBackendToolsForModule } from '../mcp/backendToolRegistry';
import { logger } from '../utils/logger';

/** One extension's resolved backend-module declarations + disk path. */
export interface ResolvedBackendModules {
  extensionId: string;
  extensionName: string;
  extensionPath: string;
  modules: BackendModuleContribution[];
  /**
   * Module ids referenced by this extension's `aiAgentProviders` contributions
   * (each provider's `backendModuleId`). These modules are NOT auto-started here
   * — the `extensionAgentBridge` starts them lazily on first actual use of the
   * provider, which is the only moment the first-use consent prompt should
   * appear. Auto-starting them would raise that prompt at startup / workspace
   * open before the user has opted into the provider.
   */
  agentProviderModuleIds?: string[];
}

/**
 * Everything the lifecycle needs from the outside world. Injected so the
 * orchestration is testable without Electron, the host, or the filesystem.
 */
export interface BackendModuleLifecycleDeps {
  /** All installed extensions (any enabled-state) that declare surviving backend modules. */
  listBackendModuleExtensions: () => Promise<ResolvedBackendModules[]>;
  /** Resolve one extension's backend modules (null if not installed / declares none). */
  resolveBackendModules: (extensionId: string) => Promise<ResolvedBackendModules | null>;
  /** Whether an extension is enabled (mirrors store.getExtensionEnabled). */
  isExtensionEnabled: (extensionId: string) => boolean;
  /** Currently-open workspace paths. */
  collectWorkspaces: () => string[];
  startModule: (args: StartModuleArgs) => Promise<ModuleHandle>;
  stopModule: (extensionId: string, moduleId: string, workspacePath: string) => Promise<void>;
  /** Every module handle the host currently tracks (for stop-everywhere on disable). */
  listModuleHandles: () => ModuleHandle[];
  clearBackendToolsForModule: (extensionId: string, moduleId: string) => void;
}

/** Start every module of `resolved` across each of `workspaces`. */
async function startModulesAcrossWorkspaces(
  resolved: ResolvedBackendModules,
  workspaces: string[],
  deps: BackendModuleLifecycleDeps
): Promise<void> {
  if (workspaces.length === 0) {
    logger.main.info(
      `[backendModuleLifecycle] ${resolved.extensionId}: no open workspaces; ` +
        `backend modules will start when a workspace opens`
    );
    return;
  }
  const agentProviderModuleIds = new Set(resolved.agentProviderModuleIds ?? []);
  for (const module of resolved.modules) {
    // Backend modules that back an aiAgentProvider start lazily via the
    // extensionAgentBridge on first actual use of the provider. Auto-starting
    // them here raises the first-use consent prompt at startup / workspace open
    // before the user has opted into the provider. Skip them.
    if (agentProviderModuleIds.has(module.id)) {
      logger.main.info(
        `[backendModuleLifecycle] skip ${resolved.extensionId}/${module.id}: ` +
          `agent-provider backend module (starts lazily on first use)`
      );
      continue;
    }
    for (const workspacePath of workspaces) {
      try {
        const handle = await deps.startModule({
          extensionId: resolved.extensionId,
          extensionName: resolved.extensionName,
          extensionPath: resolved.extensionPath,
          module,
          workspacePath,
        });
        logger.main.info(
          `[backendModuleLifecycle] start ${resolved.extensionId}/${module.id} ` +
            `@ ${workspacePath} -> ${handle.state.status}`
        );
      } catch (error) {
        logger.main.error(
          `[backendModuleLifecycle] failed to start ${resolved.extensionId}/${module.id} ` +
            `@ ${workspacePath}:`,
          error
        );
      }
    }
  }
}

/**
 * Start an extension's backend modules across all open workspaces. Called when
 * the extension is enabled. No-op (with a log) if the extension is disabled or
 * declares no backend modules.
 */
export async function startExtensionBackendModules(
  extensionId: string,
  deps: BackendModuleLifecycleDeps
): Promise<void> {
  if (!deps.isExtensionEnabled(extensionId)) {
    return;
  }
  const resolved = await deps.resolveBackendModules(extensionId);
  if (!resolved) {
    return;
  }
  await startModulesAcrossWorkspaces(resolved, deps.collectWorkspaces(), deps);
}

/**
 * Stop every running instance of an extension's backend modules (across every
 * workspace the host tracks, not just currently-open ones) and clear their
 * advertised MCP tools. Called when the extension is disabled.
 */
export async function stopExtensionBackendModules(
  extensionId: string,
  deps: BackendModuleLifecycleDeps
): Promise<void> {
  const handles = deps.listModuleHandles().filter((h) => h.extensionId === extensionId);
  const moduleIds = new Set<string>();
  for (const handle of handles) {
    moduleIds.add(handle.moduleId);
    try {
      await deps.stopModule(extensionId, handle.moduleId, handle.workspacePath);
      logger.main.info(
        `[backendModuleLifecycle] stop ${extensionId}/${handle.moduleId} @ ${handle.workspacePath}`
      );
    } catch (error) {
      logger.main.error(
        `[backendModuleLifecycle] failed to stop ${extensionId}/${handle.moduleId} ` +
          `@ ${handle.workspacePath}:`,
        error
      );
    }
  }
  for (const moduleId of moduleIds) {
    deps.clearBackendToolsForModule(extensionId, moduleId);
  }
}

/**
 * Start the backend modules of every enabled extension in a single
 * newly-opened workspace. Called when a workspace/window opens so a module that
 * couldn't start at enable time (no workspace was open) comes up now.
 */
export async function startWorkspaceBackendModules(
  workspacePath: string,
  deps: BackendModuleLifecycleDeps
): Promise<void> {
  const all = await deps.listBackendModuleExtensions();
  for (const resolved of all) {
    if (!deps.isExtensionEnabled(resolved.extensionId)) continue;
    await startModulesAcrossWorkspaces(resolved, [workspacePath], deps);
  }
}

/**
 * Start the backend modules of every enabled extension across all open
 * workspaces. Called once after windows/workspaces are ready at startup.
 */
export async function syncEnabledBackendModulesOnStartup(
  deps: BackendModuleLifecycleDeps
): Promise<void> {
  const all = await deps.listBackendModuleExtensions();
  const workspaces = deps.collectWorkspaces();
  for (const resolved of all) {
    if (!deps.isExtensionEnabled(resolved.extensionId)) continue;
    await startModulesAcrossWorkspaces(resolved, workspaces, deps);
  }
}

/**
 * Build the production deps wired to the real host, store, scan, and registry.
 * The pure orchestration functions above take deps explicitly so unit tests can
 * inject mocks instead of this.
 */
export function getDefaultBackendModuleLifecycleDeps(): BackendModuleLifecycleDeps {
  return {
    listBackendModuleExtensions: () => listExtensionBackendModules(),
    resolveBackendModules: (extensionId) => resolveExtensionBackendModules(extensionId),
    isExtensionEnabled: (extensionId) => getExtensionEnabled(extensionId),
    collectWorkspaces: () => getRegisteredWorkspacePaths(),
    startModule: (args) => getPrivilegedExtensionHost().startModule(args),
    stopModule: (extensionId, moduleId, workspacePath) =>
      getPrivilegedExtensionHost().stopModule(extensionId, moduleId, workspacePath),
    listModuleHandles: () => getPrivilegedExtensionHost().list(),
    clearBackendToolsForModule: (extensionId, moduleId) =>
      clearBackendToolsForModule(extensionId, moduleId),
  };
}
