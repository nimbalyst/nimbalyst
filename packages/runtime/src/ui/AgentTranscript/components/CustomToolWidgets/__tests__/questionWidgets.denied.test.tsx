/**
 * Regression test for GitHub issue #1577.
 *
 * A PreToolUse hook that denies AskUserQuestion or PromptForUserInput makes
 * the CLI return an error tool result. The widgets treated any result text as
 * an answer, so the denied call rendered as "answered"/"submitted" (or, for
 * the form, stayed answerable with no prompt behind it). An errored result is
 * its own terminal state: not answered, not pending, not interactive.
 */

import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { Provider as JotaiProvider } from 'jotai';
import { store } from '../../../../../store/store';
import { setInteractiveWidgetHost } from '../../../../../store/atoms/interactiveWidgetHost';
import { clearAskUserQuestionDraft } from '../../../../../store/atoms/askUserQuestionDraft';
import { clearRequestUserInputDraft } from '../../../../../store/atoms/requestUserInputDraft';
import { AskUserQuestionWidget } from '../AskUserQuestionWidget';
import { RequestUserInputWidget } from '../RequestUserInputWidget';
import type { InteractiveWidgetHost } from '../InteractiveWidgetHost';

const SESSION_ID = 'session-1577';
const DENIAL = 'Hook PreToolUse denied: too long';

const ASK_ARGS = {
  questions: [
    {
      question: 'Which color?',
      header: 'Color',
      multiSelect: false,
      options: [
        { label: 'Red', description: '' },
        { label: 'Blue', description: '' },
      ],
    },
  ],
};

const FORM_ARGS = {
  title: 'Pick one',
  fields: [{ type: 'confirm', id: 'ok', label: 'Proceed?' }],
};

function toolMessage(id: string, args: unknown, result: unknown, isError: boolean) {
  return {
    toolCall: {
      providerToolCallId: id,
      arguments: args,
      result,
      ...(isError ? { isError: true, status: 'error' } : { status: 'completed' }),
    },
  } as any;
}

async function renderAsk(id: string, result: unknown, isError: boolean) {
  clearAskUserQuestionDraft(id);
  render(
    <JotaiProvider store={store}>
      <AskUserQuestionWidget message={toolMessage(id, ASK_ARGS, result, isError)} sessionId={SESSION_ID} isExpanded onToggle={() => {}} />
    </JotaiProvider>,
  );
  await act(async () => {});
}

async function renderForm(id: string, result: unknown, isError: boolean) {
  clearRequestUserInputDraft(id);
  render(
    <JotaiProvider store={store}>
      <RequestUserInputWidget message={toolMessage(id, FORM_ARGS, result, isError)} sessionId={SESSION_ID} isExpanded onToggle={() => {}} />
    </JotaiProvider>,
  );
  await act(async () => {});
}

describe('question widgets with a hook-denied (errored) result', () => {
  beforeEach(() => {
    setInteractiveWidgetHost(SESSION_ID, {
      askUserQuestionSubmit: vi.fn().mockResolvedValue(undefined),
      askUserQuestionCancel: vi.fn().mockResolvedValue(undefined),
      requestUserInputSubmit: vi.fn().mockResolvedValue(undefined),
      requestUserInputCancel: vi.fn().mockResolvedValue(undefined),
    } as unknown as InteractiveWidgetHost);
  });

  it('AskUserQuestion: a denied call is blocked, not answered, and offers no submit', async () => {
    await renderAsk('ask-denied', DENIAL, true);
    expect(screen.getByTestId('ask-user-question-widget').getAttribute('data-state')).toBe('blocked');
    expect(screen.queryByTestId('ask-user-question-completed')).toBeNull();
    expect(screen.queryByTestId('ask-user-question-submit')).toBeNull();
    expect(screen.queryAllByTestId('ask-user-question-option')).toHaveLength(0);
    expect(screen.getByTestId('ask-user-question-blocked-reason').textContent).toContain(DENIAL);
  });

  it('AskUserQuestion: a genuine answer still renders as answered', async () => {
    await renderAsk('ask-answered', JSON.stringify({ answers: { 'Which color?': 'Blue' } }), false);
    expect(screen.getByTestId('ask-user-question-widget').getAttribute('data-state')).toBe('completed');
    expect(screen.queryByTestId('ask-user-question-completed')).not.toBeNull();
  });

  it('PromptForUserInput: a denied call is blocked, not submitted, and offers no submit', async () => {
    await renderForm('form-denied', [{ type: 'text', text: DENIAL }], true);
    expect(screen.getByTestId('request-user-input-widget').getAttribute('data-state')).toBe('blocked');
    expect(screen.queryByTestId('request-user-input-completed')).toBeNull();
    expect(screen.queryByRole('button', { name: /submit/i })).toBeNull();
    expect(screen.getByTestId('request-user-input-blocked-reason').textContent).toContain(DENIAL);
  });

  it('PromptForUserInput: a genuine answer still renders as submitted', async () => {
    await renderForm('form-answered', JSON.stringify({ answers: { ok: { type: 'confirm', value: true } } }), false);
    expect(screen.getByTestId('request-user-input-widget').getAttribute('data-state')).toBe('completed');
    expect(screen.queryByTestId('request-user-input-completed')).not.toBeNull();
  });

  // Review follow-ups: hook text that merely contains an open-question phrase,
  // or looks like an answer, is still a denial.
  const TIMEOUT_LOOKALIKE = 'Hook PreToolUse denied: policy service Request timed out';
  const ANSWER_LOOKALIKE = 'Hook PreToolUse denied: use "mode"="short" instead';
  const MODE_ARGS = {
    questions: [{ question: 'mode', header: 'Mode', multiSelect: false, options: [{ label: 'short', description: '' }, { label: 'long', description: '' }] }],
  };

  it.each([TIMEOUT_LOOKALIKE, ANSWER_LOOKALIKE])('AskUserQuestion: %s is blocked', async (text) => {
    clearAskUserQuestionDraft('ask-lookalike');
    render(
      <JotaiProvider store={store}>
        <AskUserQuestionWidget message={toolMessage('ask-lookalike', MODE_ARGS, text, true)} sessionId={SESSION_ID} isExpanded onToggle={() => {}} />
      </JotaiProvider>,
    );
    await act(async () => {});
    expect(screen.getByTestId('ask-user-question-widget').getAttribute('data-state')).toBe('blocked');
    expect(screen.queryByTestId('ask-user-question-submit')).toBeNull();
  });

  it.each([
    TIMEOUT_LOOKALIKE,
    'Hook PreToolUse denied: {"answers":{"ok":{"type":"confirm","value":true}}}',
    'Hook PreToolUse denied: request cancelled by policy',
  ])('PromptForUserInput: %s is blocked', async (text) => {
    await renderForm('form-lookalike', text, true);
    expect(screen.getByTestId('request-user-input-widget').getAttribute('data-state')).toBe('blocked');
    expect(screen.queryByRole('button', { name: /submit/i })).toBeNull();
  });

  it('PromptForUserInput: a real MCP timeout still leaves the form answerable', async () => {
    await renderForm('form-timeout', 'MCP error -32001: Request timed out', true);
    expect(screen.getByTestId('request-user-input-widget').getAttribute('data-state')).toBe('pending');
  });

  it('a structured cancel with isError still renders as cancelled', async () => {
    await renderForm('form-cancel', JSON.stringify({ cancelled: true }), true);
    expect(screen.getByTestId('request-user-input-widget').getAttribute('data-state')).toBe('cancelled');
  });
});
