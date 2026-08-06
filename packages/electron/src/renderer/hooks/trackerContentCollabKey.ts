/**
 * The key a tracker item's body document is addressed by in the collab atoms.
 *
 * Its own module so that reading a tracker body's connection state or presence
 * costs one string function. `useTrackerContentCollab` pulls in Lexical, yjs,
 * the collab adapters, and `BodyDocCache`; a header chip that only needs the
 * key should not pay for any of that.
 */
export function trackerContentCollabKey(itemId: string): string {
  return `tracker://${itemId}`;
}
