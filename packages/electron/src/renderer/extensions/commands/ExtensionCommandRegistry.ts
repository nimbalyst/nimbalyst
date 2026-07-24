/**
 * Extension Command Registry
 *
 * Singleton registry mapping extension command IDs to their handlers.
 * Panel toggle commands are auto-registered by PanelRegistry when panels load.
 *
 * Commands are dispatched via DOM custom events so the registry stays decoupled
 * from React state. App.tsx listens for 'nimbalyst:toggle-panel:${panelId}'
 * events and drives the appropriate state setter.
 */

// ============================================================================
// Types
// ============================================================================

export interface RegisteredCommand {
  /** Full command ID, e.g. "com.nimbalyst.git.git-log.toggle" */
  id: string;

  /** Extension that registered this command */
  extensionId: string;

  /** Human-readable title */
  title: string;

  /** Handler to call when the command fires */
  handler: () => void;
}

export interface RegisteredKeybinding {
  /** Full command ID this keybinding invokes */
  commandId: string;

  /** Extension that contributed this keybinding */
  extensionId: string;

  /** Normalized key string, e.g. "ctrl+shift+g" */
  key: string;

  /** Human-readable title of the command */
  commandTitle: string;
}

// ============================================================================
// Registry state
// ============================================================================

const commands = new Map<string, RegisteredCommand>();
const keybindings: RegisteredKeybinding[] = [];

const listeners = new Set<() => void>();

function notifyListeners(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch (err) {
      console.error('[ExtensionCommandRegistry] Error in listener:', err);
    }
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Register a command handler.
 * Called by PanelRegistry for auto-registered toggle commands,
 * and by the extension host for explicitly declared commands.
 */
export function registerCommand(
  id: string,
  extensionId: string,
  title: string,
  handler: () => void
): void {
  if (commands.has(id)) {
    console.warn(`[ExtensionCommandRegistry] Overwriting existing command: ${id}`);
  }
  commands.set(id, { id, extensionId, title, handler });
  notifyListeners();
}

/**
 * Register a keybinding that maps a key combo to a command.
 * Called after manifests are loaded.
 */
export function registerKeybinding(
  key: string,
  commandId: string,
  extensionId: string
): void {
  const cmd = commands.get(commandId);
  const commandTitle = cmd?.title ?? commandId;

  // Warn about built-in shortcut collisions
  warnIfCollision(key, commandId);

  keybindings.push({ commandId, extensionId, key, commandTitle });
  notifyListeners();
}

/**
 * Execute a command by ID.
 * Returns true if the command was found and invoked.
 */
export function executeCommand(id: string): boolean {
  const cmd = commands.get(id);
  if (!cmd) {
    console.warn(`[ExtensionCommandRegistry] Unknown command: ${id}`);
    return false;
  }
  try {
    cmd.handler();
  } catch (err) {
    console.error(`[ExtensionCommandRegistry] Error executing command ${id}:`, err);
  }
  return true;
}

/**
 * Unregister all commands and keybindings from a specific extension.
 * Called when an extension is unloaded.
 */
export function unregisterExtension(extensionId: string): void {
  for (const [id, cmd] of commands) {
    if (cmd.extensionId === extensionId) {
      commands.delete(id);
    }
  }

  const before = keybindings.length;
  keybindings.splice(0, keybindings.length,
    ...keybindings.filter(kb => kb.extensionId !== extensionId)
  );
  if (keybindings.length !== before) {
    notifyListeners();
  }
}

/** Get all registered keybindings (for display in Keyboard Shortcuts dialog). */
export function getRegisteredKeybindings(): RegisteredKeybinding[] {
  return [...keybindings];
}

/** Get all registered commands. */
export function getRegisteredCommands(): RegisteredCommand[] {
  return [...commands.values()];
}

/** Subscribe to registry changes (commands or keybindings added/removed). */
export function subscribeToCommandRegistry(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ============================================================================
// Collision detection
// ============================================================================

/** Built-in shortcuts as lowercase normalized strings for collision detection. */
const BUILT_IN_SHORTCUTS = new Set([
  'cmd+n', 'cmd+shift+n', 'cmd+o', 'cmd+shift+o', 'cmd+s',
  'cmd+w', 'cmd+shift+t', 'cmd+shift+w', 'cmd+q',
  'cmd+z', 'cmd+shift+z', 'cmd+x', 'cmd+c', 'cmd+shift+c',
  'cmd+v', 'cmd+a', 'cmd+f', 'cmd+g', 'cmd+shift+g', 'cmd+y',
  'cmd+enter', 'cmd+shift+backspace',
  'cmd+e', 'cmd+k', 'cmd+shift+a', 'cmd+j', 'ctrl+`',
  'cmd+t', 'cmd+d', 'cmd+b',
  'cmd+[', 'cmd+]', 'cmd+option+right', 'cmd+option+left',
  'cmd+0', 'cmd+plus', 'cmd+-',
  'cmd+alt+i', 'cmd+r', 'cmd+shift+r', 'ctrl+cmd+f',
  'cmd+p', 'cmd+shift+h', 'cmd+l', 'cmd+shift+l', 'cmd+shift+f',
  'cmd+shift+k', 'cmd+alt+w', 'cmd+,', 'cmd+m',
]);

function normalizeKeyForCollision(key: string): string {
  return key.toLowerCase();
}

function warnIfCollision(key: string, commandId: string): void {
  const normalized = normalizeKeyForCollision(key);
  if (BUILT_IN_SHORTCUTS.has(normalized)) {
    console.warn(
      `[ExtensionCommandRegistry] Keybinding "${key}" for command "${commandId}" ` +
      `conflicts with a built-in shortcut. The extension keybinding may not fire.`
    );
  }
}
