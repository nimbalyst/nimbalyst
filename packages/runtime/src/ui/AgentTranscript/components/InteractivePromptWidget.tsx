/**
 * Interactive Prompt Widget
 *
 * Renders interactive permission requests and ask user question prompts
 * directly in the transcript. These are persisted as special messages
 * and can be responded to from any device (desktop or mobile).
 *
 * This component handles:
 * - Permission requests (tool approval prompts)
 * - Ask user question requests
 * - Showing pending/resolved state
 * - Submitting responses that sync to the provider
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import type {
  PermissionRequestContent,
  PermissionResponseContent,
  AskUserQuestionRequestContent,
  AskUserQuestionResponseContent,
} from '../../../ai/server/types';
import { unwrapShellCommand } from '../utils/unwrapShellCommand';

// Inject interactive prompt styles once (for animations and color-mix patterns)
const injectInteractivePromptStyles = () => {
  const styleId = 'interactive-prompt-widget-styles';
  if (document.getElementById(styleId)) return;

  const style = document.createElement('style');
  style.id = styleId;
  style.textContent = `
    @keyframes interactive-prompt-pulse {
      0%, 100% {
        box-shadow: 0 0 0 0 rgba(59, 130, 246, 0.3);
      }
      50% {
        box-shadow: 0 0 0 4px rgba(59, 130, 246, 0.1);
      }
    }
    .interactive-prompt--pending {
      animation: interactive-prompt-pulse 2s ease-in-out infinite;
    }
    .interactive-prompt__option--selected {
      background: rgba(59, 130, 246, 0.1);
    }
  `;
  document.head.appendChild(style);
};

// Initialize styles on module load
if (typeof document !== 'undefined') {
  injectInteractivePromptStyles();
}

// ============================================================================
// Types
// ============================================================================

export interface InteractivePromptWidgetProps {
  /** The type of prompt */
  promptType: 'permission_request' | 'ask_user_question_request';
  /** The parsed prompt content */
  content: PermissionRequestContent | AskUserQuestionRequestContent;
  /** Callback when user submits a response */
  onSubmitResponse: (response: PermissionResponseContent | AskUserQuestionResponseContent) => void;
  /** Callback when user cancels a question (optional, only used for ask_user_question) */
  onCancelQuestion?: (response: AskUserQuestionResponseContent) => void;
  /** Whether this is being rendered on mobile */
  isMobile?: boolean;
  /** Whether the prompt is being submitted */
  isSubmitting?: boolean;
}

// ============================================================================
// Permission Request Widget
// ============================================================================

interface PermissionRequestWidgetProps {
  content: PermissionRequestContent;
  onSubmit: (decision: 'allow' | 'deny', scope: 'once' | 'session' | 'always') => void;
  isSubmitting?: boolean;
}

