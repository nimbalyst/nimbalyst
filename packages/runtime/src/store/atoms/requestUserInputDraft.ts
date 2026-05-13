/**
 * RequestUserInput Draft State Atoms
 *
 * Per-tool-call draft state for the RequestUserInput widget. Lives in a jotai
 * atomFamily keyed by toolCall.providerToolCallId so user edits survive widget
 * unmount (session switches and virtual-scroll churn).
 *
 * Component-local useState resets on every remount; these atoms live in the
 * module-level jotai store and don't.
 *
 * The draft holds a sub-state per field id, keyed by field.id, so a single
 * prompt with multiple fields composes cleanly without cross-field collisions.
 */

import { atom } from 'jotai';
import { atomFamily } from 'jotai/utils';

export interface RequestUserInputMultiSelectDraft {
  /** Currently checked item ids. */
  selectedIds: string[];
}

export interface RequestUserInputSingleSelectDraft {
  /** Currently selected option id, or null if Other is picked or nothing yet. */
  selectedId: string | null;
  otherSelected: boolean;
  otherText: string;
}

export interface RequestUserInputReorderDraft {
  /** Current order (post-removal). */
  orderedIds: string[];
  /** Items the user removed. */
  removedIds: string[];
}

export interface RequestUserInputEditTextDraft {
  /** Current text content (serialized as markdown or plain per field.format). */
  text: string;
}

export interface RequestUserInputConfirmDraft {
  value: boolean;
}

export type RequestUserInputFieldDraft =
  | { type: 'multiSelect'; state: RequestUserInputMultiSelectDraft }
  | { type: 'singleSelect'; state: RequestUserInputSingleSelectDraft }
  | { type: 'reorder'; state: RequestUserInputReorderDraft }
  | { type: 'editText'; state: RequestUserInputEditTextDraft }
  | { type: 'confirm'; state: RequestUserInputConfirmDraft };

export interface RequestUserInputDraft {
  /** Field id -> draft for that field. Primed once on first mount. */
  fields: Record<string, RequestUserInputFieldDraft>;
  /** Set true once we've seeded fields from the tool's defaults; avoids reseeding. */
  primed: boolean;
}

export const EMPTY_REQUEST_USER_INPUT_DRAFT: RequestUserInputDraft = {
  fields: {},
  primed: false,
};

export const requestUserInputDraftAtom = atomFamily((_toolCallId: string) =>
  atom<RequestUserInputDraft>(EMPTY_REQUEST_USER_INPUT_DRAFT),
);

/** Drop the draft atom for a resolved tool call so we don't leak atoms. */
export function clearRequestUserInputDraft(toolCallId: string): void {
  requestUserInputDraftAtom.remove(toolCallId);
}
