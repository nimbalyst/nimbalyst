/**
 * Extension Editor API Registry
 *
 * Central registry for extension editor imperative APIs. When an extension editor
 * mounts and its library initializes, the extension calls host.registerEditorAPI(api)
 * to make its API available for AI tool execution.
 *
 * This replaces the pattern where each extension maintained its own module-level
 * Map + window global (e.g., window.__excalidraw_getEditorAPI).
 *
 * The HiddenTabManager uses this registry to detect when an editor has finished
 * initializing (API is registered = editor is ready for tool calls).
 */

interface RegistryEntry {
  api: unknown;
  /** Trigger an immediate save of the editor's content to disk. */
  flushSave?: () => void | Promise<void>;
}

const registry = new Map<string, RegistryEntry>();

/**
 * Normalize a file path for consistent registry lookups.
 * Removes trailing slashes and collapses double slashes to prevent
 * mismatches when the same file is referenced via slightly different paths.
 */
function normalizePath(filePath: string): string {
  // Collapse repeated slashes (e.g., /foo//bar -> /foo/bar)
  let normalized = filePath.replace(/\/\/+/g, '/');
  // Remove trailing slash (unless it's the root "/")
  if (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

/**
 * Register an editor API for a file path.
 * Called by EditorHost.registerEditorAPI() when extensions report readiness.
 * @param flushSave Optional callback to trigger an immediate save (used after tool execution).
 */
export function registerEditorAPI(filePath: string, api: unknown, flushSave?: () => void | Promise<void>): void {
  registry.set(normalizePath(filePath), { api, flushSave });
}

/**
 * Unregister an editor API for a file path.
 * Called when an editor unmounts.
 */
export function unregisterEditorAPI(filePath: string): void {
  registry.delete(normalizePath(filePath));
}

/**
 * Get the registered editor API for a file path.
 */
export function getEditorAPI(filePath: string): unknown | undefined {
  return registry.get(normalizePath(filePath))?.api;
}

/**
 * Check if an editor API is registered for a file path.
 */
export function hasEditorAPI(filePath: string): boolean {
  return registry.has(normalizePath(filePath));
}

/**
 * Trigger an immediate save for the editor at the given file path.
 * Called by the bridge after tool execution to prevent data loss
 * when the user closes the tab before the normal auto-save fires.
 */
export async function flushEditorSave(filePath: string): Promise<boolean> {
  const flushSave = registry.get(normalizePath(filePath))?.flushSave;
  if (!flushSave) return false;
  await flushSave();
  return true;
}

/**
 * Get all registered file paths (for diagnostics).
 */
export function getRegisteredPaths(): string[] {
  return Array.from(registry.keys());
}
