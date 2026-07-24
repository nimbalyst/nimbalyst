/**
 * SuperLoopProgressWidget - Custom widget for the super_loop_progress_update MCP tool.
 *
 * When Claude calls this tool:
 * - For status 'running' or 'completed': shows a compact read-only progress summary
 * - For status 'blocked': shows an interactive feedback UI with textarea
 *
 * Uses InteractiveWidgetHost for the blocked feedback flow.
 */

import React, { useState, useCallback } from 'react';
import { useAtomValue } from 'jotai';
// Deep import, NOT the runtime barrel ('../../../..' resolves to
// runtime/src/index.ts). The barrel re-exports ai/models.ts, which value-imports
// the Anthropic SDK and drags node-only agent-toolset into the iOS transcript
// browser bundle, breaking the build. Match the sibling widgets' deep path.
import { MaterialSymbol } from '../../../icons/MaterialSymbol';
import type { CustomToolWidgetProps } from './index';
import { interactiveWidgetHostAtom } from '../../../../store/atoms/interactiveWidgetHost';

interface ProgressUpdateArgs {
  phase: 'planning' | 'building';
  status: 'running' | 'completed' | 'blocked';
  completionSignal: boolean;
  learnings: Array<{ iteration: number; summary: string; filesChanged: string[] }>;
  blockers: string[];
  currentIteration: number;
}

const PHASE_COLORS: Record<string, { bg: string; text: string }> = {
  planning: { bg: 'rgba(168,85,247,0.15)', text: '#c084fc' },
  building: { bg: 'rgba(59,130,246,0.15)', text: 'var(--nim-primary)' },
};

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  running: { bg: 'rgba(59,130,246,0.15)', text: 'var(--nim-primary)' },
  completed: { bg: 'rgba(74,222,128,0.15)', text: '#4ade80' },
  blocked: { bg: 'rgba(249,115,22,0.15)', text: '#f97316' },
};

// ============================================================
// Badge Component (matches SuperProgressSnapshotWidget)
// ============================================================

const Badge: React.FC<{ label: string; bg: string; color: string }> = ({ label, bg, color }) => (
  <span
    style={{
      fontSize: '9px',
      padding: '1px 6px',
      borderRadius: '10px',
      fontWeight: 500,
      background: bg,
      color,
    }}
  >
    {label}
  </span>
);

// ============================================================
// Read-Only Progress Card
// ============================================================

