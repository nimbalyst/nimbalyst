/**
 * Executes the overlay writes issueOverlay.ts decides: schema defaults in,
 * tracker IPC out.
 *
 * Every panel interaction that could touch local state goes through `write`,
 * including the ones that must not write — the read actions return the current
 * overlay id (or null) without issuing IPC, so "does looking at an issue create
 * anything" is answered in one place instead of at each call site.
 */

import { useCallback } from 'react';
import { globalRegistry } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import { getFieldDefForRole } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerRecordAccessors';
import {
  getGithubIssueService,
  type GithubIssueRow,
} from '../../../services/RendererGithubIssueService';
import { issueHtmlUrl } from './issueFormat';
import {
  ISSUE_OVERLAY_TYPE,
  findIssueOverlay,
  planIssueOverlayWrite,
  type IssueOverlayAction,
  type IssueOverlaySeed,
} from './issueOverlay';
import { useIssueTrackerReferences } from './useIssueTrackerContext';

/** Fallback only for a workspace whose schema copy predates the status field. */
const FALLBACK_DEFAULT_STATUS = 'needs-triage';

export function issueOverlaySeed(remote: string, issue: GithubIssueRow): IssueOverlaySeed {
  return {
    issueUrl: issueHtmlUrl(issue, remote),
    issueNumber: issue.number,
    title: issue.title,
    author: issue.authorLogin,
    repo: remote,
  };
}

export type IssueOverlayWrite = (
  action: IssueOverlayAction,
  issue: GithubIssueRow,
  updates?: Record<string, unknown>,
) => Promise<string | null>;

/**
 * Applies one overlay write for an issue of this remote, creating the overlay
 * if this is the first one. Resolves to the overlay's item id, or null when
 * nothing was written and none exists.
 */
export function useIssueOverlayWrite(workspacePath: string, remote: string | null): IssueOverlayWrite {
  const references = useIssueTrackerReferences(remote);

  return useCallback(
    async (action, issue, updates = {}) => {
      if (!remote) return null;
      const seed = issueOverlaySeed(remote, issue);
      const candidates = references.get(issue.number) ?? [];
      const plan = planIssueOverlayWrite({
        action,
        seed,
        references: candidates,
        updates,
        defaultStatus:
          (getFieldDefForRole(ISSUE_OVERLAY_TYPE, 'workflowStatus')?.default as string) ??
          FALLBACK_DEFAULT_STATUS,
      });

      if (!plan) {
        return findIssueOverlay(candidates, seed.issueUrl)?.id ?? null;
      }

      const model = globalRegistry.get(ISSUE_OVERLAY_TYPE);
      const sharing = model?.sharing ?? 'personal';
      const draftByDefault = model?.draftByDefault ?? false;

      try {
        if (plan.kind === 'update') {
          const result = await window.electronAPI.documentService.updateTrackerItem({
            itemId: plan.itemId,
            updates: plan.updates,
            sharing,
            draftByDefault,
          });
          if (!result.success) throw new Error(result.error || 'update failed');
          return plan.itemId;
        }

        const result = await getGithubIssueService().getOrCreateOverlay(workspacePath, {
          issueUrl: seed.issueUrl,
          title: plan.title,
          status: plan.status,
          priority: plan.priority,
          customFields: plan.customFields,
          updates,
        });
        return result.id;
      } catch (err) {
        console.error(`[useIssueOverlay] Failed to ${plan.kind} overlay for #${issue.number}`, err);
        return null;
      }
    },
    [workspacePath, remote, references],
  );
}
