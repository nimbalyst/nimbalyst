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
