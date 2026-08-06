/**
 * A tiny notification channel for "a window is now available for workspace X".
 *
 * The queued-prompt driver defers delivery when a workspace has no window and
 * needs to be woken when one appears, rather than polling. Kept in its own
 * module so the MCP routing layer can notify without importing the services
 * layer (circular import).
 */

type Listener = (workspacePath: string) => void;

const listeners = new Set<Listener>();

/** Called when a window registers itself as owning a workspace path. */
export function notifyWorkspaceWindowAvailable(workspacePath: string): void {
  if (!workspacePath) return;
  for (const listener of Array.from(listeners)) {
    try {
      listener(workspacePath);
    } catch {
      // A misbehaving subscriber must not break window registration.
    }
  }
}

/** Subscribe to window availability. Returns an unsubscribe function. */
export function onWorkspaceWindowAvailable(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
