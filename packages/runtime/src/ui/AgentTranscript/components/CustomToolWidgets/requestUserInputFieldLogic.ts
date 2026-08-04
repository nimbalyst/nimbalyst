/**
 * Pure draft logic for the RequestUserInput widget: seeding a field's draft
 * from the agent's field definition, deciding whether a draft is submittable,
 * and converting drafts to the answer payload.
 *
 * Lives outside RequestUserInputWidget.tsx so tests can exercise the answer
 * contract without importing the widget's Lexical editor tree.
 */

import type {
  RequestUserInputAnswer,
  RequestUserInputArgs,
  RequestUserInputField,
} from '../../../../ai/server/providers/shared/requestUserInputTypes';
import type {
  RequestUserInputDraft,
  RequestUserInputFieldDraft,
} from '../../../../store/atoms/requestUserInputDraft';

export function seedFieldDraft(field: RequestUserInputField): RequestUserInputFieldDraft {
  switch (field.type) {
    case 'multiSelect':
      return {
        type: 'multiSelect',
        state: {
          selectedIds: field.items.filter((i) => i.defaultChecked).map((i) => i.id),
        },
      };
    case 'singleSelect':
      return {
        type: 'singleSelect',
        state: { selectedId: null, otherSelected: false, otherText: '' },
      };
    case 'reorder':
      return {
        type: 'reorder',
        state: { orderedIds: field.items.map((i) => i.id), removedIds: [] },
      };
    case 'editText':
      return {
        type: 'editText',
        state: { text: field.initialText ?? '' },
      };
    case 'confirm':
      // A confirm the agent left without an explicit `defaultValue` seeds as
      // unanswered, not false. Submitting an untouched field as false is
      // indistinguishable on the wire from a deliberate "No" -- that is how
      // NIM-2420 let an agent read three never-touched confirms as declines.
      // An explicit `defaultValue` is an intentional pre-selection, so honor it.
      return {
        type: 'confirm',
        state: { value: field.defaultValue ?? null },
      };
  }
}

export function seedDraft(args: RequestUserInputArgs): RequestUserInputDraft {
  const fields: Record<string, RequestUserInputFieldDraft> = {};
  for (const f of args.fields) {
    fields[f.id] = seedFieldDraft(f);
  }
  return { fields, primed: true };
}

export function fieldDraftValid(
  field: RequestUserInputField,
  draft: RequestUserInputFieldDraft | undefined,
): boolean {
  if (!draft) return false;
  if (draft.type !== field.type) return false;

  switch (field.type) {
    case 'multiSelect': {
      const min = field.minSelected ?? 0;
      const max = field.maxSelected ?? field.items.length;
      const count = (draft as any).state.selectedIds.length;
      return count >= min && count <= max;
    }
    case 'singleSelect': {
      const s = (draft as any).state;
      if (s.otherSelected) {
        return field.allowOther === true && typeof s.otherText === 'string' && s.otherText.trim().length > 0;
      }
      return typeof s.selectedId === 'string' && s.selectedId.length > 0;
    }
    case 'reorder': {
      const min = field.minItems ?? 0;
      return (draft as any).state.orderedIds.length >= Math.max(min, 0);
    }
    case 'editText': {
      const s = (draft as any).state;
      const trimmed = typeof s.text === 'string' ? s.text.trim() : '';
      const min = field.minLength ?? 0;
      const max = field.maxLength ?? Infinity;
      return trimmed.length >= min && (s.text?.length ?? 0) <= max;
    }
    case 'confirm':
      // Blocks submit until the user picks a side -- see seedFieldDraft.
      return (draft as any).state.value !== null;
  }
}

export function draftToAnswers(
  args: RequestUserInputArgs,
  draft: RequestUserInputDraft,
): Record<string, RequestUserInputAnswer> {
  const out: Record<string, RequestUserInputAnswer> = {};
  for (const field of args.fields) {
    const fd = draft.fields[field.id];
    if (!fd) continue;

    switch (field.type) {
      case 'multiSelect':
        if (fd.type === 'multiSelect') {
          out[field.id] = { type: 'multiSelect', selectedIds: [...fd.state.selectedIds] };
        }
        break;
      case 'singleSelect':
        if (fd.type === 'singleSelect') {
          if (fd.state.otherSelected) {
            out[field.id] = {
              type: 'singleSelect',
              selectedId: '__other__',
              otherText: fd.state.otherText.trim(),
            };
          } else if (fd.state.selectedId) {
            out[field.id] = { type: 'singleSelect', selectedId: fd.state.selectedId };
          }
        }
        break;
      case 'reorder':
        if (fd.type === 'reorder') {
          out[field.id] = {
            type: 'reorder',
            orderedIds: [...fd.state.orderedIds],
            removedIds: [...fd.state.removedIds],
          };
        }
        break;
      case 'editText':
        if (fd.type === 'editText') {
          out[field.id] = {
            type: 'editText',
            text: fd.state.text,
            edited: fd.state.text !== (field.initialText ?? ''),
          };
        }
        break;
      case 'confirm':
        // An unanswered confirm emits nothing rather than a fabricated false;
        // `fieldDraftValid` already blocks submit, so this is belt-and-braces
        // against a caller that assembles answers without validating.
        if (fd.type === 'confirm' && fd.state.value !== null) {
          out[field.id] = { type: 'confirm', value: fd.state.value };
        }
        break;
    }
  }
  return out;
}
