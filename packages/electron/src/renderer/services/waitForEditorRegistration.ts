/**
 * Wait, bounded, for a custom-editor registration to appear.
 *
 * The hidden capture window can receive an offscreen mount request before its
 * extension system has finished registering custom editors (the main process
 * only waits a fixed 1s after load). Failing the first lookup turns that boot
 * race into a mount error + slow retry; polling until the registry catches up
 * makes the mount deterministic in both dev and packaged boots.
 */
export async function waitForEditorRegistration<T>(
  lookup: () => T | null | undefined,
  opts: { timeoutMs?: number; pollMs?: number } = {}
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 15000;
  const pollMs = opts.pollMs ?? 250;

  const first = lookup();
  if (first) return first;

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    const found = lookup();
    if (found) return found;
  }
  throw new Error(`Editor not registered within ${timeoutMs}ms`);
}
