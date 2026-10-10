/**
 * The provisional title a session gets from its first user message, before
 * auto-naming picks a real one. Null when the session keeps its title.
 */
export function provisionalTitleForFirstMessage(
  session: { hasBeenNamed?: boolean; messages: ReadonlyArray<{ type?: string }> },
  message: string
): string | null {
  // A caller-assigned title (an extension-owned session, a titled spawn) wins:
  // overwriting it would also clear hasBeenNamed and invite self-naming.
  if (session.hasBeenNamed === true) return null;
  const isFirstMessage =
    session.messages.length === 0 ||
    (session.messages.length === 1 && session.messages[0].type === 'user_message');
  if (!isFirstMessage) return null;
  return message.length > 100 ? message.substring(0, 97) + '...' : message;
}
