/**
 * AskUserQuestion Draft State Atoms
 *
 * Per-tool-call draft state for the AskUserQuestion widget.
 *
 * Lives in a jotai atomFamily keyed by toolCall.providerToolCallId so the draft
 * (selected options, "Other" toggle, "Other" text) survives widget unmount --
 * e.g. switching AI sessions, or the transcript's virtual scroller unmounting
 * off-screen rows.
 *
 * Component-local useState resets on every remount; these atoms live in the
 * module-level jotai store and don't.
 */

import { atom } from 'jotai';
import { atomFamily } from 'jotai/utils';

export interface AskUserQuestionDraft {
  /** Question text -> picked option labels (array so multiSelect works). */
  selections: Record<string, string[]>;
  /** Question text -> "Other" toggle state. */
  otherSelected: Record<string, boolean>;
  /** Question text -> custom text typed into the "Other" textarea. */
  otherText: Record<string, string>;
}

export const EMPTY_ASK_USER_QUESTION_DRAFT: AskUserQuestionDraft = {
  selections: {},
  otherSelected: {},
  otherText: {},
};

/**
 * Per-tool-call draft atom. Key is toolCall.providerToolCallId.
 */
export const askUserQuestionDraftAtom = atomFamily((_toolCallId: string) =>
  atom<AskUserQuestionDraft>(EMPTY_ASK_USER_QUESTION_DRAFT)
);

/**
 * Remove the draft atom for a resolved tool call so we don't leak atoms for
 * questions that have already been submitted or cancelled.
 */
export function clearAskUserQuestionDraft(toolCallId: string): void {
  askUserQuestionDraftAtom.remove(toolCallId);
}
