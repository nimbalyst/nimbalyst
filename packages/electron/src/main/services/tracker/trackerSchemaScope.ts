/**
 * Ambient workspace scope for tracker schema lookups.
 *
 * The tracker schema registry is process-global and keyed by type name only, so
 * two open projects that both define a `widget` type share one slot. The live
 * registry view belongs to the ACTIVE workspace; a background reader (the
 * in-process MCP server serving a tool call for a different project) must see
 * that project's schemas without overwriting the active project's (#1035).
 *
 * `runWithTrackerSchemaWorkspace` marks the async context as operating on behalf
 * of a given workspace. Registry reads inside that context resolve against that
 * workspace's cached layer instead of the active view. AsyncLocalStorage keeps
 * concurrent tool calls for different workspaces from seeing each other's scope.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { globalRegistry } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';

const workspaceScope = new AsyncLocalStorage<string>();

let providerInstalled = false;

/** Wire the ambient scope into the registry. Idempotent. */
export function installTrackerSchemaScopeProvider(): void {
  if (providerInstalled) return;
  globalRegistry.setScopeProvider(() => workspaceScope.getStore());
  providerInstalled = true;
}

/**
 * Run `fn` with tracker schema reads scoped to `workspacePath`. A missing path
 * runs unscoped (reads resolve against the active workspace view, as before).
 */
export function runWithTrackerSchemaWorkspace<T>(
  workspacePath: string | null | undefined,
  fn: () => T,
): T {
  if (!workspacePath) return fn();
  installTrackerSchemaScopeProvider();
  return workspaceScope.run(workspacePath, fn);
}

/**
 * Wrap a handler so every invocation runs with tracker schema reads scoped to
 * `workspacePath`. Use this at a handler's registration point when the whole
 * handler acts on behalf of one workspace.
 */
export function withTrackerSchemaWorkspace<A extends unknown[], R>(
  workspacePath: string | null | undefined,
  handler: (...args: A) => R,
): (...args: A) => R {
  return (...args: A) => runWithTrackerSchemaWorkspace(workspacePath, () => handler(...args));
}

/** The workspace the current async context is acting for, if any. */
export function getTrackerSchemaScopeWorkspace(): string | undefined {
  return workspaceScope.getStore();
}
