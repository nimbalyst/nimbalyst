export type TrackerPersonalStateFieldKind = 'favorite' | 'opened';

/** Opaque LWW key shared by client writers for one independently merged field. */
export async function deriveTrackerPersonalStateKey(
  scope: string,
  itemId: string,
  kind: TrackerPersonalStateFieldKind,
): Promise<string> {
  const bytes = new TextEncoder().encode(`${scope}|${itemId}|${kind}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
