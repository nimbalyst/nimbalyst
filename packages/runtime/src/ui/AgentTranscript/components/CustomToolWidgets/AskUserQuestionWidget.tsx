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

function parseQuestions(args: any): Question[] {
  if (!args?.questions || !Array.isArray(args.questions)) {
    return [];
  }
  return args.questions;
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

function parseCancelledResult(result: unknown): boolean {
  if (!result) return false;

  if (typeof result === 'string') {
    try {
      return parseCancelledResult(JSON.parse(result));
    } catch {
      return result.toLowerCase().includes('cancelled') || result.toLowerCase().includes('canceled');
    }
  }

  // Handle MCP content arrays: [{ type: "text", text: "..." }]
  if (Array.isArray(result)) {
    for (const item of result) {
      if (item && typeof item === 'object' && (item as any).type === 'text' && typeof (item as any).text === 'string') {
        if (parseCancelledResult((item as any).text)) return true;
      }
    }
    return false;
  }

  if (typeof result !== 'object') {
    return false;
  }

  const record = result as Record<string, unknown>;
  if (record.cancelled === true || record.canceled === true) {
    return true;
  }

  if (record.result !== undefined && parseCancelledResult(record.result)) {
    return true;
  }

  if (record.content !== undefined && parseCancelledResult(record.content)) {
    return true;
  }

  if (record.text !== undefined && parseCancelledResult(record.text)) {
    return true;
  }

  return false;
}

// ============================================================
// Widget Component
// ============================================================

export const AskUserQuestionWidget: React.FC<CustomToolWidgetProps> = ({
  message,
  sessionId,
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
  const isCancelled = useMemo(() => {
    return parseCancelledResult(rawResult);
  }, [rawResult]);

  const isCompleted = hasResult;
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
  const displayResult = localResult || (isCompleted ? { answers: parsedAnswers, cancelled: isCancelled } : null);
  const displayAnswers = displayResult?.answers || {};
  const displayCancelled = displayResult?.cancelled || false;

  // Check if all questions have selections (for enabling submit button)
  const allAnswered = questions.every(q => {
    const hasSelection = (selections[q.question] || []).length > 0;
    const hasOther = otherSelected[q.question] && otherText[q.question]?.trim();
    return hasSelection || hasOther;
  });

  // Show completed state
  if (displayResult || hasResponded) {
    const statusText = displayCancelled ? 'Question Cancelled' : 'Questions Answered';

    return (
      <div
        data-testid="ask-user-question-widget"
        data-state={displayCancelled ? 'cancelled' : 'completed'}
        className={`ask-user-question-widget rounded-lg bg-nim-secondary border border-nim overflow-hidden opacity-85`}
      >
        <div className="flex items-center gap-2 py-3 px-4 border-b border-nim bg-nim-tertiary">
          <div className="w-5 h-5 text-nim-primary shrink-0">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-full h-full">
              <path d="M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M6.06 6a2 2 0 0 1 3.88.67c0 1.33-2 2-2 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M8 11h.01" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
          <span className="text-sm font-semibold text-nim flex-1">
            {statusText}
          </span>
          {!displayCancelled && (
            <span
              data-testid="ask-user-question-completed"
              className="flex items-center gap-1 text-xs font-medium text-nim-success py-1 px-2 bg-[color-mix(in_srgb,var(--nim-success)_12%,transparent)] rounded-full"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M10 3L4.5 8.5L2 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              Submitted
            </span>
          )}
          {displayCancelled && (
            <span
              data-testid="ask-user-question-cancelled"
              className="flex items-center gap-1 text-xs font-medium text-nim-muted py-1 px-2 bg-nim-tertiary rounded-full"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M9 3L3 9M3 3l6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              Cancelled
            </span>
          )}
        </div>

        <div className="p-3 flex flex-col gap-3">
          {questions.map((question, qIndex) => {
            const answer = displayAnswers[question.question];

            return (
              <div key={qIndex} className="bg-nim border border-nim rounded-md p-3">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-[0.6875rem] font-semibold uppercase tracking-wide text-nim-primary bg-[color-mix(in_srgb,var(--nim-primary)_12%,transparent)] py-0.5 px-2 rounded-full">{question.header}</span>
                  {question.multiSelect && (
                    <span className="text-[0.6875rem] text-nim-faint italic">Multiple selection</span>
                  )}
                </div>
                <div className="text-sm text-nim leading-normal mb-3">
                  {question.question}
                </div>
                <div className="flex flex-col gap-1.5">
                  {question.options.map((option, oIndex) => {
                    const isSelected = question.multiSelect
                      ? (answer?.split(', ') || []).includes(option.label)
                      : answer === option.label;

                    return (
                      <div
                        key={oIndex}
                        className={`flex items-start gap-2 py-2 px-2.5 rounded border cursor-default ${
                          isSelected
                            ? 'border-nim-primary bg-[color-mix(in_srgb,var(--nim-primary)_8%,var(--nim-bg-secondary))]'
                            : 'border-nim bg-nim-secondary'
                        }`}
                      >
                        <div className={`w-4 h-4 mt-0.5 shrink-0 border rounded-sm flex items-center justify-center ${
                          isSelected
                            ? 'bg-nim-primary border-nim-primary text-nim-on-primary'
                            : 'bg-nim border-nim text-nim-primary'
                        }`}>
                          {isSelected && (
                            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg">
                              <path d="M8.5 2.5L3.75 7.25L1.5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                            </svg>
                          )}
                        </div>
                        <div className="flex flex-col gap-0.5 flex-1 min-w-0">
                          <span className="text-[0.8125rem] font-medium text-nim leading-snug">{option.label}</span>
                          {option.description && (
                            <span className="text-xs text-nim-muted leading-snug">{option.description}</span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
                {answer && (
                  <div className="mt-2 pt-2 border-t border-nim text-xs text-nim-muted italic">
                    Selected: {answer}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
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
    <div
      data-testid="ask-user-question-widget"
      data-state="pending"
      className="ask-user-question-widget rounded-lg bg-nim-secondary border border-nim-primary overflow-hidden"
    >
      <div className="flex items-center gap-2 py-3 px-4 border-b border-nim bg-nim-tertiary">
        <div className="w-5 h-5 text-nim-primary shrink-0">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-full h-full">
            <path d="M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M6.06 6a2 2 0 0 1 3.88.67c0 1.33-2 2-2 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M8 11h.01" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>
        <span className="text-sm font-semibold text-nim flex-1">
          Questions from Claude
        </span>
        {!host && (
          <span data-testid="ask-user-question-pending" className="text-xs text-nim-muted">Waiting...</span>
        )}
      </div>

      <div className="p-3 flex flex-col gap-3">
        {questions.map((question, qIndex) => {
          const selectedOptions = selections[question.question] || [];

          return (
            <div key={qIndex} className="bg-nim border border-nim rounded-md p-3">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-[0.6875rem] font-semibold uppercase tracking-wide text-nim-primary bg-[color-mix(in_srgb,var(--nim-primary)_12%,transparent)] py-0.5 px-2 rounded-full">{question.header}</span>
                {question.multiSelect && (
                  <span className="text-[0.6875rem] text-nim-faint italic">Select multiple</span>
                )}
              </div>
              <div className="text-sm text-nim leading-normal mb-3">
                {question.question}
              </div>
              <div className="flex flex-col gap-1.5">
                {question.options.map((option, oIndex) => {
                  const isSelected = selectedOptions.includes(option.label);

                  return (
                    <button
                      key={oIndex}
                      type="button"
                      data-testid="ask-user-question-option"
                      data-option-label={option.label}
                      data-selected={isSelected}
                      onClick={() => handleOptionToggle(question, option.label)}
                      disabled={isSubmitting}
                      className={`flex items-start gap-2 py-2 px-2.5 rounded border transition-all duration-150 cursor-pointer text-left bg-transparent disabled:opacity-50 disabled:cursor-not-allowed ${
                        isSelected
                          ? 'border-nim-primary bg-[color-mix(in_srgb,var(--nim-primary)_8%,var(--nim-bg-secondary))]'
                          : 'border-nim bg-nim-secondary hover:bg-nim-hover'
                      }`}
                    >
                      <div className={`w-4 h-4 mt-0.5 shrink-0 border rounded-sm flex items-center justify-center transition-colors ${
                        isSelected
                          ? 'bg-nim-primary border-nim-primary text-nim-on-primary'
                          : 'bg-nim border-nim text-nim-primary'
                      }`}>
                        {isSelected && (
                          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <path d="M8.5 2.5L3.75 7.25L1.5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                        )}
                      </div>
                      <div className="flex flex-col gap-0.5 flex-1 min-w-0">
                        <span className="text-[0.8125rem] font-medium text-nim leading-snug">{option.label}</span>
                        {option.description && (
                          <span className="text-xs text-nim-muted leading-snug">{option.description}</span>
                        )}
                      </div>
                    </button>
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
              </div>
            </div>
          );
        })}

        {/* Action buttons */}
        <div className="flex gap-2 justify-end pt-2 border-t border-nim">
          <button
            type="button"
            data-testid="ask-user-question-cancel"
            onClick={handleCancel}
            disabled={isSubmitting || !host}
            className="px-3 py-1.5 rounded-md text-[13px] cursor-pointer border border-nim transition-colors duration-150 hover:bg-nim-hover bg-nim-tertiary text-nim-muted disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="ask-user-question-submit"
            onClick={handleSubmit}
            disabled={!allAnswered || isSubmitting || !host}
            className="px-4 py-1.5 rounded-md text-[13px] font-medium cursor-pointer border-none transition-colors duration-150 hover:opacity-90 bg-nim-primary text-nim-on-primary disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isSubmitting ? 'Submitting...' : 'Submit'}
          </button>
        </div>
      </div>
    </div>
  );
};
