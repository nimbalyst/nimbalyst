/**
 * AskUserQuestionWidget
 *
 * Interactive widget for the AskUserQuestion tool.
 * Renders questions from Claude and allows user to select answers.
 *
 * Uses InteractiveWidgetHost for operations that require access to atoms, callbacks, and analytics.
 * The host is read from interactiveWidgetHostAtom(sessionId) - no prop drilling needed.
 */

import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useAtom, useAtomValue } from 'jotai';
import type { CustomToolWidgetProps } from './index';
import { interactiveWidgetHostAtom } from '../../../../store/atoms/interactiveWidgetHost';
import {
  askUserQuestionDraftAtom,
  clearAskUserQuestionDraft,
  EMPTY_ASK_USER_QUESTION_DRAFT,
} from '../../../../store/atoms/askUserQuestionDraft';
import {
  InteractiveWidgetBody,
  InteractiveWidgetCard,
  InteractiveWidgetHeader,
  WidgetActionButton,
  WidgetBlock,
  WidgetFooter,
  WidgetNoteRow,
  WidgetOptionList,
  WidgetOptionRow,
  WidgetStatusPill,
} from './shared/InteractiveWidgetChrome';

// Shared with the feedback surfaces via InteractiveWidgetChrome; the glyph
// itself stays local because it is this widget's identity.
const QuestionMarkIcon: React.FC = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-full h-full">
    <path d="M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M6.06 6a2 2 0 0 1 3.88.67c0 1.33-2 2-2 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M8 11h.01" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

// ============================================================
// Types
// ============================================================

interface QuestionOption {
  label: string;
  description: string;
}

interface Question {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

// ============================================================
// Helper Functions
// ============================================================

// Defense-in-depth shape check. The MCP handler normalizes question shape before
// forwarding (interactiveToolHandlers.ts handleAskUserQuestion), but a tool call
// persisted in the transcript can still carry a malformed shape -- e.g. the model
// called AskUserQuestion with PromptForUserInput-style fields (editText, confirm)
// that have no `options` array. Drop questions that can't render as a multiple-
// choice question so the unguarded `question.options.map(...)` in the render
// branches below never throws "Cannot read properties of undefined (reading 'map')".
// Mirrors the isValidField/parseArgs hardening in RequestUserInputWidget.
function parseQuestions(args: any): Question[] {
  if (!args?.questions || !Array.isArray(args.questions)) {
    return [];
  }
  const valid: Question[] = [];
  for (const q of args.questions) {
    if (!q || typeof q !== 'object') continue;
    if (typeof q.question !== 'string' || typeof q.header !== 'string') continue;
    if (!Array.isArray(q.options) || q.options.length === 0) continue;
    // Each rendered option reads `.label`/`.description`; drop entries that aren't
    // objects with a string label so the option map can't throw either.
    const options: QuestionOption[] = q.options
      .filter((o: any) => o && typeof o === 'object' && typeof o.label === 'string')
      .map((o: any) => ({ label: o.label, description: typeof o.description === 'string' ? o.description : '' }));
    if (options.length === 0) continue;
    valid.push({
      question: q.question,
      header: q.header,
      options,
      multiSelect: q.multiSelect === true,
    });
  }
  if (valid.length !== args.questions.length) {
    console.warn(
      `[AskUserQuestionWidget] Dropped ${args.questions.length - valid.length} malformed question(s)`,
    );
  }
  return valid;
}

function parseAnswers(args: any, result: any): Record<string, string> {
  // Check arguments first
  if (args?.answers && typeof args.answers === 'object') {
    return args.answers;
  }

  const parseFromUnknown = (value: unknown): Record<string, string> => {
    if (!value) return {};

    if (typeof value === 'string') {
      try {
        return parseFromUnknown(JSON.parse(value));
      } catch {
        // Try SDK string format: "question"="answer"
        const answers: Record<string, string> = {};
        const regex = /"([^"]+)"="([^"]+)"/g;
        let match;
        while ((match = regex.exec(value)) !== null) {
          answers[match[1]] = match[2];
        }
        return answers;
      }
    }

    // Handle MCP content arrays: [{ type: "text", text: "..." }]
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === 'object' && (item as any).type === 'text' && typeof (item as any).text === 'string') {
          const nested = parseFromUnknown((item as any).text);
          if (Object.keys(nested).length > 0) return nested;
        }
      }
      return {};
    }

    if (typeof value !== 'object') {
      return {};
    }

    const record = value as Record<string, unknown>;
    if (record.answers && typeof record.answers === 'object' && !Array.isArray(record.answers)) {
      const answers: Record<string, string> = {};
      for (const [key, rawValue] of Object.entries(record.answers as Record<string, unknown>)) {
        if (typeof rawValue === 'string') {
          answers[key] = rawValue;
        }
      }
      if (Object.keys(answers).length > 0) {
        return answers;
      }
    }

    if (record.result !== undefined) {
      const nested = parseFromUnknown(record.result);
      if (Object.keys(nested).length > 0) {
        return nested;
      }
    }

    if (record.content !== undefined) {
      const nested = parseFromUnknown(record.content);
      if (Object.keys(nested).length > 0) {
        return nested;
      }
    }

    if (record.text !== undefined) {
      const nested = parseFromUnknown(record.text);
      if (Object.keys(nested).length > 0) {
        return nested;
      }
    }

    return {};
  };

  const parsed = parseFromUnknown(result);
  if (Object.keys(parsed).length > 0) {
    return parsed;
  }

  return {};
}

