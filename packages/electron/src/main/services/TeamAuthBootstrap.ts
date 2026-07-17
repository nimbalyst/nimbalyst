/**
 * Coalesce authenticated team initialization while one run is active.
 *
 * Team API requests may refresh a Stytch session. That refresh emits another
 * authenticated state synchronously with the active bootstrap, so starting a
 * fresh run from every notification creates a request -> refresh -> request
 * loop. Deferring the work by one microtask ensures the in-flight promise is
 * installed before the bootstrap can trigger a re-entrant notification.
 */
export function createTeamAuthBootstrap(
  bootstrap: () => Promise<void>,
): () => Promise<void> {
  let inFlight: Promise<void> | null = null;

  return () => {
    if (inFlight) return inFlight;

    const run = Promise.resolve().then(bootstrap);
    const tracked = run.finally(() => {
      if (inFlight === tracked) inFlight = null;
    });
    inFlight = tracked;
    return tracked;
  };
}
