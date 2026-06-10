/**
 * Default + migration helpers for the Claude Code picker's enabled-models list.
 *
 * `ai:getModels` filters the full Claude Code catalog down to the variant ids
 * stored in `providerSettings['claude-code'].models`. A variant that isn't in
 * that list never reaches the picker, even though the catalog produces it. So
 * adding a new variant (e.g. `fable-5`) requires seeding it here for new
 * installs (the default list) and back-filling it for existing users (the
 * migration in AIService). Extracted so both paths are unit-testable without
 * standing up the full AIService.
 */

/** Default enabled Claude Code variants shown in a fresh install's picker, in display order. */
export const DEFAULT_CLAUDE_CODE_ENABLED_MODELS: readonly string[] = [
  'claude-code:fable-5',
  'claude-code:opus',
  'claude-code:opus-4-7',
  'claude-code:opus-4-6',
  'claude-code:sonnet',
  'claude-code:haiku',
];

/**
 * Insert `variantId` into a persisted claude-code enabled-models list, before
 * or after `anchorId`. Returns a new array; the input is never mutated. If
 * `variantId` is already present the list is returned unchanged. When the
 * anchor is absent the variant falls back to the front (`'before'`) or the end
 * (`'after'`).
 */
export function insertClaudeCodeVariant(
  models: readonly string[],
  variantId: string,
  anchorId: string,
  position: 'before' | 'after' = 'after',
): string[] {
  if (models.includes(variantId)) return [...models];
  const anchorIndex = models.indexOf(anchorId);
  const insertAt =
    position === 'before'
      ? anchorIndex >= 0
        ? anchorIndex
        : 0
      : anchorIndex >= 0
        ? anchorIndex + 1
        : models.length;
  return [...models.slice(0, insertAt), variantId, ...models.slice(insertAt)];
}