interface CancelledState {
  cancelled: boolean;
  /** Why the prompt closed, e.g. `superseded` when the user sent a new message instead. */
  reason?: string;
}

const NOT_CANCELLED: CancelledState = { cancelled: false };

function parseCancelledResult(result: unknown): CancelledState {
  if (!result) return NOT_CANCELLED;

  if (typeof result === 'string') {
    try {
      return parseCancelledResult(JSON.parse(result));
    } catch {
      const lower = result.toLowerCase();
      return { cancelled: lower.includes('cancelled') || lower.includes('canceled') };
    }
  }

  // Handle MCP content arrays: [{ type: "text", text: "..." }]
  if (Array.isArray(result)) {
    for (const item of result) {
      if (item && typeof item === 'object' && (item as any).type === 'text' && typeof (item as any).text === 'string') {
        const nested = parseCancelledResult((item as any).text);
        if (nested.cancelled) return nested;
      }
    }
    return NOT_CANCELLED;
  }

  if (typeof result !== 'object') {
    return NOT_CANCELLED;
  }

  const record = result as Record<string, unknown>;
  if (record.cancelled === true || record.canceled === true) {
    return { cancelled: true, reason: typeof record.reason === 'string' ? record.reason : undefined };
  }

  for (const nestedValue of [record.result, record.content, record.text]) {
    if (nestedValue === undefined) continue;
    const nested = parseCancelledResult(nestedValue);
    if (nested.cancelled) return nested;
  }

  return NOT_CANCELLED;
}

// ============================================================
// Widget Component
// ============================================================

