/**
 * The activity trail stored on a tracker item's `data.activity`.
 *
 * This lives in tracker-core because two hosts write it — the app's tracker
 * tool handlers and the CLI's offline write path — and a row written by one
 * must be byte-for-byte what the other would have written. Two hand-maintained
 * copies had already drifted on the coalescing rule, so the shape is defined
 * once here and both hosts call it.
 */
/**
 * Append or coalesce an activity entry in a tracker item's `data.activity`.
 *
 * Mutates `data` in place, and migrates a legacy `customFields.activity` array
 * up to the top level on the way through — old rows stored it nested, and a
 * caller that appended to the top-level array alone would silently orphan the
 * existing history.
 *
 * Consecutive `updated` entries by the same author on the same field collapse
 * into the last one, so dragging a slider does not write a hundred rows. The
 * `content` field is the exception: its `newValue` is not overwritten, because
 * the entry records that the body changed rather than what it changed to.
 */
export declare function appendActivity(data: Record<string, any>, authorIdentity: any, action: string, details?: {
    field?: string;
    oldValue?: string;
    newValue?: string;
    note?: string;
}): void;
