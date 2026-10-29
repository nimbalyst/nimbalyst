/**
 * useIssuePanel — everything the GitHub panel needs to show the issues list:
 * filter state, the selected issue, the chat context card, the tracker/session
 * context that lets the rail follow the selection, the overlay write path, and
 * the "investigate" session action.
 *
 * Issues have no poller of their own — the PR scheduler refreshes both caches
 * — so entering the list only asks for an immediate poll.
 *
 * Filters and the detail tab live in this hook rather than in the components
 * below it so switching to the PR list and back does not reset them. They are
 * not persisted: `prModeLayoutAtom` has no issue-side filter/tab fields yet.
 */

import type { JSX, RefObject } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAtomValue } from 'jotai';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import { trackerItemsMapAtom } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerDataAtoms';
import { githubIssueListAtom } from '../../../store/atoms/githubIssues';
import type { GithubIssueRow } from '../../../services/RendererGithubIssueService';
import { prListAtom, prModeLayoutAtom } from '../../../store/atoms/pullRequests';
import { getGithubIssueService } from '../../../services/RendererGithubIssueService';
import { dispatchCreateNewSession } from '../../../store/actions/sessionHistoryActions';
import type { GithubPanelChatHandle } from '../GithubPanelShell';
import type { GithubPanelSlots } from '../githubPanelSlots';
import { GithubIssueSidebar } from './GithubIssueSidebar';
import { GithubIssueListView } from './GithubIssueListView';
import { GithubIssueDetail, type IssueDetailTab } from './GithubIssueDetail';
import { buildInvestigateDraft, issueHtmlUrl } from './issueFormat';
import {
  collectIssueAttention,
  collectPrsByIssueNumber,
  toggleIssueFilter,
  type IssueAttentionChip,
  type IssueFilterChip,
} from './issueFilters';
import { useIssueAiContext } from './useIssueAiContext';
import { useIssueOverlayWrite } from './useIssueOverlay';
import { ISSUE_OVERLAY_TYPE } from './issueOverlay';
import { resolveStartedStatus } from '../prOverlay';

const INVESTIGATE_STATUS_NAMES = ['investigating', 'in-progress'];
import { useIssueTrackerContext, useIssueTrackerReferences } from './useIssueTrackerContext';

interface IssuePanelOptions {
  workspacePath: string;
  remote: string | null;
  /** Whether the GitHub panel itself is the active content mode. */
  isActive: boolean;
  /** Whether the issues list is the one currently showing in the panel. */
  isVisible: boolean;
  chatRef: RefObject<GithubPanelChatHandle | null>;
}

const DEFAULT_FILTERS: IssueFilterChip[] = ['open'];
const NO_LINKED_PRS: number[] = [];

