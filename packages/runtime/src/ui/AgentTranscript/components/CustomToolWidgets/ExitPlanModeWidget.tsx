/**
 * ExitPlanModeWidget
 *
 * Custom tool widget that renders when Claude calls ExitPlanMode.
 * Shows the plan file path and allows user to approve/deny the exit from planning mode.
 *
 * Uses InteractiveWidgetHost for operations that require access to atoms, callbacks, and analytics.
 * The host is read from interactiveWidgetHostAtom(sessionId) - no prop drilling needed.
 */

import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useAtomValue } from 'jotai';
import type { CustomToolWidgetProps } from './index';
import { interactiveWidgetHostAtom } from '../../../../store/atoms/interactiveWidgetHost';

// ============================================================
// Types
// ============================================================

interface ExitPlanModeArgs {
  planFilePath?: string;
  allowedPrompts?: Array<{ tool: string; prompt: string }>;
}

// ============================================================
// Widget Component
// ============================================================

export const ExitPlanModeWidget: React.FC<CustomToolWidgetProps> = ({
  message,
  workspacePath,
  sessionId,
}) => {
  const toolCall = message.toolCall;
  if (!toolCall) {
    return null;
  }

  // Get host from atom (set by SessionTranscript)
  const host = useAtomValue(interactiveWidgetHostAtom(sessionId));

  // Get data from tool call arguments
  const args = toolCall.arguments as ExitPlanModeArgs | undefined;
  const planFilePath = args?.planFilePath || '';

  // Parse the tool result
  const toolResult = toolCall.result ?? '';
  const isCompleted = toolResult !== '';

  // The requestId is the tool call ID
  const requestId = toolCall.providerToolCallId || `exit-plan-${Date.now()}`;

  // Widget is interactive if the tool hasn't completed yet
  const isPending = !isCompleted;

  // Local state for UI
  const [showFeedbackInput, setShowFeedbackInput] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [hasResponded, setHasResponded] = useState(false);
  const [localResult, setLocalResult] = useState<{
    approved: boolean;
    feedback?: string;
    startNewSession?: boolean;
  } | null>(null);
  const feedbackInputRef = useRef<HTMLTextAreaElement>(null);

  // Focus feedback input when shown
  useEffect(() => {
    if (showFeedbackInput && feedbackInputRef.current) {
      feedbackInputRef.current.focus();
    }
  }, [showFeedbackInput]);

  // Parse completed state from result
  const completedState = useMemo(() => {
    if (!isCompleted || !toolResult) return null;

    const resultLower = toolResult.toLowerCase();

    // Check for error patterns first - don't show as completed, return null to keep interactive UI
    if (resultLower.includes('error') || resultLower.includes('missing') || resultLower.includes('invalid')) {
      return null;
    }

    // Check for denial patterns
    if (resultLower.includes('denied') || resultLower.includes('continue planning') || resultLower.includes('cancelled')) {
      return { type: 'denied' as const };
    }

    // Check for approval patterns
    // Note: We can't reliably distinguish user-initiated approval from SDK timeout
    // based solely on the tool result text. Both produce similar messages.
    // TODO: To detect timeouts, we'd need to check if there's an exit_plan_mode_response
    // message in the transcript (which we persist when user responds via IPC).
    // For now, treat all approvals the same - the agent proceeded either way.
    if (resultLower.includes('approved') || resultLower.includes('exited planning')) {
      return { type: 'approved' as const };
    }

    // Unknown result - don't default to approved, return null to keep interactive
    return null;
  }, [isCompleted, toolResult]);

  // Determine display result (local takes precedence while waiting for tool to complete)
  const displayResult = localResult || (completedState ? {
    approved: completedState.type === 'approved',
  } : null);

  // Handle approve
  const handleApprove = useCallback(async () => {
    if (hasResponded || !isPending || !host) return;

    setIsSubmitting(true);
    setLocalResult({ approved: true });
    setHasResponded(true);

    try {
      await host.exitPlanModeApprove(requestId);
    } catch (error) {
      console.error('[ExitPlanModeWidget] Failed to approve:', error);
      setLocalResult(null);
      setHasResponded(false);
    } finally {
      setIsSubmitting(false);
    }
  }, [host, requestId, hasResponded, isPending]);

  // Handle start new session
  const handleStartNewSession = useCallback(async () => {
    if (hasResponded || !isPending || !host) return;

    setIsSubmitting(true);
    // Match the "Stop for now" end state in the original session while
    // the replacement session opens with the implementation prompt.
    setLocalResult({ approved: false, startNewSession: true });
    setHasResponded(true);

    try {
      await host.exitPlanModeStartNewSession(requestId, planFilePath);
    } catch (error) {
      console.error('[ExitPlanModeWidget] Failed to start new session:', error);
      setLocalResult(null);
      setHasResponded(false);
    } finally {
      setIsSubmitting(false);
    }
  }, [host, requestId, planFilePath, hasResponded, isPending]);

  // Handle deny with feedback
  const handleDeny = useCallback(async (feedbackText?: string) => {
    if (hasResponded || !isPending || !host) return;

    setIsSubmitting(true);
    setLocalResult({ approved: false, feedback: feedbackText });
    setHasResponded(true);

    try {
      await host.exitPlanModeDeny(requestId, feedbackText);
    } catch (error) {
      console.error('[ExitPlanModeWidget] Failed to deny:', error);
      setLocalResult(null);
      setHasResponded(false);
    } finally {
      setIsSubmitting(false);
    }
  }, [host, requestId, hasResponded, isPending]);

  // Handle cancel (stop the session)
  const handleCancel = useCallback(async () => {
    if (hasResponded || !isPending || !host) return;

    setIsSubmitting(true);
    setLocalResult({ approved: false });
    setHasResponded(true);

    try {
      await host.exitPlanModeCancel(requestId);
    } catch (error) {
      console.error('[ExitPlanModeWidget] Failed to cancel:', error);
    } finally {
      setIsSubmitting(false);
    }
  }, [host, requestId, hasResponded, isPending]);

  const handleShowFeedbackInput = useCallback(() => {
    setShowFeedbackInput(true);
  }, []);

  const handleSubmitFeedback = useCallback(() => {
    if (feedback.trim()) {
      handleDeny(feedback.trim());
    }
  }, [feedback, handleDeny]);

  const handleFeedbackKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmitFeedback();
    } else if (e.key === 'Escape') {
      setShowFeedbackInput(false);
      setFeedback('');
    }
  }, [handleSubmitFeedback]);

  const handleOpenPlanFile = useCallback(() => {
    if (!planFilePath || !workspacePath) return;

    // Check if path is already absolute (works for both Unix and Windows)
    const isAbsolute = planFilePath.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(planFilePath);

    // If path is relative but we don't have a workspacePath, we can't resolve it
    if (!isAbsolute && !workspacePath) {
      console.warn('[ExitPlanModeWidget] Cannot resolve relative path without workspacePath:', planFilePath);
      return;
    }

    // Detect path separator from workspacePath (works cross-platform)
    const separator = workspacePath?.includes('\\') ? '\\' : '/';

    const absolutePath = isAbsolute
      ? planFilePath
      : `${workspacePath}${separator}${planFilePath}`;

    if (host) {
      host.openFile(absolutePath);
    }
  }, [planFilePath, workspacePath, host]);

  // Show completed state
  if (displayResult || hasResponded) {
    const approved = displayResult?.approved ?? false;

    return (
      <div
        data-testid="exit-plan-mode-widget"
        data-state={approved ? 'approved' : 'denied'}
        className={`exit-plan-mode-widget rounded-lg border overflow-hidden opacity-85 ${
          approved ? 'bg-nim-secondary border-nim-success' : 'bg-nim-secondary border-nim'
        }`}
      >
        <div className="flex items-center gap-2 py-3 px-4 bg-nim-tertiary">
          <div className={`w-5 h-5 shrink-0 ${approved ? 'text-nim-success' : 'text-nim-muted'}`}>
            {approved ? (
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-full h-full">
                <path d="M13 4L6 11L3 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-full h-full">
                <path d="M12 4L4 12M4 4l8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            )}
          </div>
          <span className="text-sm font-semibold text-nim flex-1">
            {approved ? 'Exited Planning Mode' : 'Continued Planning'}
          </span>
          <span
            data-testid={approved ? 'exit-plan-mode-approved' : 'exit-plan-mode-denied'}
            className={`flex items-center gap-1 text-xs font-medium py-1 px-2 rounded-full ${
              approved ? 'text-nim-success bg-[color-mix(in_srgb,var(--nim-success)_12%,transparent)]' : 'text-nim-muted bg-nim-tertiary'
            }`}
          >
            {approved ? 'Approved' : 'Denied'}
          </span>
        </div>
        {planFilePath && (
          <div className="px-4 py-2 text-[13px] text-nim-muted">
            Plan: <button
              onClick={handleOpenPlanFile}
              className="text-nim-link hover:text-nim-link-hover hover:underline cursor-pointer bg-transparent border-none p-0 font-mono text-[13px]"
            >
              {planFilePath}
            </button>
          </div>
        )}
      </div>
    );
  }

  // If tool is not pending (has a result) but we didn't handle it above, show nothing
  if (!isPending) {
    return null;
  }

  // If no host available, show non-interactive pending state
  if (!host) {
    return (
      <div
        data-testid="exit-plan-mode-widget"
        data-state="pending"
        className="exit-plan-mode-widget rounded-lg bg-nim-secondary border border-nim-primary overflow-hidden"
      >
        <div className="flex items-center gap-2 py-3 px-4 bg-nim-tertiary">
          <div className="w-5 h-5 text-nim-primary shrink-0">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 1a7 7 0 100 14A7 7 0 008 1zm0 12.5a5.5 5.5 0 110-11 5.5 5.5 0 010 11z"/>
              <path d="M8 4a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 018 4zm0 6a1 1 0 100 2 1 1 0 000-2z"/>
            </svg>
          </div>
          <span className="text-sm font-semibold text-nim flex-1">
            Ready to exit planning mode?
          </span>
          <span data-testid="exit-plan-mode-pending" className="text-xs text-nim-muted">Waiting...</span>
        </div>
      </div>
    );
  }

  // Show interactive UI for pending request
  return (
    <div
      data-testid="exit-plan-mode-widget"
      data-state="pending"
      className="exit-plan-mode-widget rounded-lg bg-nim-secondary border border-nim-primary overflow-hidden"
    >
      <div className="flex items-center gap-2 py-3 px-4 border-b border-nim bg-nim-tertiary">
        <div className="w-5 h-5 text-nim-primary shrink-0">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 1a7 7 0 100 14A7 7 0 008 1zm0 12.5a5.5 5.5 0 110-11 5.5 5.5 0 010 11z"/>
            <path d="M8 4a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 018 4zm0 6a1 1 0 100 2 1 1 0 000-2z"/>
          </svg>
        </div>
        <span className="text-sm font-semibold text-nim flex-1">
          Ready to exit planning mode?
        </span>
      </div>

      <div className="p-4">
        {planFilePath && (
          <div className="mb-3 p-2 bg-nim-tertiary rounded-md text-[13px]">
            <span className="text-nim-muted">Plan file: </span>
            <button
              onClick={handleOpenPlanFile}
              className="text-nim-link hover:text-nim-link-hover hover:underline cursor-pointer bg-transparent border-none p-0 font-mono text-[13px]"
            >
              {planFilePath}
            </button>
          </div>
        )}

        <div className="mb-3 text-[13px] text-nim">
          Would you like to proceed?
        </div>

        <div className="flex flex-col gap-2">
          <button
            data-testid="exit-plan-mode-new-session"
            className="w-full px-4 py-2 rounded-md text-[13px] font-medium cursor-pointer border border-nim transition-colors duration-150 hover:bg-nim-hover active:opacity-80 bg-nim-tertiary text-nim text-left disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={handleStartNewSession}
            disabled={isSubmitting}
          >
            <span className="text-nim-muted mr-2">1.</span>
            Yes, start new session and implement (clean context window)
          </button>
          <button
            data-testid="exit-plan-mode-approve"
            className="w-full px-4 py-2 rounded-md text-[13px] font-medium cursor-pointer border border-nim transition-colors duration-150 hover:bg-nim-hover active:opacity-80 bg-nim-tertiary text-nim text-left disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={handleApprove}
            disabled={isSubmitting}
          >
            <span className="text-nim-muted mr-2">2.</span>
            Yes, proceed in this same session
          </button>
          {!showFeedbackInput ? (
            <button
              data-testid="exit-plan-mode-deny"
              className="w-full px-4 py-2 rounded-md text-[13px] font-medium cursor-pointer border border-nim transition-colors duration-150 hover:bg-nim-hover active:opacity-80 bg-nim-tertiary text-nim text-left disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={handleShowFeedbackInput}
              disabled={isSubmitting}
            >
              <span className="text-nim-muted mr-2">3.</span>
              Type here to tell Claude what to change
            </button>
          ) : (
            <div className="flex flex-col gap-2">
              <textarea
                ref={feedbackInputRef}
                data-testid="exit-plan-mode-feedback-input"
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                onKeyDown={handleFeedbackKeyDown}
                placeholder="Tell Claude what to change in the plan..."
                className="w-full px-3 py-2 rounded-md text-[13px] border border-nim bg-nim-tertiary text-nim placeholder:text-nim-muted resize-none focus:outline-none focus:border-nim-focus"
                rows={3}
                disabled={isSubmitting}
              />
              <div className="flex gap-2 justify-end">
                <button
                  className="px-3 py-1 rounded-md text-[12px] cursor-pointer border border-nim transition-colors duration-150 hover:bg-nim-hover bg-nim-tertiary text-nim-muted disabled:opacity-50 disabled:cursor-not-allowed"
                  onClick={() => {
                    setShowFeedbackInput(false);
                    setFeedback('');
                  }}
                  disabled={isSubmitting}
                >
                  Cancel
                </button>
                <button
                  data-testid="exit-plan-mode-send-feedback"
                  className="px-3 py-1 rounded-md text-[12px] cursor-pointer border-none transition-colors duration-150 hover:opacity-90 bg-nim-primary text-nim-on-primary disabled:opacity-50 disabled:cursor-not-allowed"
                  onClick={handleSubmitFeedback}
                  disabled={!feedback.trim() || isSubmitting}
                >
                  Send Feedback
                </button>
              </div>
            </div>
          )}
          <button
            data-testid="exit-plan-mode-cancel"
            className="w-full px-4 py-2 rounded-md text-[13px] font-medium cursor-pointer border border-nim transition-colors duration-150 hover:bg-nim-hover active:opacity-80 bg-nim-tertiary text-nim text-left disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={handleCancel}
            disabled={isSubmitting}
          >
            <span className="text-nim-muted mr-2">4.</span>
            Stop for now
          </button>
        </div>
      </div>
    </div>
  );
};
