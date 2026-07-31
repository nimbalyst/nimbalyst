export interface ArchiveSessionProviderLifecycleDeps {
  archiveSession(sessionId: string): Promise<void>;
  destroyProvider(sessionId: string): void;
  onArchiveError?(sessionId: string, error: unknown): void;
  onProviderCleanupError?(sessionId: string, error: unknown): void;
}

export interface ArchiveSessionProviderLifecycleResult {
  archiveFailures: number;
  providerCleanupFailures: number;
}

/**
 * Release the provider owned by one session after its archive write succeeds.
 * Errors are bounded so archive/delete workflows can continue converging.
 */
export function destroyProviderForArchivedSession(
  sessionId: string,
  destroyProvider: (sessionId: string) => void,
  onProviderCleanupError?: (sessionId: string, error: unknown) => void,
): boolean {
  try {
    destroyProvider(sessionId);
    return true;
  } catch (error) {
    onProviderCleanupError?.(sessionId, error);
    return false;
  }
}

export interface ReleaseSessionRuntimeDeps {
  /** Release the cached provider object (SDK path). */
  destroyProvider(sessionId: string): void;
  /**
   * Release the PTY backing a `claude-code-cli` session. A no-op for a session
   * that never had one, so this is safe to call for every provider type.
   */
  destroyTerminal(sessionId: string): Promise<void>;
  onProviderCleanupError?(sessionId: string, error: unknown): void;
  onTerminalCleanupError?(sessionId: string, error: unknown): void;
}

export interface ReleaseSessionRuntimeResult {
  providerReleased: boolean;
  terminalReleased: boolean;
}

/**
 * Release everything a session owns at runtime: its provider AND its terminal.
 *
 * Destroying the provider alone leaves a `claude-code-cli` session's `claude`
 * process and its whole child tree running for the lifetime of the app, because
 * nothing else owns that PTY (GitHub #903). Deleting or archiving the session
 * removes it from the UI and the database, so the orphan is invisible and can
 * only be found in Task Manager.
 *
 * The two releases are bounded independently and neither can prevent the other:
 * a provider that throws must not strand the CLI process, and a PTY that is
 * already gone must not leak the provider. Never rejects, so delete/archive
 * flows always converge.
 */
export async function releaseSessionRuntime(
  sessionId: string,
  deps: ReleaseSessionRuntimeDeps,
): Promise<ReleaseSessionRuntimeResult> {
  const providerReleased = destroyProviderForArchivedSession(
    sessionId,
    deps.destroyProvider,
    deps.onProviderCleanupError,
  );

  let terminalReleased = true;
  try {
    await deps.destroyTerminal(sessionId);
  } catch (error) {
    terminalReleased = false;
    deps.onTerminalCleanupError?.(sessionId, error);
  }

  return { providerReleased, terminalReleased };
}

/**
 * Archive an exact set of sessions and then release only their providers.
 * A failed archive does not kill that session's live provider; other sessions
 * continue independently and both failure classes are reported separately.
 */
export async function archiveSessionsAndDestroyProviders(
  sessionIds: Iterable<string>,
  deps: ArchiveSessionProviderLifecycleDeps,
): Promise<ArchiveSessionProviderLifecycleResult> {
  let archiveFailures = 0;
  let providerCleanupFailures = 0;

  for (const sessionId of new Set(sessionIds)) {
    try {
      await deps.archiveSession(sessionId);
    } catch (error) {
      archiveFailures++;
      deps.onArchiveError?.(sessionId, error);
      continue;
    }

    const cleaned = destroyProviderForArchivedSession(
      sessionId,
      deps.destroyProvider,
      deps.onProviderCleanupError,
    );
    if (!cleaned) providerCleanupFailures++;
  }

  return { archiveFailures, providerCleanupFailures };
}