export function useIssuePanel({
  workspacePath,
  remote,
  isActive,
  isVisible,
  chatRef,
}: IssuePanelOptions): GithubPanelSlots {
  const layout = useAtomValue(prModeLayoutAtom);
  const issues = useAtomValue(githubIssueListAtom);
  const prList = useAtomValue(prListAtom);

  const [activeFilters, setActiveFilters] = useState<IssueFilterChip[]>(DEFAULT_FILTERS);
  const [localStatusFilters, setLocalStatusFilters] = useState<string[]>([]);
  const [attentionFilters, setAttentionFilters] = useState<IssueAttentionChip[]>([]);
  const [activeTab, setActiveTab] = useState<IssueDetailTab>('conversation');

  const trackerReferences = useIssueTrackerReferences(remote);
  const trackerItems = useAtomValue(trackerItemsMapAtom);
  const writeOverlay = useIssueOverlayWrite(workspacePath, remote);

  // Ask for a fresh poll on entering the list; the scheduler owns the cadence.
  useEffect(() => {
    if (!remote || !isActive || !isVisible) return;
    void getGithubIssueService()
      .pollNow(workspacePath)
      .catch((err: unknown) => console.error('[useIssuePanel] Issue poll failed', err));
  }, [workspacePath, remote, isActive, isVisible]);

  const handleToggleFilter = useCallback((filter: IssueFilterChip) => {
    setActiveFilters((current) => toggleIssueFilter(current, filter));
  }, []);

  const handleToggleLocalStatusFilter = useCallback((status: string) => {
    setLocalStatusFilters((current) =>
      current.includes(status) ? current.filter((s) => s !== status) : [...current, status],
    );
  }, []);

  const handleToggleAttentionFilter = useCallback((chip: IssueAttentionChip) => {
    setAttentionFilters((current) =>
      current.includes(chip) ? current.filter((c) => c !== chip) : [...current, chip],
    );
  }, []);

  const handleClearFilters = useCallback(() => {
    setActiveFilters(DEFAULT_FILTERS);
    setLocalStatusFilters([]);
    setAttentionFilters([]);
  }, []);

  const linkedPrsByIssue = useMemo(() => collectPrsByIssueNumber(prList), [prList]);

  // Resolved once for the whole list so the sidebar's counts and the list's
  // narrowing can never disagree, and so divergence is computed per issue
  // rather than per row render.
  const attentionByIssue = useMemo(
    () =>
      collectIssueAttention({
        issues,
        remote,
        referencesByIssue: trackerReferences,
        items: trackerItems.values(),
        now: Date.now(),
      }),
    [issues, remote, trackerReferences, trackerItems],
  );

  const selectedIssue =
    layout.selectedIssueItemId != null
      ? issues.find((issue) => issue.id === layout.selectedIssueItemId) ?? null
      : null;

  const linkedPrNumbers = useMemo(
    () => (selectedIssue ? linkedPrsByIssue.get(selectedIssue.number) ?? NO_LINKED_PRS : NO_LINKED_PRS),
    [selectedIssue, linkedPrsByIssue],
  );

  const { documentContext, getDocumentContext } = useIssueAiContext(
    remote,
    selectedIssue,
    isActive && isVisible,
    linkedPrNumbers,
  );

  // Tracker items, overlay, and sessions for the selected issue, resolved once
  // here so the Local tab and the chat rail agree on what belongs to it.
  const trackerContext = useIssueTrackerContext(
    remote,
    selectedIssue?.number ?? 0,
    selectedIssue && remote ? issueHtmlUrl(selectedIssue, remote) : null,
  );

  /**
   * Link a new session to every tracker item already about this issue, creating
   * the overlay first.
   *
   * Handing an issue to an agent is a first write, so it leaves the durable
   * trace the overlay exists for: the same item `/investigate` upserts from the
   * command side, converged on by issue URL. The PR side does the same in
   * `linkSessionsToPrTrackers`.
   */
  const linkSessionToIssueTrackers = useCallback(
    async (sessionId: string, issue: GithubIssueRow) => {
      // Read from the active schema: a workspace's own triage schema may not
      // offer `investigating`, and then the overlay keeps its status.
      const status = resolveStartedStatus(ISSUE_OVERLAY_TYPE, INVESTIGATE_STATUS_NAMES);
      const overlayId = await writeOverlay('start-session', issue, status ? { status } : {});
      const itemIds = new Set((trackerReferences.get(issue.number) ?? []).map((item) => item.id));
      // The freshly created overlay is not in `trackerReferences` yet — that
      // map re-derives after the tracker change lands in the store.
      if (overlayId) itemIds.add(overlayId);
      for (const trackerId of itemIds) {
        await window.electronAPI
          .invoke('tracker:link-session', { trackerId, sessionId })
          .catch((err: unknown) =>
            console.error('[useIssuePanel] Failed to link session to tracker item', err),
          );
      }
    },
    [writeOverlay, trackerReferences],
  );

  const handleOpenSessionInChat = useCallback(
    (sessionId: string) => {
      chatRef.current?.openSession(sessionId);
    },
    [chatRef],
  );

  const handleStartInvestigationSession = useCallback(async () => {
    if (!selectedIssue || !remote) return;
    const sessionId = await dispatchCreateNewSession({
      initialDraft: buildInvestigateDraft(remote, selectedIssue.number),
      launchSource: 'issue_panel',
    });
    if (!sessionId) return;
    await linkSessionToIssueTrackers(sessionId, selectedIssue);
    chatRef.current?.openSession(sessionId);
  }, [selectedIssue, remote, linkSessionToIssueTrackers, chatRef]);

  return {
    sidebar: (
      <GithubIssueSidebar
        remote={remote}
        activeFilters={activeFilters}
        onToggleFilter={handleToggleFilter}
        activeLocalStatusFilters={localStatusFilters}
        onToggleLocalStatusFilter={handleToggleLocalStatusFilter}
        attentionByIssue={attentionByIssue}
        activeAttentionFilters={attentionFilters}
        onToggleAttentionFilter={handleToggleAttentionFilter}
      />
    ),
    list: (
      <GithubIssueListView
        workspaceId={workspacePath}
        remote={remote}
        isActive={isActive && isVisible}
        activeFilters={activeFilters}
        activeLocalStatusFilters={localStatusFilters}
        activeAttentionFilters={attentionFilters}
        attentionByIssue={attentionByIssue}
        onClearFilters={handleClearFilters}
        linkedPrsByIssue={linkedPrsByIssue}
      />
    ),
    detail: selectedIssue && remote ? (
      <GithubIssueDetail
        workspaceId={workspacePath}
        remote={remote}
        issue={selectedIssue}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        onStartInvestigationSession={handleStartInvestigationSession}
        trackerContext={trackerContext}
        linkedPrNumbers={linkedPrNumbers}
        onOverlayWrite={writeOverlay}
        onOpenSession={handleOpenSessionInChat}
      />
    ) : (
      <IssueEmptyState />
    ),
    documentContext,
    getDocumentContext,
    selectionKey: selectedIssue?.id ?? null,
    selectionSessions: trackerContext.sessions,
  };
}

function IssueEmptyState(): JSX.Element {
  return (
    <div className="issue-empty-state flex h-full items-center justify-center px-8 text-center">
      <div className="max-w-md space-y-3">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full border border-nim bg-nim-secondary text-nim-faint">
          <MaterialSymbol icon="adjust" size={24} />
        </div>
        <div className="text-sm font-medium text-nim">Select an issue</div>
        <div className="text-sm text-nim-muted">
          Pick an issue from the left to read its conversation and activity, or hand it to an agent.
        </div>
      </div>
    </div>
  );
}
