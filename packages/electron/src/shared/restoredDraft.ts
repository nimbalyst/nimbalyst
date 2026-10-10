/**
 * Puts a prompt that never reached the agent back into a composer draft
 * without overwriting anything the user typed since. Shared by the renderer's
 * failed-send path and the main process's boot recovery so both merge the
 * same way.
 */
export function mergeRestoredPromptIntoDraft(currentDraft: string | null | undefined, prompt: string): string {
  const existing = currentDraft ?? '';
  if (!existing.trim()) return prompt;
  if (existing.includes(prompt)) return existing;
  return `${existing.replace(/\s+$/, '')}\n\n${prompt}`;
}
