/**
 * PlanListItem - Individual plan item in the sidebar plans list
 */

import type { JSX } from 'react';
import React from 'react';

export interface PlanData {
  id: string;
  title: string;
  status: string;
  owner: string;
  priority: string;
  progress: number;
  path: string;
  lastUpdated: Date;
  tags?: string[];
  planType?: string;
}

interface PlanListItemProps {
  plan: PlanData;
  isActive?: boolean;
  onClick: (plan: PlanData) => void;
}

function getStatusColor(status: string): string {
  const statusColors: Record<string, string> = {
    'completed': '#22c55e',
    'in-progress': '#eab308',
    'in-development': '#eab308',
    'active': '#22c55e',
    'cancelled': '#ef4444',
    'blocked': '#ef4444',
    'draft': '#6b7280',
    'ready-for-development': '#3b82f6',
    'in-review': '#8b5cf6',
    'rejected': '#dc2626',
  };
  return statusColors[status.toLowerCase()] || '#6b7280';
}

function getPriorityColor(priority: string): string {
  const priorityColors: Record<string, string> = {
    'critical': '#dc2626',
    'high': '#ef4444',
    'medium': '#f59e0b',
    'low': '#6b7280',
  };
  return priorityColors[priority.toLowerCase()] || '#6b7280';
}

function getPlanTypeIcon(planType?: string): string {
  const icons: Record<string, string> = {
    'feature': 'add_circle',
    'bug-fix': 'bug_report',
    'refactor': 'construction',
    'system-design': 'architecture',
    'research': 'science',
  };
  return icons[planType?.toLowerCase() || ''] || 'description';
}

function formatDate(date: Date): string {
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const hours = Math.floor(diff / (1000 * 60 * 60));

  if (hours < 1) return 'now';
  if (hours < 24) return `${hours}h ago`;
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function PlanListItem({ plan, isActive, onClick }: PlanListItemProps): JSX.Element {
  const statusColor = getStatusColor(plan.status);
  const priorityColor = getPriorityColor(plan.priority);
  const planTypeIcon = getPlanTypeIcon(plan.planType);

  return (
    <div
      className={`plan-list-item px-3 py-2 border-b border-nim cursor-pointer transition-colors duration-150 hover:bg-nim-hover ${isActive ? 'active bg-nim-secondary border-l-[3px] border-l-nim-accent pl-[9px]' : ''}`}
      onClick={() => onClick(plan)}
    >
      <div className="plan-list-item-header flex items-start gap-1.5 mb-1.5">
        <span
          className="plan-priority-indicator text-[11px] font-bold tracking-tighter shrink-0 min-w-4"
          style={{ color: priorityColor }}
          title={`Priority: ${plan.priority}`}
        >
          {plan.priority === 'critical' && '!!!'}
          {plan.priority === 'high' && '!!'}
          {plan.priority === 'medium' && '!'}
        </span>
        <span className="material-symbols-outlined plan-type-icon text-base text-nim-faint shrink-0 mt-px" title={plan.planType || 'plan'}>
          {planTypeIcon}
        </span>
        <div className="plan-list-item-title flex-1 text-[13px] font-medium text-nim-primary leading-snug overflow-hidden text-ellipsis line-clamp-2">{plan.title}</div>
      </div>

      {plan.progress > 0 && (
        <div className="plan-progress-bar h-[3px] bg-nim-secondary rounded-sm overflow-hidden mb-1.5">
          <div
            className="plan-progress-fill h-full transition-[width] duration-300 ease-in-out"
            style={{
              width: `${plan.progress}%`,
              backgroundColor: plan.progress === 100 ? '#22c55e' : '#60a5fa'
            }}
          />
        </div>
      )}

      <div className="plan-list-item-footer flex items-center justify-between gap-2">
        <span className="plan-updated-time text-[11px] text-nim-faint">{formatDate(plan.lastUpdated)}</span>
        <span
          className="plan-status-badge text-[10px] px-1.5 py-0.5 rounded-sm border capitalize font-medium whitespace-nowrap"
          style={{
            backgroundColor: `${statusColor}20`,
            color: statusColor,
            borderColor: statusColor
          }}
        >
          {plan.status.replace('-', ' ')}
        </span>
      </div>
    </div>
  );
}