const PermissionRequestWidget: React.FC<PermissionRequestWidgetProps> = ({
  content,
  onSubmit,
  isSubmitting,
}) => {
  const [showDetails, setShowDetails] = useState(false);

  if (content.status !== 'pending') {
    return (
      <div className="interactive-prompt interactive-prompt--resolved bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] rounded-lg p-3 my-2 opacity-70">
        <div className="interactive-prompt__header flex items-center gap-2 mb-2">
          <span className="interactive-prompt__icon interactive-prompt__icon--resolved flex items-center justify-center w-5 h-5 shrink-0 text-[var(--nim-success)]">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M13 4L6 11L3 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </span>
          <span className="interactive-prompt__title font-semibold text-sm text-[var(--nim-text)]">Permission Resolved</span>
        </div>
        <div className="interactive-prompt__command bg-[var(--nim-bg-tertiary)] rounded p-2 px-3 mb-3 overflow-x-auto">
          <code className="font-mono text-xs text-[var(--nim-text)] whitespace-pre-wrap break-all">{unwrapShellCommand(content.rawCommand || content.toolName)}</code>
        </div>
      </div>
    );
  }

  return (
    <div className={`interactive-prompt interactive-prompt--pending bg-[var(--nim-bg-secondary)] border rounded-lg p-3 my-2 ${content.isDestructive ? 'interactive-prompt--destructive border-[var(--nim-error)]' : 'border-[var(--nim-primary)]'}`}>
      <div className="interactive-prompt__header flex items-center gap-2 mb-2">
        <span className={`interactive-prompt__icon flex items-center justify-center w-5 h-5 shrink-0 ${content.isDestructive ? 'interactive-prompt__icon--destructive text-[var(--nim-error)]' : 'text-[var(--nim-primary)]'}`}>
          {content.isDestructive ? (
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M8 5.5v3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              <path d="M8 11h.01" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              <path d="M6.86 2.573L1.21 12.15c-.478.813.119 1.85 1.07 1.85h11.44c.951 0 1.548-1.037 1.07-1.85L9.14 2.573c-.477-.812-1.663-.812-2.14 0z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M12.5 7H3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              <path d="M5.5 4L3.5 7l2 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              <rect x="1" y="2" width="14" height="12" rx="2" stroke="currentColor" strokeWidth="1.5"/>
            </svg>
          )}
        </span>
        <span className="interactive-prompt__title font-semibold text-sm text-[var(--nim-text)]">Allow this tool?</span>
        <button
          className="interactive-prompt__details-toggle ml-auto text-xs text-[var(--nim-text-faint)] bg-transparent border-none cursor-pointer py-0.5 px-1.5 rounded hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text-muted)]"
          onClick={() => setShowDetails(!showDetails)}
        >
          {showDetails ? 'Hide details' : 'Show details'}
        </button>
      </div>

      {/* Warnings */}
      {content.warnings && content.warnings.length > 0 && (
        <div className="interactive-prompt__warnings mb-2">
          {content.warnings.map((warning, i) => (
            <div key={i} className="interactive-prompt__warning flex items-start gap-1.5 text-xs text-[var(--nim-warning)] py-1">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" className="shrink-0 mt-px">
                <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5"/>
                <path d="M8 5.5v3M8 11h.01" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
              <span>{warning}</span>
            </div>
          ))}
        </div>
      )}

      {/* Command */}
      <div className="interactive-prompt__command bg-[var(--nim-bg-tertiary)] rounded p-2 px-3 mb-3 overflow-x-auto">
        <code className="font-mono text-xs text-[var(--nim-text)] whitespace-pre-wrap break-all">{unwrapShellCommand(content.rawCommand || content.toolName)}</code>
      </div>

      {/* Details */}
      {showDetails && (
        <div className="interactive-prompt__details bg-[var(--nim-bg-tertiary)] rounded p-2 px-3 mb-3">
          <div className="interactive-prompt__detail-row flex gap-2 text-xs py-0.5">
            <span className="interactive-prompt__detail-label text-[var(--nim-text-faint)] shrink-0">Tool:</span>
            <span className="interactive-prompt__detail-value text-[var(--nim-text-muted)] break-all">{content.toolName}</span>
          </div>
          <div className="interactive-prompt__detail-row flex gap-2 text-xs py-0.5">
            <span className="interactive-prompt__detail-label text-[var(--nim-text-faint)] shrink-0">Pattern:</span>
            <span className="interactive-prompt__detail-value text-[var(--nim-text-muted)] break-all">{content.patternDisplayName}</span>
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="interactive-prompt__actions flex flex-wrap gap-2 mb-2">
        <button
          className="interactive-prompt__button interactive-prompt__button--deny px-3 py-1.5 text-xs font-medium rounded-md border border-[var(--nim-border)] cursor-pointer transition-all bg-[var(--nim-bg-tertiary)] text-[var(--nim-text-muted)] hover:bg-[var(--nim-error)] hover:text-white hover:border-[var(--nim-error)] disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={() => onSubmit('deny', 'once')}
          disabled={isSubmitting}
        >
          Deny
        </button>
        <button
          className="interactive-prompt__button interactive-prompt__button--allow px-3 py-1.5 text-xs font-medium rounded-md border border-transparent cursor-pointer transition-all bg-[var(--nim-primary)] text-white hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={() => onSubmit('allow', 'once')}
          disabled={isSubmitting}
        >
          Allow Once
        </button>
        <div className="interactive-prompt__separator w-px bg-[var(--nim-border)] mx-1" />
        <button
          className="interactive-prompt__button interactive-prompt__button--session px-3 py-1.5 text-xs font-medium rounded-md border border-[var(--nim-border)] cursor-pointer transition-all bg-[var(--nim-bg-tertiary)] text-[var(--nim-text-muted)] hover:bg-[var(--nim-primary)] hover:text-white hover:border-[var(--nim-primary)] disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={() => onSubmit('allow', 'session')}
          disabled={isSubmitting}
          title={`Allow ${content.patternDisplayName} for this session`}
        >
          Session
        </button>
        <button
          className="interactive-prompt__button interactive-prompt__button--always px-3 py-1.5 text-xs font-medium rounded-md border border-[var(--nim-border)] cursor-pointer transition-all bg-[var(--nim-bg-tertiary)] text-[var(--nim-text-muted)] hover:bg-[var(--nim-primary)] hover:text-white hover:border-[var(--nim-primary)] disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={() => onSubmit('allow', 'always')}
          disabled={isSubmitting}
          title={`Save ${content.patternDisplayName} to settings`}
        >
          Always
        </button>
      </div>

      {/* Pattern info */}
      <div className="interactive-prompt__pattern-info text-[11px] text-[var(--nim-text-faint)]">
        Session/Always will allow: <span className="interactive-prompt__pattern-badge inline-block px-1.5 py-0.5 bg-[var(--nim-bg-tertiary)] rounded font-mono text-[10px]">{content.patternDisplayName}</span>
      </div>
    </div>
  );
};

// ============================================================================
// Ask User Question Widget
// ============================================================================

interface AskUserQuestionWidgetProps {
  content: AskUserQuestionRequestContent;
  onSubmit: (answers: Record<string, string>) => void;
  onCancel?: () => void;
  isSubmitting?: boolean;
}

const AskUserQuestionWidgetInteractive: React.FC<AskUserQuestionWidgetProps> = ({
  content,
  onSubmit,
  onCancel,
  isSubmitting,
}) => {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [otherSelected, setOtherSelected] = useState<Record<string, boolean>>({});
  const [otherText, setOtherText] = useState<Record<string, string>>({});
  const otherInputRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});

  const handleOptionSelect = useCallback((questionText: string, optionLabel: string, multiSelect: boolean) => {
    if (!multiSelect) {
      setOtherSelected(prev => ({ ...prev, [questionText]: false }));
    }
    setAnswers(prev => {
      if (multiSelect) {
        const current = prev[questionText] || '';
        const selected = current.split(', ').filter(o => o.trim());
        const newSelected = selected.includes(optionLabel)
          ? selected.filter(o => o !== optionLabel)
          : [...selected, optionLabel];
        return { ...prev, [questionText]: newSelected.join(', ') };
      }
      return { ...prev, [questionText]: optionLabel };
    });
  }, []);

  const handleOtherToggle = useCallback((questionText: string, multiSelect: boolean) => {
    const isCurrentlyOther = otherSelected[questionText];
    if (!multiSelect) {
      setAnswers(prev => ({ ...prev, [questionText]: '' }));
    }
    setOtherSelected(prev => ({ ...prev, [questionText]: !isCurrentlyOther }));
    if (!isCurrentlyOther) {
      setTimeout(() => {
        otherInputRefs.current[questionText]?.focus();
      }, 0);
    }
  }, [otherSelected]);

  const handleSubmit = useCallback(() => {
    // Build final answers incorporating "Other" text
    const finalAnswers: Record<string, string> = {};
    for (const q of content.questions) {
      const key = q.question;
      if (otherSelected[key] && otherText[key]?.trim()) {
        const custom = otherText[key].trim();
        if (q.multiSelect && answers[key]) {
          finalAnswers[key] = [answers[key], custom].join(', ');
        } else {
          finalAnswers[key] = custom;
        }
      } else {
        finalAnswers[key] = answers[key] || '';
      }
    }
    onSubmit(finalAnswers);
  }, [answers, otherSelected, otherText, content.questions, onSubmit]);

  const allAnswered = content.questions.every(q => {
    const hasAnswer = !!answers[q.question];
    const hasOther = otherSelected[q.question] && otherText[q.question]?.trim();
    return hasAnswer || hasOther;
  });

  if (content.status !== 'pending') {
    return (
      <div className="interactive-prompt interactive-prompt--resolved">
        <div className="interactive-prompt__header">
          <span className="interactive-prompt__icon interactive-prompt__icon--resolved">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M13 4L6 11L3 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </span>
          <span className="interactive-prompt__title">Questions Answered</span>
        </div>
      </div>
    );
  }

  return (
    <div className="interactive-prompt interactive-prompt--pending interactive-prompt--question">
      <div className="interactive-prompt__header">
        <span className="interactive-prompt__icon">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5"/>
            <path d="M6.06 6a2 2 0 0 1 3.88.67c0 1.33-2 2-2 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M8 11h.01" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </span>
        <span className="interactive-prompt__title">Claude has questions for you</span>
      </div>

      <div className="interactive-prompt__questions">
        {content.questions.map((question, qIndex) => (
          <div key={qIndex} className="interactive-prompt__question-card">
            <div className="interactive-prompt__question-header">
              <span className="interactive-prompt__question-chip">{question.header}</span>
              {question.multiSelect && (
                <span className="interactive-prompt__multi-hint">Select multiple</span>
              )}
            </div>
            <div className="interactive-prompt__question-text">
              {question.question}
            </div>
            <div className="interactive-prompt__options">
              {question.options.map((option, oIndex) => {
                const currentAnswer = answers[question.question] || '';
                const isSelected = question.multiSelect
                  ? currentAnswer.split(', ').includes(option.label)
                  : currentAnswer === option.label;

                return (
                  <button
                    key={oIndex}
                    className={`interactive-prompt__option ${isSelected ? 'interactive-prompt__option--selected' : ''}`}
                    onClick={() => handleOptionSelect(question.question, option.label, question.multiSelect)}
                    disabled={isSubmitting}
                  >
                    <div className={`interactive-prompt__option-indicator ${isSelected ? 'interactive-prompt__option-indicator--selected' : ''}`}>
                      {isSelected && (
                        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg">
                          <path d="M8.5 2.5L3.75 7.25L1.5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                      )}
                    </div>
                    <div className="interactive-prompt__option-content">
                      <span className="interactive-prompt__option-label">{option.label}</span>
                      {option.description && (
                        <span className="interactive-prompt__option-description">{option.description}</span>
                      )}
                    </div>
                  </button>
                );
              })}
              {/* "Other" option with inline text input */}
              <div className={`interactive-prompt__option ${otherSelected[question.question] ? 'interactive-prompt__option--selected' : ''}`}
                style={{ flexDirection: 'column', alignItems: 'stretch', cursor: 'default' }}
              >
                <button
                  style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', width: '100%', background: 'transparent', border: 'none', cursor: 'pointer', padding: 0, textAlign: 'left' }}
                  onClick={() => handleOtherToggle(question.question, question.multiSelect)}
                  disabled={isSubmitting}
                >
                  <div className={`interactive-prompt__option-indicator ${otherSelected[question.question] ? 'interactive-prompt__option-indicator--selected' : ''}`}>
                    {otherSelected[question.question] && (
                      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M8.5 2.5L3.75 7.25L1.5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    )}
                  </div>
                  <span className="interactive-prompt__option-label">Other</span>
                </button>
                {otherSelected[question.question] && (
                  <textarea
                    ref={(el) => { otherInputRefs.current[question.question] = el; }}
                    value={otherText[question.question] || ''}
                    onChange={(e) => setOtherText(prev => ({ ...prev, [question.question]: e.target.value }))}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey && allAnswered) {
                        e.preventDefault();
                        handleSubmit();
                      }
                    }}
                    placeholder="Type your answer..."
                    disabled={isSubmitting}
                    rows={2}
                    style={{
                      width: '100%',
                      padding: '8px 10px',
                      marginTop: '6px',
                      borderRadius: '4px',
                      border: '1px solid var(--nim-border)',
                      background: 'var(--nim-bg-secondary)',
                      color: 'var(--nim-text)',
                      fontSize: '13px',
                      resize: 'vertical',
                    }}
                  />
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="interactive-prompt__actions interactive-prompt__actions--centered">
        <button
          className="interactive-prompt__button interactive-prompt__button--submit"
          onClick={handleSubmit}
          disabled={isSubmitting || !allAnswered}
        >
          {isSubmitting ? 'Submitting...' : 'Submit Answers'}
        </button>
        {onCancel && (
          <button
            className="interactive-prompt__button interactive-prompt__button--cancel"
            onClick={onCancel}
            disabled={isSubmitting}
          >
            Cancel
          </button>
        )}
      </div>
    </div>
  );
};

// ============================================================================
// Main Widget
// ============================================================================

export const InteractivePromptWidget: React.FC<InteractivePromptWidgetProps> = ({
  promptType,
  content,
  onSubmitResponse,
  onCancelQuestion,
  isMobile = false,
  isSubmitting = false,
}) => {
  const handlePermissionSubmit = useCallback((decision: 'allow' | 'deny', scope: 'once' | 'session' | 'always') => {
    const permissionContent = content as PermissionRequestContent;
    const response: PermissionResponseContent = {
      type: 'permission_response',
      requestId: permissionContent.requestId,
      decision,
      scope,
      respondedAt: Date.now(),
      respondedBy: isMobile ? 'mobile' : 'desktop',
    };
    onSubmitResponse(response);
  }, [content, isMobile, onSubmitResponse]);

  const handleQuestionSubmit = useCallback((answers: Record<string, string>) => {
    const questionContent = content as AskUserQuestionRequestContent;
    const response: AskUserQuestionResponseContent = {
      type: 'ask_user_question_response',
      questionId: questionContent.questionId,
      answers,
      respondedAt: Date.now(),
      respondedBy: isMobile ? 'mobile' : 'desktop',
    };
    onSubmitResponse(response);
  }, [content, isMobile, onSubmitResponse]);

  const handleQuestionCancel = useCallback(() => {
    const questionContent = content as AskUserQuestionRequestContent;
    const response: AskUserQuestionResponseContent = {
      type: 'ask_user_question_response',
      questionId: questionContent.questionId,
      answers: {},
      cancelled: true,
      respondedAt: Date.now(),
      respondedBy: isMobile ? 'mobile' : 'desktop',
    };
    if (onCancelQuestion) {
      onCancelQuestion(response);
    } else {
      // Fall back to submit response with cancelled flag
      onSubmitResponse(response);
    }
  }, [content, isMobile, onCancelQuestion, onSubmitResponse]);

  if (promptType === 'permission_request') {
    return (
      <PermissionRequestWidget
        content={content as PermissionRequestContent}
        onSubmit={handlePermissionSubmit}
        isSubmitting={isSubmitting}
      />
    );
  }

  if (promptType === 'ask_user_question_request') {
    return (
      <AskUserQuestionWidgetInteractive
        content={content as AskUserQuestionRequestContent}
        onSubmit={handleQuestionSubmit}
        onCancel={handleQuestionCancel}
        isSubmitting={isSubmitting}
      />
    );
  }

  return null;
};

export default InteractivePromptWidget;
