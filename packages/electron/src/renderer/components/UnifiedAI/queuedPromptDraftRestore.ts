/**
 * Putting a queued prompt back into the draft input.
 *
 * Editing a queued prompt deletes its row and returns its content to the chat
 * box. The text was always restored; its attachments were not, so a prompt whose
 * body referenced `@pasted-image-….png` came back with the reference but no
 * attachment — and the next send reached the CLI with no path to resolve
 * (`claudeCliPromptComposer` builds path references from `attachments[].filepath`).
 */

import type { ChatAttachment } from '@nimbalyst/runtime/ai/server/types';

/**
 * Merge attachments restored from a queued prompt into the current draft,
 * keeping the draft's own attachments first and dropping ids already present so
 * editing the same prompt twice doesn't stack duplicates.
 */
export function mergeRestoredDraftAttachments(
  current: ChatAttachment[],
  restored: ReadonlyArray<ChatAttachment> | undefined | null,
): ChatAttachment[] {
  if (!restored || restored.length === 0) return current;
  const seen = new Set(current.map((a) => a.id));
  return [...current, ...restored.filter((a) => a && !seen.has(a.id))];
}
