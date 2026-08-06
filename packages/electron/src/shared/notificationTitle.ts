/**
 * OS notification titles are truncated by every platform's shell anyway; bound
 * them here so a long session name can never push the actual subject out of
 * view (and so every caller composes the source prefix the same way).
 */
const NOTIFICATION_TITLE_MAX_LENGTH = 120;

/**
 * Compose `<source> -- <subject>` for a notification title, bounded to the
 * platform-safe length. Issue #1060 requires every AI notification to lead with
 * its originating session so the source stays identifiable even when
 * deep-linking fails.
 *
 * Dependency-free on purpose: main-process services import this without
 * pulling in `NotificationService` (and its `electron` imports) as a side
 * effect.
 */
export function composeNotificationTitle(sourceLabel: string, title: string): string {
  const label = sourceLabel.trim();
  const subject = title.trim();
  const composed = !label || subject.startsWith(label) ? subject : `${label} -- ${subject}`;
  return composed.length > NOTIFICATION_TITLE_MAX_LENGTH
    ? `${composed.slice(0, NOTIFICATION_TITLE_MAX_LENGTH - 3)}...`
    : composed;
}
