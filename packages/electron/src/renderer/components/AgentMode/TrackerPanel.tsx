/**
 * TrackerPanel - Collapsible panel showing tracker items linked to the workstream.
 *
 * Aggregates linkedTrackerItemIds from all sessions in the workstream and
 * displays them as clickable rows. Clicking navigates to the item in Tracker mode.
 * Collapse state is persisted at the project level via agentModeLayoutAtom.
 */

import React, { useCallback, useMemo } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { MaterialSymbol } from '@nimbalyst/runtime';
import { trackerItemByIdAtom } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerDataAtoms';
import { sessionRegistryAtom, workstreamSessionsAtom } from '../../store/atoms/sessions';
import { trackerPanelCollapsedAtom, toggleTrackerPanelCollapsedAtom } from '../../store/atoms/agentMode';
import { setWindowModeAtom } from '../../store/atoms/windowMode';
import { setTrackerModeLayoutAtom } from '../../store/atoms/trackers';
import { prRemoteAtom, navigateToPullRequest } from '../../store/atoms/pullRequests';
import { getRecordPrReferences } from '@nimbalyst/runtime/plugins/TrackerPlugin/prReferences';

interface TrackerPanelProps {
  /** The workstream ID - tracker items from all child sessions will be shown */
  workstreamId: string;
}

const TYPE_COLORS: Record<string, string> = {
  bug: '#dc2626',
  task: '#2563eb',
  plan: '#7c3aed',
  idea: '#ca8a04',
  decision: '#8b5cf6',
  feature: '#059669',
};

const TYPE_ICONS: Record<string, string> = {
  bug: 'bug_report',
  task: 'task_alt',
  plan: 'description',
  idea: 'lightbulb',
  decision: 'gavel',
  feature: 'star',
};

