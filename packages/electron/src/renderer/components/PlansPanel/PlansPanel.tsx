/**
 * PlansPanel - Main container for plans view in workspace sidebar
 */

import type { JSX } from 'react';
import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { PlanListItem, type PlanData } from './PlanListItem';
import { PlanFilters } from './PlanFilters';
import { getFileName } from '../../utils/pathUtils';
import type { DocumentMetadataEntry, MetadataChangeEvent } from '../../../../../runtime/src/core/DocumentService';

interface PlansPanelProps {
  currentFilePath: string | null;
  onPlanSelect: (planPath: string) => void;
}

export function PlansPanel({ currentFilePath, onPlanSelect }: PlansPanelProps): JSX.Element {
  const [plans, setPlans] = useState<PlanData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [priorityFilter, setPriorityFilter] = useState<string>('all');
  const [hideCompleted, setHideCompleted] = useState(false);

  useEffect(() => {
    let unsubscribe: (() => void) | null = null;
    let cancelled = false;

    async function loadPlans() {
      try {
        const documentService = (window as any).documentService;

        if (!documentService) {
          console.log('[PlansPanel] Document service not available yet');
          setError('Document service not available');
          setLoading(false);
          return;
        }

        if (!documentService.listDocumentMetadata) {
          setError('Document metadata not supported');
          setLoading(false);
          return;
        }

        // Load initial metadata
        const metadata = await documentService.listDocumentMetadata();
        if (cancelled) return;
        const planDocs = extractPlanData(metadata || []);
        setPlans(planDocs);
        setLoading(false);

        // Subscribe to changes
        if (documentService.watchDocumentMetadata) {
          const nextUnsubscribe = documentService.watchDocumentMetadata((_change: MetadataChangeEvent) => {
            // Re-fetch all metadata on change
            documentService.listDocumentMetadata().then((updatedMetadata: DocumentMetadataEntry[]) => {
              if (cancelled) return;
              const updatedPlans = extractPlanData(updatedMetadata);
              setPlans(updatedPlans);
            });
          });
          if (cancelled) {
            nextUnsubscribe();
          } else {
            unsubscribe = nextUnsubscribe;
          }
        }
      } catch (err) {
        if (cancelled) return;
        console.error('Failed to load plan documents:', err);
        setError('Failed to load plans');
        setLoading(false);
      }
    }

    loadPlans();

    return () => {
      cancelled = true;
      if (unsubscribe) {
        unsubscribe();
      }
    };
  }, []);

  function extractPlanData(metadata: DocumentMetadataEntry[]): PlanData[] {
    return metadata
      .filter(doc => {
        // Only include documents that have planStatus in their frontmatter
        const hasPlanStatus = !!(doc.frontmatter && doc.frontmatter.planStatus);

        // Exclude agent files
        const pathLower = doc.path.toLowerCase();
        const isAgentFile = pathLower.includes('/agents/') || pathLower.includes('\\agents\\');

        return hasPlanStatus && !isAgentFile;
      })
      .map(doc => {
        const planStatus = doc.frontmatter.planStatus as any || {};
        const frontmatter = doc.frontmatter;

        return {
          id: planStatus.planId || doc.id,
          title: planStatus.title || frontmatter.title || getFileName(doc.path).replace('.md', '') || 'Untitled',
          status: planStatus.status || frontmatter.status || 'draft',
          owner: planStatus.owner || frontmatter.owner || 'unassigned',
          priority: planStatus.priority || frontmatter.priority || 'medium',
          progress: planStatus.progress || frontmatter.progress || 0,
          path: doc.path,
          lastUpdated: doc.lastModified,
          tags: planStatus.tags || frontmatter.tags,
          planType: planStatus.planType || frontmatter.planType,
        } as PlanData;
      })
      .sort((a, b) => b.lastUpdated.getTime() - a.lastUpdated.getTime());
  }

  const filteredPlans = useMemo(() => {
    return plans.filter(plan => {
      // Search filter
      if (searchTerm) {
        const searchLower = searchTerm.toLowerCase();
        const matchesSearch =
          plan.title.toLowerCase().includes(searchLower) ||
          plan.status.toLowerCase().includes(searchLower) ||
          plan.owner.toLowerCase().includes(searchLower) ||
          (plan.tags && plan.tags.some(tag => tag.toLowerCase().includes(searchLower)));
        if (!matchesSearch) return false;
      }

      // Status filter
      if (statusFilter && statusFilter !== 'all') {
        if (plan.status.toLowerCase() !== statusFilter.toLowerCase()) return false;
      }

      // Priority filter
      if (priorityFilter && priorityFilter !== 'all') {
        if (plan.priority.toLowerCase() !== priorityFilter.toLowerCase()) return false;
      }

      // Hide completed filter
      if (hideCompleted && plan.status.toLowerCase() === 'completed') {
        return false;
      }

      return true;
    });
  }, [plans, searchTerm, statusFilter, priorityFilter, hideCompleted]);

  const handlePlanClick = async (plan: PlanData) => {
    const documentService = (window as any).documentService;

    if (documentService && documentService.openDocument) {
      try {
        const doc = await documentService.getDocumentByPath(plan.path);
        if (doc && doc.id) {
          await documentService.openDocument(doc.id, { path: plan.path });
          onPlanSelect(plan.path);
        } else {
          console.error('[PlansPanel] Could not find document for path:', plan.path);
        }
      } catch (error) {
        console.error('[PlansPanel] Failed to open document:', error);
      }
    }
  };

  if (loading) {
    return (
      <div className="plans-panel flex flex-col h-full bg-nim">
        <div className="plans-loading flex flex-col items-center justify-center py-10 px-5 text-nim-muted gap-3">
          <div className="spinner w-6 h-6 border-[3px] border-nim-secondary border-t-nim-accent rounded-full animate-spin"></div>
          <span>Loading plans...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="plans-panel flex flex-col h-full bg-nim">
        <div className="plans-error flex flex-col items-center justify-center py-10 px-5 text-nim-error gap-3">
          <span>{error}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="plans-panel flex flex-col h-full bg-nim">
      <PlanFilters
        searchTerm={searchTerm}
        onSearchChange={setSearchTerm}
        statusFilter={statusFilter}
        onStatusChange={setStatusFilter}
        priorityFilter={priorityFilter}
        onPriorityChange={setPriorityFilter}
        hideCompleted={hideCompleted}
        onHideCompletedChange={setHideCompleted}
      />

      <div className="plans-list flex-1 overflow-y-auto overflow-x-hidden scrollbar-thin scrollbar-track-transparent scrollbar-thumb-nim-scrollbar hover:scrollbar-thumb-nim-scrollbar-hover">
        {filteredPlans.length === 0 ? (
          <div className="plans-empty flex flex-col items-center justify-center py-[60px] px-5 text-nim-faint text-center">
            <span className="material-symbols-outlined text-5xl mb-3 opacity-50">description</span>
            <div className="plans-empty-text text-[13px] leading-normal">
              {searchTerm || statusFilter !== 'all' || priorityFilter !== 'all' || hideCompleted
                ? 'No plans match your filters'
                : 'No plan documents found'}
            </div>
          </div>
        ) : (
          filteredPlans.map((plan) => (
            <PlanListItem
              key={plan.id}
              plan={plan}
              isActive={currentFilePath === plan.path}
              onClick={handlePlanClick}
            />
          ))
        )}
      </div>
    </div>
  );
}