export const AskUserQuestionWidget: React.FC<CustomToolWidgetProps> = ({
  message,
  sessionId,
  superseded,
}) => {
  const toolCall = message.toolCall;
  const questionId = toolCall?.providerToolCallId || '';

  // A question without a stable ID can't be submitted (host.askUserQuestionSubmit
  // keys off it) and draft state would collide with other no-ID widgets. Fail loud
  // rather than rendering a widget that can't do anything useful.
  if (!toolCall || !questionId) {
    if (toolCall && !questionId) {
      console.warn('[AskUserQuestionWidget] missing providerToolCallId on tool call; skipping render');
    }
    return null;
  }

  // Get host from atom (set by SessionTranscript)
  const host = useAtomValue(interactiveWidgetHostAtom(sessionId));

  const questions = parseQuestions(toolCall.arguments);

  // Parse result to determine completion state
  const rawResult = toolCall.result;
  const parsedAnswers = useMemo(() => parseAnswers(toolCall.arguments, rawResult), [toolCall.arguments, rawResult]);
  const hasResult = rawResult !== undefined && rawResult !== null && rawResult !== '';

  // Check if cancelled
  const cancelledState = useMemo(() => parseCancelledResult(rawResult), [rawResult]);
  const isCancelled = cancelledState.cancelled;
  // The user sent a new message instead of answering. Older transcripts have
  // no durable result for this, so the transcript also passes `superseded`.
  const isSkipped = cancelledState.reason === 'superseded' || (!hasResult && superseded === true);

  const isCompleted = hasResult || isSkipped;
  const isPending = !isCompleted;

  // Draft state lives in a jotai atomFamily keyed by questionId so it survives
  // component unmount -- session switches and virtual-scroll churn no longer lose it.
  const [draft, setDraft] = useAtom(askUserQuestionDraftAtom(questionId));
  const { selections, otherSelected, otherText } = draft;

  // Prime the draft from parsed answers the first time we see this tool call.
  // Once primed we leave it alone so user edits aren't overwritten on re-render.
  const primedRef = useRef(false);
  useEffect(() => {
    if (primedRef.current) return;
    if (questions.length === 0) return;
    // Only prime if the stored draft is still empty (i.e. first mount for this toolCallId).
    const draftIsEmpty =
      Object.keys(draft.selections).length === 0 &&
      Object.keys(draft.otherSelected).length === 0 &&
      Object.keys(draft.otherText).length === 0;
    if (!draftIsEmpty) {
      primedRef.current = true;
      return;
    }
    const initialSelections: Record<string, string[]> = {};
    for (const q of questions) {
      const answer = parsedAnswers[q.question];
      if (answer) {
        initialSelections[q.question] = q.multiSelect
          ? answer.split(', ').filter(a => a.trim())
          : [answer];
      } else {
        initialSelections[q.question] = [];
      }
    }
    setDraft(prev => ({ ...prev, selections: initialSelections }));
    primedRef.current = true;
  }, [questions, parsedAnswers, draft, setDraft]);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [hasResponded, setHasResponded] = useState(false);
  const [localResult, setLocalResult] = useState<{ answers: Record<string, string>; cancelled?: boolean } | null>(null);
  const otherInputRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});

  // Handle option toggle
  const handleOptionToggle = useCallback((question: Question, optionLabel: string) => {
    if (!isPending || hasResponded) return;

    setDraft(prev => {
      const current = prev.selections[question.question] || [];
      let nextSelection: string[];
      if (question.multiSelect) {
        nextSelection = current.includes(optionLabel)
          ? current.filter(o => o !== optionLabel)
          : [...current, optionLabel];
      } else {
        nextSelection = [optionLabel];
      }
      const nextOtherSelected = question.multiSelect
        ? prev.otherSelected
        : { ...prev.otherSelected, [question.question]: false };
      return {
        ...prev,
        selections: { ...prev.selections, [question.question]: nextSelection },
        otherSelected: nextOtherSelected,
      };
    });
  }, [isPending, hasResponded, setDraft]);

  // Handle "Other" toggle
  const handleOtherToggle = useCallback((question: Question) => {
    if (!isPending || hasResponded) return;

    const questionKey = question.question;
    const isCurrentlyOther = otherSelected[questionKey];

    setDraft(prev => ({
      ...prev,
      // Single-select: clear regular selections when picking Other
      selections: question.multiSelect
        ? prev.selections
        : { ...prev.selections, [questionKey]: [] },
      otherSelected: { ...prev.otherSelected, [questionKey]: !isCurrentlyOther },
    }));

    // Focus the input after toggling on
    if (!isCurrentlyOther) {
      setTimeout(() => {
        otherInputRefs.current[questionKey]?.focus();
      }, 0);
    }
  }, [isPending, hasResponded, otherSelected, setDraft]);

  const handleOtherTextChange = useCallback((questionKey: string, value: string) => {
    setDraft(prev => ({
      ...prev,
      otherText: { ...prev.otherText, [questionKey]: value },
    }));
  }, [setDraft]);

  // Handle submit
  const handleSubmit = useCallback(async () => {
    if (!host || hasResponded || !isPending) return;

    // Build answers object
    const answers: Record<string, string> = {};
    for (const q of questions) {
      const questionKey = q.question;
      if (otherSelected[questionKey] && otherText[questionKey]?.trim()) {
        // "Other" is selected with text — use the custom text
        const customAnswer = otherText[questionKey].trim();
        const selected = selections[questionKey] || [];
        if (q.multiSelect && selected.length > 0) {
          answers[questionKey] = [...selected, customAnswer].join(', ');
        } else {
          answers[questionKey] = customAnswer;
        }
      } else {
        const selected = selections[questionKey] || [];
        if (selected.length > 0) {
          answers[questionKey] = q.multiSelect ? selected.join(', ') : selected[0];
        }
      }
    }

    // Validate all questions have answers
    const unanswered = questions.filter(q => !answers[q.question]);
    if (unanswered.length > 0) {
      // Don't submit if not all questions answered
      return;
    }

    setIsSubmitting(true);
    setLocalResult({ answers });
    setHasResponded(true);

    try {
      await host.askUserQuestionSubmit(questionId, answers);
      // Resolved: drop the draft atom so we don't leak memory for completed questions.
      clearAskUserQuestionDraft(questionId);
    } catch (error) {
      console.error('[AskUserQuestionWidget] Failed to submit:', error);
      setLocalResult(null);
      setHasResponded(false);
    } finally {
      setIsSubmitting(false);
    }
  }, [host, questionId, questions, selections, otherSelected, otherText, hasResponded, isPending]);

  // Handle cancel
  const handleCancel = useCallback(async () => {
    if (!host || hasResponded || !isPending) return;

    setIsSubmitting(true);
    setLocalResult({ answers: {}, cancelled: true });
    setHasResponded(true);

    try {
      await host.askUserQuestionCancel(questionId);
      clearAskUserQuestionDraft(questionId);
    } catch (error) {
      console.error('[AskUserQuestionWidget] Failed to cancel:', error);
    } finally {
      setIsSubmitting(false);
    }
  }, [host, questionId, hasResponded, isPending]);

  // If no questions, show nothing
  if (questions.length === 0) {
    return null;
  }

  // Determine display result (local takes precedence while waiting)
  const displayResult = localResult || (isCompleted ? { answers: isSkipped ? {} : parsedAnswers, cancelled: isCancelled || isSkipped } : null);
  const displayAnswers = displayResult?.answers || {};
  const displayCancelled = displayResult?.cancelled || false;
  const displaySkipped = !localResult && isSkipped;

  // Check if all questions have selections (for enabling submit button)
  const allAnswered = questions.every(q => {
    const hasSelection = (selections[q.question] || []).length > 0;
    const hasOther = otherSelected[q.question] && otherText[q.question]?.trim();
    return hasSelection || hasOther;
  });

  // Show completed state
  if (displayResult || hasResponded) {
    const statusText = displaySkipped
      ? 'Question Skipped'
      : displayCancelled ? 'Question Cancelled' : 'Questions Answered';

    return (
      <InteractiveWidgetCard
        rootClassName="ask-user-question-widget"
        testId="ask-user-question-widget"
        state={displaySkipped ? 'skipped' : displayCancelled ? 'cancelled' : 'completed'}
        tone="resolved"
      >
        <InteractiveWidgetHeader
          icon={<QuestionMarkIcon />}
          title={statusText}
          trailing={
            displaySkipped ? (
              <WidgetStatusPill tone="muted" testId="ask-user-question-skipped">
                Skipped
              </WidgetStatusPill>
            ) : displayCancelled ? (
              <WidgetStatusPill tone="muted" testId="ask-user-question-cancelled">
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M9 3L3 9M3 3l6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                Cancelled
              </WidgetStatusPill>
            ) : (
              <WidgetStatusPill tone="success" testId="ask-user-question-completed">
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M10 3L4.5 8.5L2 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                Submitted
              </WidgetStatusPill>
            )
          }
        />

        <InteractiveWidgetBody>
          {displaySkipped && (
            <WidgetNoteRow rootClassName="ask-user-question-skipped-note" testId="ask-user-question-skipped-note">
              You sent a new message instead of answering.
            </WidgetNoteRow>
          )}
          {questions.map((question, qIndex) => {
            const answer = displayAnswers[question.question];

            return (
              <WidgetBlock
                key={qIndex}
                tag={question.header}
                hint={question.multiSelect ? 'Multiple selection' : undefined}
                question={question.question}
              >
                <WidgetOptionList>
                  {question.options.map((option, oIndex) => {
                    const isSelected = question.multiSelect
                      ? (answer?.split(', ') || []).includes(option.label)
                      : answer === option.label;

                    return (
                      <WidgetOptionRow
                        key={oIndex}
                        label={option.label}
                        description={option.description || undefined}
                        selected={isSelected}
                      />
                    );
                  })}
                </WidgetOptionList>
                {answer && (
                  <div className="mt-2 pt-2 border-t border-nim text-xs text-nim-muted italic">
                    Selected: {answer}
                  </div>
                )}
              </WidgetBlock>
            );
          })}
        </InteractiveWidgetBody>
      </InteractiveWidgetCard>
    );
  }

  // Show interactive UI for pending request.
  // If the host is momentarily unavailable (e.g. SessionTranscript's host effect
  // re-ran and hasn't yet re-populated the atom after a mode switch), still
  // render the questions so the user can read them and pre-stage answers --
  // only disable Submit/Cancel until the host arrives. Previously this branch
  // returned a bare "Waiting..." header with no question body, which made the
  // widget look broken after switching to Files mode and back.
  return (
    <InteractiveWidgetCard
      rootClassName="ask-user-question-widget"
      testId="ask-user-question-widget"
      state="pending"
      tone="active"
    >
      <InteractiveWidgetHeader
        icon={<QuestionMarkIcon />}
        title="Questions from Claude"
        trailing={
          !host ? (
            <span data-testid="ask-user-question-pending" className="text-xs text-nim-muted">Waiting...</span>
          ) : undefined
        }
      />

      <InteractiveWidgetBody>
        {questions.map((question, qIndex) => {
          const selectedOptions = selections[question.question] || [];

          return (
            <WidgetBlock
              key={qIndex}
              tag={question.header}
              hint={question.multiSelect ? 'Select multiple' : undefined}
              question={question.question}
            >
              <WidgetOptionList>
                {question.options.map((option, oIndex) => {
                  const isSelected = selectedOptions.includes(option.label);

                  return (
                    <WidgetOptionRow
                      key={oIndex}
                      testId="ask-user-question-option"
                      dataAttributes={{
                        'data-option-label': option.label,
                        'data-selected': isSelected,
                      }}
                      label={option.label}
                      description={option.description || undefined}
                      selected={isSelected}
                      onSelect={() => handleOptionToggle(question, option.label)}
                      disabled={isSubmitting}
                    />
                  );
                })}
                {/* "Other" option with inline text input */}
                <div
                  data-testid="ask-user-question-other"
                  data-selected={otherSelected[question.question] || false}
                  className={`rounded border transition-all duration-150 ${
                    otherSelected[question.question]
                      ? 'border-nim-primary bg-[color-mix(in_srgb,var(--nim-primary)_8%,var(--nim-bg-secondary))]'
                      : 'border-nim bg-nim-secondary hover:bg-nim-hover'
                  } ${isSubmitting ? 'opacity-50' : ''}`}
                >
                  <button
                    type="button"
                    onClick={() => handleOtherToggle(question)}
                    disabled={isSubmitting}
                    className="flex items-start gap-2 py-2 px-2.5 w-full cursor-pointer text-left bg-transparent disabled:cursor-not-allowed"
                  >
                    <div className={`w-4 h-4 mt-0.5 shrink-0 border rounded-sm flex items-center justify-center transition-colors ${
                      otherSelected[question.question]
                        ? 'bg-nim-primary border-nim-primary text-nim-on-primary'
                        : 'bg-nim border-nim text-nim-primary'
                    }`}>
                      {otherSelected[question.question] && (
                        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg">
                          <path d="M8.5 2.5L3.75 7.25L1.5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                      )}
                    </div>
                    <span className="text-[0.8125rem] font-medium text-nim leading-snug">Other</span>
                  </button>
                  {otherSelected[question.question] && (
                    <div className="px-2.5 pb-2">
                      <textarea
                        ref={(el) => { otherInputRefs.current[question.question] = el; }}
                        data-testid="ask-user-question-other-input"
                        value={otherText[question.question] || ''}
                        onChange={(e) => handleOtherTextChange(question.question, e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.shiftKey && allAnswered) {
                            e.preventDefault();
                            handleSubmit();
                          }
                        }}
                        placeholder="Type your answer..."
                        disabled={isSubmitting}
                        rows={2}
                        className="w-full px-2.5 py-2 rounded border border-nim bg-nim text-sm text-nim placeholder-nim-faint resize-y focus:outline-none focus:border-nim-primary disabled:opacity-50"
                      />
                    </div>
                  )}
                </div>
              </WidgetOptionList>
            </WidgetBlock>
          );
        })}

        {/* Action buttons */}
        <WidgetFooter>
          <WidgetActionButton
            variant="secondary"
            testId="ask-user-question-cancel"
            onClick={handleCancel}
            disabled={isSubmitting || !host}
          >
            Cancel
          </WidgetActionButton>
          <WidgetActionButton
            variant="primary"
            testId="ask-user-question-submit"
            onClick={handleSubmit}
            disabled={!allAnswered || isSubmitting || !host}
          >
            {isSubmitting ? 'Submitting...' : 'Submit'}
          </WidgetActionButton>
        </WidgetFooter>
      </InteractiveWidgetBody>
    </InteractiveWidgetCard>
  );
};