export const TrackerPanel: React.FC<TrackerPanelProps> = React.memo(({
  workstreamId,
}) => {
  const isCollapsed = useAtomValue(trackerPanelCollapsedAtom);
  const toggleCollapsed = useSetAtom(toggleTrackerPanelCollapsedAtom);
  const setWindowMode = useSetAtom(setWindowModeAtom);
  const setTrackerLayout = useSetAtom(setTrackerModeLayoutAtom);

  // Aggregate linked tracker item IDs across all sessions in the workstream
  const sessionRegistry = useAtomValue(sessionRegistryAtom);
  const workstreamSessions = useAtomValue(workstreamSessionsAtom(workstreamId));

  const linkedItemIds = useMemo(() => {
    const ids = new Set<string>();
    // Include parent workstream's linked items
    const parentMeta = sessionRegistry.get(workstreamId);
    // console.log('[TrackerPanel] workstreamId:', workstreamId, 'parentMeta linked:', parentMeta?.linkedTrackerItemIds, 'childSessions:', workstreamSessions.length);
    if (parentMeta?.linkedTrackerItemIds) {
      for (const id of parentMeta.linkedTrackerItemIds) {
        if (!id.startsWith('file:')) ids.add(id);
      }
    }
    // Include all child sessions' linked items
    for (const sessionId of workstreamSessions) {
      const meta = sessionRegistry.get(sessionId);
      if (meta?.linkedTrackerItemIds) {
        for (const id of meta.linkedTrackerItemIds) {
          if (!id.startsWith('file:')) ids.add(id);
        }
      }
    }
    return Array.from(ids);
  }, [sessionRegistry, workstreamId, workstreamSessions]);

  const handleToggle = useCallback(() => {
    toggleCollapsed();
  }, [toggleCollapsed]);

  const handleNavigate = useCallback((itemId: string) => {
    // Dispatch the platform-neutral navigation intent. The host (App) routes
    // it: in Agent Mode it opens the tracker as a workstream resource tab; in
    // other modes it falls back to Tracker Mode. This keeps TrackerPanel from
    // owning a Tracker-Mode-only navigation path.
    window.dispatchEvent(
      new CustomEvent('nimbalyst:navigate-tracker-item', { detail: { itemId } })
    );
  }, []);

  // Don't render if no linked tracker items
  if (linkedItemIds.length === 0) {
    return null;
  }

  return (
    <div className="tracker-panel border-t border-[var(--nim-border)] bg-[var(--nim-bg-secondary)]">
      {/* Header */}
      <button
        className="tracker-panel-header w-full flex items-center gap-2 px-3 py-2 bg-transparent border-none cursor-pointer text-left hover:bg-[var(--nim-bg-hover)]"
        onClick={handleToggle}
        data-testid="tracker-panel-header"
      >
        <MaterialSymbol
          icon={isCollapsed ? 'chevron_right' : 'expand_more'}
          size={16}
          className="text-[var(--nim-text-muted)] shrink-0"
        />
        <MaterialSymbol
          icon="widgets"
          size={16}
          className="text-[var(--nim-text-muted)] shrink-0"
        />
        <span className="tracker-panel-title text-xs font-medium text-[var(--nim-text)]">
          Trackers
        </span>
        <span className="tracker-panel-count ml-auto text-[11px] text-[var(--nim-text-muted)] font-mono">
          {linkedItemIds.length}
        </span>
      </button>

      {/* Content */}
      {!isCollapsed && (
        <div className="tracker-panel-content px-2 pb-2 max-h-[200px] overflow-y-auto">
          <div className="flex flex-col gap-0.5">
            {linkedItemIds.map((itemId) => (
              <TrackerItemRow
                key={itemId}
                itemId={itemId}
                onNavigate={handleNavigate}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
});

TrackerPanel.displayName = 'TrackerPanel';

interface TrackerItemRowProps {
  itemId: string;
  onNavigate: (itemId: string) => void;
}

const TrackerItemRow: React.FC<TrackerItemRowProps> = React.memo(({ itemId, onNavigate }) => {
  const item = useAtomValue(trackerItemByIdAtom(itemId));
  const prRemote = useAtomValue(prRemoteAtom);

  const handleClick = useCallback(() => {
    onNavigate(itemId);
  }, [onNavigate, itemId]);

  // PR jump when the item references a PR on the workspace's GitHub remote.
  const prReference = useMemo(() => {
    if (!item || !prRemote) return null;
    const wanted = prRemote.remote.toLowerCase();
    return getRecordPrReferences(item).find((ref) => ref.remote === wanted) ?? null;
  }, [item, prRemote]);

  if (!item) return null;

  const color = TYPE_COLORS[item.primaryType] || '#6b7280';
  const icon = TYPE_ICONS[item.primaryType] || 'label';
  const title = (item.fields.title as string) || 'Untitled';
  const status = item.fields.status as string;

  return (
    <button
      className="tracker-item-row w-full flex items-center gap-2 px-2 py-1.5 rounded bg-transparent border-none cursor-pointer text-left hover:bg-[var(--nim-bg-hover)] transition-colors"
      onClick={handleClick}
      title={`${item.primaryType}: ${title}`}
      data-testid="tracker-item-row"
    >
      <MaterialSymbol
        icon={icon}
        size={14}
        className="shrink-0"
        style={{ color }}
      />
      <span className="flex-1 text-xs text-[var(--nim-text)] truncate">
        {title}
      </span>
      {prReference && (
        <span
          role="button"
          tabIndex={-1}
          className="shrink-0 inline-flex items-center text-[var(--nim-text-muted)] hover:text-[var(--nim-text)]"
          title={`Open #${prReference.number} in the PRs view`}
          data-testid="tracker-item-open-pr"
          onClick={(e) => {
            e.stopPropagation();
            navigateToPullRequest(prReference.remote, prReference.number);
          }}
        >
          <MaterialSymbol icon="merge" size={14} />
        </span>
      )}
      {status && (
        <span
          className="text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0"
          style={{ backgroundColor: `${color}15`, color }}
        >
          {status}
        </span>
      )}
    </button>
  );
});

TrackerItemRow.displayName = 'TrackerItemRow';