const ReadOnlyProgressCard: React.FC<{ args: ProgressUpdateArgs }> = ({ args }) => {
  const phaseStyle = PHASE_COLORS[args.phase] ?? { bg: 'rgba(156,163,175,0.15)', text: 'var(--nim-text-faint)' };
  const statusStyle = STATUS_COLORS[args.status] ?? { bg: 'rgba(156,163,175,0.15)', text: 'var(--nim-text-faint)' };

  return (
    <div
      style={{
        border: '1px solid var(--nim-border)',
        borderRadius: '6px',
        overflow: 'hidden',
        fontSize: '11px',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '6px 10px',
          background: 'var(--nim-bg-tertiary)',
          borderBottom: '1px solid var(--nim-border)',
        }}
      >
        <span style={{ fontWeight: 600, color: 'var(--nim-text)' }}>
          Progress Update
        </span>
        <Badge label={args.phase} bg={phaseStyle.bg} color={phaseStyle.text} />
        <Badge label={args.status} bg={statusStyle.bg} color={statusStyle.text} />
        {args.completionSignal && (
          <Badge label="complete" bg="rgba(74,222,128,0.15)" color="#4ade80" />
        )}
        <span
          style={{
            marginLeft: 'auto',
            fontSize: '10px',
            color: 'var(--nim-text-faint)',
            fontFamily: 'monospace',
          }}
        >
          iter {args.currentIteration}
        </span>
      </div>

      {/* Body */}
      <div style={{ padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
        {/* Latest learning */}
        {args.learnings.length > 0 && (
          <div style={{ fontSize: '10px', color: 'var(--nim-text)', lineHeight: 1.4 }}>
            {args.learnings[args.learnings.length - 1].summary}
          </div>
        )}
        {args.learnings.length === 0 && (
          <span style={{ fontSize: '10px', color: 'var(--nim-text-faint)', fontStyle: 'italic' }}>
            No learnings recorded
          </span>
        )}
      </div>
    </div>
  );
};

// ============================================================
// Blocked Feedback Card
// ============================================================

const BlockedFeedbackCard: React.FC<{ args: ProgressUpdateArgs; sessionId: string }> = ({ args, sessionId }) => {
  const host = useAtomValue(interactiveWidgetHostAtom(sessionId));

  const [feedback, setFeedback] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [hasSubmitted, setHasSubmitted] = useState(false);
  const [submittedFeedback, setSubmittedFeedback] = useState('');
  const [submitError, setSubmitError] = useState<string | null>(null);

  const handleSubmit = useCallback(async () => {
    if (!feedback.trim() || !host || isSubmitting) return;

    setIsSubmitting(true);
    setSubmitError(null);

    try {
      const result = await host.superLoopBlockedFeedback(feedback.trim());
      if (result.success) {
        setHasSubmitted(true);
        setSubmittedFeedback(feedback.trim());
      } else {
        setSubmitError(result.error || 'Failed to send feedback');
      }
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'Failed to send feedback');
    } finally {
      setIsSubmitting(false);
    }
  }, [feedback, host, isSubmitting]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSubmit();
    }
  }, [handleSubmit]);

  const phaseStyle = PHASE_COLORS[args.phase] ?? { bg: 'rgba(156,163,175,0.15)', text: 'var(--nim-text-faint)' };

  return (
    <div
      style={{
        border: '1px solid rgba(249,115,22,0.4)',
        borderRadius: '6px',
        overflow: 'hidden',
        fontSize: '11px',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '6px 10px',
          background: 'var(--nim-bg-tertiary)',
          borderBottom: '1px solid rgba(249,115,22,0.4)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', color: '#f97316', animation: 'pulse 2s cubic-bezier(0.4,0,0.6,1) infinite' }}>
          <MaterialSymbol icon="help" size={14} />
        </div>
        <span style={{ fontWeight: 600, color: '#f97316' }}>
          Blocked
        </span>
        <Badge label={args.phase} bg={phaseStyle.bg} color={phaseStyle.text} />
        <span
          style={{
            marginLeft: 'auto',
            fontSize: '10px',
            color: 'var(--nim-text-faint)',
            fontFamily: 'monospace',
          }}
        >
          iter {args.currentIteration}
        </span>
      </div>

      {/* Body */}
      <div style={{ padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {/* Blockers */}
        {args.blockers.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
            {args.blockers.map((blocker, i) => (
              <div
                key={i}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: '6px',
                  fontSize: '10px',
                  color: '#f97316',
                }}
              >
                <span style={{ flexShrink: 0 }}>&#9888;</span>
                <span>{blocker}</span>
              </div>
            ))}
          </div>
        )}

        {/* Latest learning for context */}
        {args.learnings.length > 0 && (
          <div style={{ fontSize: '10px', color: 'var(--nim-text-muted)', lineHeight: 1.4 }}>
            {args.learnings[args.learnings.length - 1].summary}
          </div>
        )}

        {/* Submitted state */}
        {hasSubmitted ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#4ade80', fontSize: '10px' }}>
              <MaterialSymbol icon="check_circle" size={14} />
              <span style={{ fontWeight: 500 }}>Feedback sent</span>
            </div>
            <div
              style={{
                fontSize: '10px',
                color: 'var(--nim-text)',
                padding: '6px 8px',
                background: 'var(--nim-bg-tertiary)',
                borderRadius: '4px',
                lineHeight: 1.4,
                whiteSpace: 'pre-wrap',
              }}
            >
              {submittedFeedback}
            </div>
          </div>
        ) : (
          /* Interactive feedback form */
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <textarea
              style={{
                width: '100%',
                padding: '6px 8px',
                fontSize: '11px',
                background: 'var(--nim-bg)',
                border: '1px solid var(--nim-border)',
                borderRadius: '4px',
                resize: 'none',
                color: 'var(--nim-text)',
                fontFamily: 'inherit',
                lineHeight: 1.4,
                outline: 'none',
              }}
              rows={3}
              placeholder="Provide guidance to help overcome the blockers..."
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={isSubmitting || !host}
            />

            {submitError && (
              <div style={{ fontSize: '10px', color: 'var(--nim-error, #ef4444)' }}>
                {submitError}
              </div>
            )}

            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <button
                style={{
                  padding: '4px 12px',
                  fontSize: '11px',
                  fontWeight: 500,
                  background: 'var(--nim-primary)',
                  color: 'white',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: (!feedback.trim() || isSubmitting || !host) ? 'not-allowed' : 'pointer',
                  opacity: (!feedback.trim() || isSubmitting || !host) ? 0.5 : 1,
                }}
                onClick={handleSubmit}
                disabled={!feedback.trim() || isSubmitting || !host}
              >
                {isSubmitting ? 'Sending...' : 'Send Feedback'}
              </button>
              {!host && (
                <span style={{ fontSize: '10px', color: 'var(--nim-text-faint)', fontStyle: 'italic' }}>
                  Waiting for session...
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

// ============================================================
// Main Widget
// ============================================================

export const SuperLoopProgressWidget: React.FC<CustomToolWidgetProps> = ({ message, sessionId }) => {
  const tool = message.toolCall;
  if (!tool?.arguments) return null;

  const args = tool.arguments as unknown as ProgressUpdateArgs;
  if (!args.status) return null;

  if (args.status === 'blocked') {
    return <BlockedFeedbackCard args={args} sessionId={sessionId} />;
  }

  return <ReadOnlyProgressCard args={args} />;
};

SuperLoopProgressWidget.displayName = 'SuperLoopProgressWidget';
