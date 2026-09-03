/**
 * InteractivePrompt Draft State Atoms
 *
 * Per-question draft state for InteractivePromptWidget's ask-user-question form.
 *
 * Lives in a jotai atomFamily keyed by the request's questionId so the draft
 * (selected options, "Other" toggle, "Other" text) survives widget unmount --
 * the transcript's virtual scroller unmounts rows that scroll out of view, and
 * component-local useState is discarded with them (#1418).
 *
 * Shape mirrors the widget's own representation rather than
 * [askUserQuestionDraft]'s: this form stores a multi-select answer as a single
 * ", "-joined string, not a string[].
 */

import { atom } from 'jotai';
import { atomFamily } from 'jotai-family';

export interface InteractivePromptDraft {
  /** Question text -> picked option label(s), ", "-joined when multiSelect. */
  answers: Record<string, string>;
  /** Question text -> "Other" toggle state. */
  otherSelected: Record<string, boolean>;
  /** Question text -> custom text typed into the "Other" textarea. */
  otherText: Record<string, string>;
}

export const EMPTY_INTERACTIVE_PROMPT_DRAFT: InteractivePromptDraft = {
  answers: {},
  otherSelected: {},
  otherText: {},
};

/** Per-question draft atom. Key is the request's questionId. */
export const interactivePromptDraftAtom = atomFamily((_questionId: string) =>
  atom<InteractivePromptDraft>(EMPTY_INTERACTIVE_PROMPT_DRAFT)
);

/**
 * Remove the draft atom for a resolved question so we don't leak atoms for
 * prompts that have already been submitted or cancelled.
 */
export function clearInteractivePromptDraft(questionId: string): void {
  interactivePromptDraftAtom.remove(questionId);
}
