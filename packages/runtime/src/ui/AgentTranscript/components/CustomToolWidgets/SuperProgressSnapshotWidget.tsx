/**
 * SuperProgressSnapshotWidget - Displays a progress.json snapshot in the chat transcript.
 *
 * Injected by SuperLoopService at the start and end of each Super Loop iteration.
 * Shows formatted progress data (phase, status, learnings, blockers) with collapsible raw JSON.
 */

import React, { useState } from 'react';
import type { CustomToolWidgetProps } from './index';

interface ProgressSnapshot {
  timing: 'iteration-start' | 'iteration-end';
  iterationNumber: number;
  superLoopId: string;
  progress: {
    currentIteration: number;
    phase: string;
    status: string;
    completionSignal: boolean;
    learnings: Array<{ iteration: number; summary: string; filesChanged: string[] }>;
    blockers: string[];
    userFeedback?: string;
  };
  capturedAt: number;
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

export const SuperProgressSnapshotWidget: React.FC<CustomToolWidgetProps> = ({ message }) => {
  const [showRawJson, setShowRawJson] = useState(false);
  const tool = message.toolCall;
  if (!tool?.arguments) return null;

  const snapshot = tool.arguments as unknown as ProgressSnapshot;
  const { timing, iterationNumber, progress } = snapshot;

  if (!progress) return null;

  const isStart = timing === 'iteration-start';
  const timingLabel = isStart ? 'Iteration Start' : 'Iteration End';
  const timingIcon = isStart ? '\u25B6' : '\u25A0'; // play / stop symbols

  const phaseStyle = PHASE_COLORS[progress.phase] ?? { bg: 'rgba(156,163,175,0.15)', text: 'var(--nim-text-faint)' };
  const statusStyle = STATUS_COLORS[progress.status] ?? { bg: 'rgba(156,163,175,0.15)', text: 'var(--nim-text-faint)' };

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
        <span style={{ fontSize: '10px', opacity: 0.6 }}>{timingIcon}</span>
        <span style={{ fontWeight: 600, color: 'var(--nim-text)' }}>
          {timingLabel} #{iterationNumber}
        </span>
        <Badge label={progress.phase} bg={phaseStyle.bg} color={phaseStyle.text} />
        <Badge label={progress.status} bg={statusStyle.bg} color={statusStyle.text} />
        {progress.completionSignal && (
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
          iter {progress.currentIteration}
        </span>
      </div>

      {/* Body */}
      <div style={{ padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
        {/* User feedback */}
        {progress.userFeedback && (
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: '6px', fontSize: '10px' }}>
            <span style={{ color: 'var(--nim-primary)', flexShrink: 0 }}>feedback:</span>
            <span style={{ color: 'var(--nim-text)' }}>{progress.userFeedback}</span>
          </div>
        )}

        {/* Blockers */}
        {progress.blockers.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
            {progress.blockers.map((blocker, i) => (
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

        {/* Learnings */}
        {progress.learnings.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
            <span style={{ fontSize: '10px', fontWeight: 500, color: 'var(--nim-text-muted)' }}>
              Learnings ({progress.learnings.length})
            </span>
            {progress.learnings.map((learning, i) => (
              <div
                key={i}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: '6px',
                  fontSize: '10px',
                  color: 'var(--nim-text)',
                  lineHeight: 1.4,
                }}
              >
                <span
                  style={{
                    color: 'var(--nim-text-faint)',
                    fontFamily: 'monospace',
                    flexShrink: 0,
                  }}
                >
                  #{learning.iteration}
                </span>
                <span style={{ wordBreak: 'break-word' }}>{learning.summary}</span>
              </div>
            ))}
          </div>
        )}

        {/* No data indicator when empty */}
        {progress.blockers.length === 0 && progress.learnings.length === 0 && !progress.userFeedback && (
          <span style={{ fontSize: '10px', color: 'var(--nim-text-faint)', fontStyle: 'italic' }}>
            No learnings or blockers recorded yet
          </span>
        )}

        {/* Raw JSON toggle */}
        <button
          onClick={() => setShowRawJson(!showRawJson)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: '2px 0',
            fontSize: '10px',
            color: 'var(--nim-text-muted)',
          }}
        >
          <span style={{ fontSize: '8px' }}>{showRawJson ? '\u25BC' : '\u25B6'}</span>
          Raw JSON
        </button>
        {showRawJson && (
          <pre
            style={{
              margin: 0,
              padding: '8px',
              background: 'var(--nim-bg-tertiary)',
              border: '1px solid var(--nim-border)',
              borderRadius: '4px',
              fontSize: '10px',
              lineHeight: 1.5,
              color: 'var(--nim-text-muted)',
              overflow: 'auto',
              maxHeight: '200px',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {JSON.stringify(progress, null, 2)}
          </pre>
        )}
      </div>
    </div>
  );
};

SuperProgressSnapshotWidget.displayName = 'SuperProgressSnapshotWidget';

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
