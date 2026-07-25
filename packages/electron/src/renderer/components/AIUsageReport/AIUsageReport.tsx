import React, { useState } from 'react';
import { OverviewDashboard } from './OverviewDashboard';
import { HistoricalGraph } from './HistoricalGraph';
import { ModelComparison } from './ModelComparison';
import { ProjectInsights } from './ProjectInsights';
import { ActivityHeatmap } from './ActivityHeatmap';
import { ToolUsage } from './ToolUsage';

interface AIUsageReportProps {
  onClose?: () => void;
}

export const AIUsageReport: React.FC<AIUsageReportProps> = ({ onClose }) => {
  const [workspaceFilter, setWorkspaceFilter] = useState<string | undefined>(undefined);
  const [activeTab, setActiveTab] = useState<'overview' | 'tools'>('overview');

  return (
    <div className="ai-usage-report flex flex-col h-full bg-nim text-nim overflow-hidden">
      <div
        className="ai-usage-report-tabs flex gap-1 px-4 pt-4 border-b border-nim"
        role="tablist"
        aria-label="AI usage report sections"
      >
        {(['overview', 'tools'] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={activeTab === tab}
            onClick={() => setActiveTab(tab)}
            className={`ai-usage-report-tab px-3 py-2 text-sm border-b-2 ${
              activeTab === tab
                ? 'border-[var(--nim-primary)] text-[var(--nim-text)]'
                : 'border-transparent text-[var(--nim-text-muted)] hover:text-[var(--nim-text)]'
            }`}
          >
            {tab === 'overview' ? 'Overview' : 'Tools'}
          </button>
        ))}
      </div>
      <div className="ai-usage-report-content flex-1 overflow-y-auto p-4 flex flex-col gap-4 scrollbar-nim">
        {activeTab === 'overview' ? (
          <>
            <OverviewDashboard workspaceId={workspaceFilter} />

            <div className="dashboard-row grid grid-cols-[repeat(auto-fit,minmax(500px,1fr))] gap-4">
              <div className="dashboard-section bg-nim-secondary border border-nim rounded-md p-4">
                <ActivityHeatmap workspaceId={workspaceFilter} />
              </div>
            </div>

            <div className="dashboard-row grid grid-cols-[repeat(auto-fit,minmax(500px,1fr))] gap-4">
              <div className="dashboard-section bg-nim-secondary border border-nim rounded-md p-4">
                <HistoricalGraph workspaceId={workspaceFilter} />
              </div>
              {/*<div className="dashboard-section bg-nim-secondary border border-nim rounded-md p-4">*/}
              {/*  <ModelComparison workspaceId={workspaceFilter} />*/}
              {/*</div>*/}
            </div>

            <div className="dashboard-row grid grid-cols-[repeat(auto-fit,minmax(500px,1fr))] gap-4">
              <div className="dashboard-section bg-nim-secondary border border-nim rounded-md p-4">
                <ProjectInsights />
              </div>
            </div>
          </>
        ) : (
          <div className="dashboard-row grid grid-cols-[repeat(auto-fit,minmax(500px,1fr))] gap-4">
            <div className="dashboard-section bg-nim-secondary border border-nim rounded-md p-4">
              <ToolUsage workspaceId={workspaceFilter} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
