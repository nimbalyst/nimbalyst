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
  parseRequestUserInputResult,
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

// A permission denial is the tool's terminal result; the form treated it as no
// result and stayed answerable. Other non-answer text is not a decision: an
// interrupt leaves the form answerable (#1116), and so do a timeout and a
// backgrounded call (#1341).
describe('form result parsing', () => {
  it('closes the form on an explicit permission denial', () => {
    const denial = "The user doesn't want to take this action right now. STOP what you are doing and wait for the user to tell you how to proceed.";
    expect(parseRequestUserInputResult(denial)).toMatchObject({ cancelled: true, answers: {} });
    expect(parseRequestUserInputResult([{ type: 'text', text: denial }])).toMatchObject({ cancelled: true, answers: {} });
  });

  it.each([
    ['an interrupt', '[Request interrupted by user for tool use]'],
    ['the SDK interrupt rejection', "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed."],
    ['an MCP timeout', 'MCP error -32001: Request timed out'],
    ['a backgrounded call', 'MCP tool "nimbalyst - PromptForUserInput (MCP)" is still running after 120s. It was moved to the background as task t1 and keeps running.'],
  ])('keeps the form answerable after %s', (_label, text) => {
    expect(parseRequestUserInputResult(text)).toBeNull();
    expect(parseRequestUserInputResult([{ type: 'text', text }])).toBeNull();
  });

  it('keeps answers, cancels and an absent result as before', () => {
    const answers = { ok: { type: 'confirm', value: true } };
    expect(parseRequestUserInputResult(JSON.stringify({ answers }))).toEqual({ cancelled: false, answers });
    expect(parseRequestUserInputResult(JSON.stringify({ cancelled: true, reason: 'superseded' }))).toEqual({ cancelled: true, reason: 'superseded', answers: {} });
    expect(parseRequestUserInputResult(undefined)).toBeNull();
    expect(parseRequestUserInputResult('')).toBeNull();
  });
});
