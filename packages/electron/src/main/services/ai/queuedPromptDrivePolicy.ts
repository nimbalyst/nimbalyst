/**
 * Queue admission must raise a drive edge for every provider. The driver owns
 * provider-specific dispatch and deferred retry; a caller only needs a usable
 * workspace route.
 */
export function shouldDriveNewlyQueuedPrompt(
  session: { provider?: string; workspacePath?: string } | null | undefined,
): session is { workspacePath: string } {
  return typeof session?.workspacePath === 'string' && session.workspacePath.length > 0;
}
