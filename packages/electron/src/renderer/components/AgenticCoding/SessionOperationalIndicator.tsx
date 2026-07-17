import React, { memo } from 'react';
import { useAtomValue } from 'jotai';
import { MaterialSymbol } from '@nimbalyst/runtime';
import type { SessionIndicatorState } from '@nimbalyst/runtime';
import { groupIndicatorStateAtom, sessionIndicatorStateAtom } from '../../store';

export type SessionOperationalIndicatorVariant =
  | 'standalone'
  | 'child'
  | 'group'
  | 'dropdown'
  | 'gutter';

export interface SessionOperationalIndicatorProps {
  sessionId: string;
  variant?: SessionOperationalIndicatorVariant;
  className?: string;
}

const PROMPT_TYPE_LABELS: Record<string, string> = {
  ask_user_question_request: 'question',
  exit_plan_mode_request: 'plan approval',
  permission_request: 'tool permission',
  git_commit_proposal_request: 'commit proposal',
  request_user_input_request: 'requested input',
  super_loop_feedback_request: 'loop feedback',
};

function promptTypeLabel(promptType: string): string {
  return PROMPT_TYPE_LABELS[promptType]
    ?? promptType.replace(/_request$/, '').replace(/_/g, ' ');
}

/** Shared visible/accessible wording for row labels, indicators, and tests. */
export function getSessionOperationalLabel(state: SessionIndicatorState): string {
  switch (state.kind) {
    case 'needs-input': {
      const types = Array.from(new Set(state.promptTypes.map(promptTypeLabel)));
      if (state.promptCount === 1 && types.length === 1) {
        return `Waiting for your response: ${types[0]}`;
      }
      const details = types.length > 0 ? ` (${types.join(', ')})` : '';
      return `Waiting for your response: ${state.promptCount} ${state.promptCount === 1 ? 'prompt' : 'prompts'}${details}`;
    }
    case 'error':
      return `${state.message || 'Session error'}. Open to review`;
    case 'working-self':
      return state.hasBackground
        ? `Agent is working with ${state.backgroundCount} background ${state.backgroundCount === 1 ? 'agent' : 'agents'}`
        : 'Agent is working';
    case 'working-child':
      return `${state.childCount} background ${state.childCount === 1 ? 'agent is' : 'agents are'} running`;
    case 'queued':
      return `${state.queuedCount} ${state.queuedCount === 1 ? 'prompt' : 'prompts'} queued`;
    case 'ready':
      return 'New response ready';
    case 'wakeup-attention':
      {
        const status = state.status === 'waiting_for_workspace'
          ? 'waiting for workspace'
          : state.status === 'overdue'
            ? 'overdue'
            : 'needs attention';
        return state.reason ? `Wakeup ${status}: ${state.reason}` : `Wakeup ${status}`;
      }
    case 'scheduled': {
      const time = state.fireAt ? ` at ${new Date(state.fireAt).toLocaleString()}` : '';
      const reason = state.reason ? `: ${state.reason}` : '';
      return `Scheduled wakeup${time}${reason}`;
    }
    case 'idle':
      return '';
  }
}

interface KindPresentation {
  icon: string;
  colorClass: string;
  animate: 'pulse' | 'spin' | null;
}

const KIND_PRESENTATION: Record<Exclude<SessionIndicatorState['kind'], 'idle'>, KindPresentation> = {
  'needs-input': {
    icon: 'contact_support',
    colorClass: 'text-[var(--nim-session-status-attention,var(--nim-warning))]',
    animate: 'pulse',
  },
  error: {
    icon: 'error',
    colorClass: 'text-[var(--nim-error)]',
    animate: null,
  },
  'working-self': {
    icon: 'progress_activity',
    colorClass: 'text-[var(--nim-session-status-working,#3b82f6)]',
    animate: 'spin',
  },
  'working-child': {
    icon: 'smart_toy',
    colorClass: 'text-[var(--nim-session-status-working,#3b82f6)]',
    animate: null,
  },
  queued: {
    icon: 'queue',
    colorClass: 'text-[var(--nim-session-status-working,#3b82f6)]',
    animate: null,
  },
  ready: {
    icon: 'circle',
    colorClass: 'text-[var(--nim-session-status-attention,var(--nim-warning))]',
    animate: null,
  },
  'wakeup-attention': {
    icon: 'schedule',
    colorClass: 'text-[var(--nim-session-status-attention,var(--nim-warning))]',
    animate: 'pulse',
  },
  scheduled: {
    icon: 'schedule',
    colorClass: 'text-[var(--nim-session-status-scheduled,var(--nim-text-muted))]',
    animate: null,
  },
};

const VARIANT_STYLES: Record<SessionOperationalIndicatorVariant, {
  iconSize: number;
  readyDotSize: number;
  containerClass: string;
}> = {
  standalone: { iconSize: 14, readyDotSize: 8, containerClass: 'w-5 h-5' },
  child: { iconSize: 11, readyDotSize: 6, containerClass: 'w-4 h-4' },
  group: { iconSize: 12, readyDotSize: 7, containerClass: 'w-4 h-4' },
  dropdown: { iconSize: 14, readyDotSize: 8, containerClass: 'w-5 h-5' },
  gutter: { iconSize: 14, readyDotSize: 8, containerClass: 'w-5 h-5' },
};

export const SessionOperationalIndicatorView: React.FC<{
  state: SessionIndicatorState;
  variant: SessionOperationalIndicatorVariant;
  className?: string;
  isGroup?: boolean;
}> = ({ state, variant, className = '', isGroup = false }) => {
  if (state.kind === 'idle') return null;

  const presentation = KIND_PRESENTATION[state.kind];
  const style = VARIANT_STYLES[variant];
  const label = getSessionOperationalLabel(state);
  const motionClass = presentation.animate === 'pulse'
    ? 'motion-safe:animate-pulse'
    : presentation.animate === 'spin'
      ? 'motion-safe:animate-[spin_1.5s_linear_infinite]'
      : '';

  return (
    <span
      className={`session-operational-indicator ${isGroup ? 'group' : ''} ${state.kind} flex items-center justify-center ${style.containerClass} ${presentation.colorClass} ${motionClass} shrink-0 ${className}`}
      data-state={state.kind}
      data-motion={presentation.animate ?? 'none'}
      role="img"
      aria-label={`Status: ${label}`}
      title={label}
    >
      <MaterialSymbol
        icon={presentation.icon}
        size={state.kind === 'ready' ? style.readyDotSize : style.iconSize}
        fill={state.kind === 'ready'}
      />
    </span>
  );
};

export const SessionOperationalIndicator = memo<SessionOperationalIndicatorProps>(({
  sessionId,
  variant = 'standalone',
  className = '',
}) => {
  const state = useAtomValue(sessionIndicatorStateAtom(sessionId));
  return <SessionOperationalIndicatorView state={state} variant={variant} className={className} />;
});

SessionOperationalIndicator.displayName = 'SessionOperationalIndicator';

export interface GroupOperationalIndicatorProps {
  /** JSON key for groupIndicatorStateAtom: `{ parentId, childIds }` */
  groupKey: string;
  variant?: SessionOperationalIndicatorVariant;
  className?: string;
}

export const GroupOperationalIndicator = memo<GroupOperationalIndicatorProps>(({
  groupKey,
  variant = 'group',
  className = '',
}) => {
  const state = useAtomValue(groupIndicatorStateAtom(groupKey));
  return (
    <SessionOperationalIndicatorView
      state={state}
      variant={variant}
      className={className}
      isGroup
    />
  );
});

GroupOperationalIndicator.displayName = 'GroupOperationalIndicator';
