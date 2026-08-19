/**
 * The shared area's Feedback surface, as a tab.
 *
 * Same shape as the Shared Docs Home (`SHARED_HOME_TAB_URI`): a singleton
 * virtual tab with no backing content, deduped by URI, so opening it twice
 * focuses the one that is already there. Unlike the Home it is desktop-only for
 * now, so the id lives here rather than in the shared docs package.
 *
 * Deliberately not `virtual://feedback-request/<orgId>/<id>` — that URI is one
 * request's results tab, and this is the list of all of them.
 */

export const SHARED_FEEDBACK_TAB_URI = 'virtual://shared-feedback';
export const SHARED_FEEDBACK_TAB_TITLE = 'Feedback';

export function isSharedFeedbackTab(filePath: string | null | undefined): boolean {
  return filePath === SHARED_FEEDBACK_TAB_URI;
}
