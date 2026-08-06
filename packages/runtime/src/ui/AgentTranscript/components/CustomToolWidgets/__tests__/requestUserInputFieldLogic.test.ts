// @vitest-environment node
/**
 * NIM-2420: a confirm field the agent left without a `defaultValue` used to seed
 * as `false` and validate unconditionally, so a user who never touched the
 * control submitted `value: false` -- indistinguishable on the wire from a
 * deliberate "No". These cover the answer contract, not the control's copy.
 */

import { describe, expect, it } from 'vitest';

import {
  draftToAnswers,
  fieldDraftValid,
  seedDraft,
} from '../requestUserInputFieldLogic';
import type { RequestUserInputArgs } from '../../../../../ai/server/providers/shared/requestUserInputTypes';

function confirmArgs(defaultValue?: boolean): RequestUserInputArgs {
  return {
    fields: [{ type: 'confirm', id: 'send', label: 'Send the emails?', ...(defaultValue === undefined ? {} : { defaultValue }) }],
  };
}

describe('confirm field draft logic', () => {
  it('blocks submit and emits no answer while untouched', () => {
    const args = confirmArgs();
    const draft = seedDraft(args);

    expect(fieldDraftValid(args.fields[0], draft.fields.send)).toBe(false);
    expect(draftToAnswers(args, draft)).toEqual({});
  });

  it.each([true, false])('emits the picked value (%s) once the user answers', (picked) => {
    const args = confirmArgs();
    const draft = seedDraft(args);
    draft.fields.send = { type: 'confirm', state: { value: picked } };

    expect(fieldDraftValid(args.fields[0], draft.fields.send)).toBe(true);
    expect(draftToAnswers(args, draft)).toEqual({
      send: { type: 'confirm', value: picked },
    });
  });

  it('honors an explicit defaultValue as a pre-selected, submittable answer', () => {
    const args = confirmArgs(true);
    const draft = seedDraft(args);

    expect(fieldDraftValid(args.fields[0], draft.fields.send)).toBe(true);
    expect(draftToAnswers(args, draft)).toEqual({
      send: { type: 'confirm', value: true },
    });
  });
});
