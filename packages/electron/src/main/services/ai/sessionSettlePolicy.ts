/**
 * Decide whether a provider stream that ended WITHOUT a `complete` chunk still
 * needs an explicit terminal transition.
 *
 * Built-in agent providers are not guaranteed to throw on failure. The Codex
 * app-server transport catches an RPC error, yields a single in-band `error`
 * chunk and then returns normally, so the generator finishes without reaching
 * the `complete` branch and without raising into the outer catch. Neither
 * settle path ran, `endSession` never fired, and the session sat at `running`
 * forever: Cancel then no-ops (the turn is already gone, so `abort()` has
 * nothing to abort) while the renderer's processing reconcile keeps
 * re-asserting the spinner from the stale main-process state.
 */
export function shouldSettleUnterminatedTurn(args: {
  /** A `complete` chunk was observed, so the normal settle path already ran. */
  sawComplete: boolean;
  /** Error text from the last in-band `error` chunk, if any. */
  providerError: string | undefined;
  /** The extension-agent error branch already ended the session. */
  alreadySettled: boolean;
  /** A queued-prompt chain owns the session and settles it via onChainSettled. */
  queuedChainActive: boolean;
}): boolean {
  const { sawComplete, providerError, alreadySettled, queuedChainActive } = args;
  if (sawComplete) return false;
  if (!providerError) return false;
  if (alreadySettled) return false;
  if (queuedChainActive) return false;
  return true;
}

/**
 * Decide whether Cancel should force the session's tracked state to idle.
 *
 * `provider.abort()` only unwinds a turn that is still in flight; once the
 * per-turn AbortController has been cleared it is a no-op. A session whose turn
 * died without a terminal transition therefore stays `running` in
 * SessionStateManager, and the renderer's processing reconcile re-asserts the
 * spinner a few seconds after every click. Cancel has to clear that state
 * itself. Sessions that are already idle are left alone so a stray click does
 * not emit a spurious `session:interrupted`.
 */
export function shouldForceIdleOnCancel(
  state: { status?: string; isStreaming?: boolean } | null | undefined
): boolean {
  if (!state) return false;
  return state.status === 'running' || state.isStreaming === true;
}
