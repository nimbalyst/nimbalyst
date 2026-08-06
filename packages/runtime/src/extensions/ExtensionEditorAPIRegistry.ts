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
  ownerToken: EditorAPIOwnerToken;
  priority: EditorAPIRegistrationPriority;
  sequence: number;
}

export type EditorAPIOwnerToken = symbol;
export type EditorAPIRegistrationPriority = 'hidden' | 'visible';

export interface RegisterEditorAPIOptions {
  ownerToken?: EditorAPIOwnerToken;
  priority?: EditorAPIRegistrationPriority;
}

const registry = new Map<string, Map<EditorAPIOwnerToken, RegistryEntry>>();
let registrationSequence = 0;

export function createEditorAPIOwnerToken(label = 'extension-editor'): EditorAPIOwnerToken {
  return Symbol(label);
}

function activeEntry(filePath: string): RegistryEntry | undefined {
  const entries = registry.get(normalizePath(filePath));
  if (!entries) return undefined;
  let active: RegistryEntry | undefined;
  for (const entry of entries.values()) {
    const entryPriority = entry.priority === 'visible' ? 1 : 0;
    const activePriority = active?.priority === 'visible' ? 1 : 0;
    if (!active || entryPriority > activePriority || (
      entryPriority === activePriority && entry.sequence > active.sequence
    )) {
      active = entry;
    }
  }
  return active;
}

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
export function registerEditorAPI(
  filePath: string,
  api: unknown,
  flushSave?: () => void | Promise<void>,
  options: RegisterEditorAPIOptions = {},
): EditorAPIOwnerToken {
  const normalizedPath = normalizePath(filePath);
  const ownerToken = options.ownerToken ?? createEditorAPIOwnerToken(normalizedPath);
  const entries = registry.get(normalizedPath) ?? new Map<EditorAPIOwnerToken, RegistryEntry>();
  entries.set(ownerToken, {
    api,
    flushSave,
    ownerToken,
    priority: options.priority ?? 'visible',
    sequence: ++registrationSequence,
  });
  registry.set(normalizedPath, entries);
  return ownerToken;
}

/**
 * Unregister an editor API for a file path.
 * Called when an editor unmounts.
 */
export function unregisterEditorAPI(filePath: string, ownerToken?: EditorAPIOwnerToken): void {
  const normalizedPath = normalizePath(filePath);
  if (!ownerToken) {
    registry.delete(normalizedPath);
    return;
  }
  const entries = registry.get(normalizedPath);
  if (!entries) return;
  entries.delete(ownerToken);
  if (entries.size === 0) registry.delete(normalizedPath);
}

/**
 * Get the registered editor API for a file path.
 */
export function getEditorAPI(filePath: string): unknown | undefined {
  return activeEntry(filePath)?.api;
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
  const flushSave = activeEntry(filePath)?.flushSave;
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
