/**
 * PrTrackerStrip — the tracker/session context row in the PR detail header.
 *
 * Shows, for the selected PR: each referencing tracker item (issue-key chip →
 * tracker mode, editable status pill using the item's own schema options),
 * the linked review sessions (button/popover → agent mode), the primary
 * item's notes one-liner, and a "Link tracker item" picker for connecting any
 * existing item (of any type) to this PR via system.linkedPullRequests.
 */

import type { JSX } from 'react';
import { useMemo, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { MaterialSymbol } from '@nimbalyst/runtime';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import { globalRegistry, getRoleField } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import {
  getRecordTitle,
  getRecordStatus,
  getStatusOptions,
  resolveRoleFieldName,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerRecordAccessors';
import { trackerItemsArrayAtom } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerDataAtoms';
import {
  getRecordPrReferences,
  buildPrUrl,
  type PrReference,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/prReferences';
import type { LinkedPullRequest } from '@nimbalyst/runtime/core/TrackerRecord';
import { FloatingPortal, useFloatingMenu } from '../../hooks/useFloatingMenu';
import { dispatchOpenSessionInTab } from '../../store/actions/sessionHistoryActions';
import { setWindowModeAtom } from '../../store/atoms/windowMode';
import { statusOptionFor, trackerColorStyle } from './PrTrackerBadge';
import { usePrTrackerContext } from './usePrTrackerContext';
import type { SessionMeta } from '../../store/atoms/sessions';

interface PrTrackerStripProps {
  workspacePath: string;
  remote: string;
  prNumber: number;
  /** PR state, for surfacing externally merged/closed PRs with active items. */
  prState?: 'open' | 'merged' | 'closed';
}

function navigateToTrackerItem(itemId: string): void {
  window.dispatchEvent(
    new CustomEvent('nimbalyst:navigate-tracker-item', { detail: { itemId } })
  );
}

async function updateItemFields(record: TrackerRecord, updates: Record<string, unknown>): Promise<void> {
  const tracker = globalRegistry.get(record.primaryType);
  const syncMode = tracker?.sync?.mode || 'local';
  await window.electronAPI.documentService.updateTrackerItem({
    itemId: record.id,
    updates,
    syncMode,
  });
}

/** Editable status pill: the item's own workflowStatus options in a menu. */
function StatusPill({ record }: { record: TrackerRecord }): JSX.Element | null {
  const menu = useFloatingMenu({ placement: 'bottom-start' });
  const [busy, setBusy] = useState(false);
  const option = statusOptionFor(record);
  const options = getStatusOptions(record.primaryType);
  if (!option) return null;
  const style = trackerColorStyle(option.color);

  const setStatus = async (value: string) => {
    menu.setIsOpen(false);
    if (value === option.value || busy) return;
    setBusy(true);
    try {
      const statusFieldName = resolveRoleFieldName(record.primaryType, 'workflowStatus');
      await updateItemFields(record, { [statusFieldName]: value });
    } catch (err) {
      console.error('[PrTrackerStrip] Failed to update status:', err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        ref={menu.refs.setReference}
        {...menu.getReferenceProps()}
        type="button"
        data-testid="pr-tracker-status-pill"
        disabled={busy || options.length === 0}
        onClick={() => menu.setIsOpen(!menu.isOpen)}
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium transition-[filter] hover:brightness-125 disabled:opacity-60"
        style={style}
        title="Change review status"
      >
        {option.icon && <MaterialSymbol icon={option.icon} size={12} />}
        {option.label}
        {options.length > 0 && <MaterialSymbol icon="arrow_drop_down" size={14} />}
      </button>
      {menu.isOpen && (
        <FloatingPortal>
          <div
            ref={menu.refs.setFloating}
            style={menu.floatingStyles}
            {...menu.getFloatingProps()}
            className="z-50 min-w-[160px] bg-nim-secondary border border-nim rounded-md shadow-lg py-1"
          >
            {options.map((opt) => (
              <button
                key={opt.value}
                className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors ${
                  opt.value === option.value
                    ? 'text-nim bg-nim-active'
                    : 'text-nim-muted hover:bg-nim-tertiary hover:text-nim'
                }`}
                onClick={() => void setStatus(opt.value)}
              >
                {opt.icon && (
                  <MaterialSymbol icon={opt.icon} size={13} style={{ color: opt.color }} />
                )}
                {opt.label}
              </button>
            ))}
          </div>
        </FloatingPortal>
      )}
    </>
  );
}

/** Session jump button; a popover list when more than one session is linked. */
function SessionsButton({
  sessions,
  onOpen,
}: {
  sessions: SessionMeta[];
  onOpen: (sessionId: string) => void;
}): JSX.Element | null {
  const menu = useFloatingMenu({ placement: 'bottom-start' });
  if (sessions.length === 0) return null;

  if (sessions.length === 1) {
    return (
      <button
        type="button"
        data-testid="pr-open-session"
        className="flex items-center gap-1 px-2 py-0.5 text-[11px] text-nim-muted hover:text-nim border border-nim rounded transition-colors"
        onClick={() => onOpen(sessions[0].id)}
        title={sessions[0].title}
      >
        <MaterialSymbol icon="smart_toy" size={13} />
        Session
      </button>
    );
  }

  return (
    <>
      <button
        ref={menu.refs.setReference}
        {...menu.getReferenceProps()}
        type="button"
        data-testid="pr-open-session"
        className="flex items-center gap-1 px-2 py-0.5 text-[11px] text-nim-muted hover:text-nim border border-nim rounded transition-colors"
        onClick={() => menu.setIsOpen(!menu.isOpen)}
      >
        <MaterialSymbol icon="smart_toy" size={13} />
        {sessions.length} sessions
        <MaterialSymbol icon="arrow_drop_down" size={14} />
      </button>
      {menu.isOpen && (
        <FloatingPortal>
          <div
            ref={menu.refs.setFloating}
            style={menu.floatingStyles}
            {...menu.getFloatingProps()}
            className="z-50 min-w-[260px] max-w-[380px] bg-nim-secondary border border-nim rounded-md shadow-lg py-1"
          >
            {sessions.map((session) => (
              <button
                key={session.id}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs text-nim-muted hover:bg-nim-tertiary hover:text-nim transition-colors"
                onClick={() => {
                  menu.setIsOpen(false);
                  onOpen(session.id);
                }}
              >
                <MaterialSymbol icon="smart_toy" size={13} className="shrink-0" />
                <span className="truncate">{session.title}</span>
              </button>
            ))}
          </div>
        </FloatingPortal>
      )}
    </>
  );
}

/** Search picker linking any existing tracker item to this PR. */
function LinkTrackerItemButton({
  remote,
  prNumber,
  alreadyLinkedIds,
}: {
  remote: string;
  prNumber: number;
  alreadyLinkedIds: Set<string>;
}): JSX.Element {
  const menu = useFloatingMenu({ placement: 'bottom-end' });
  const [query, setQuery] = useState('');
  const [linkingId, setLinkingId] = useState<string | null>(null);
  const allItems = useAtomValue(trackerItemsArrayAtom);

  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    return allItems
      .filter((item) => !item.archived && !alreadyLinkedIds.has(item.id))
      .filter(
        (item) =>
          !q ||
          getRecordTitle(item).toLowerCase().includes(q) ||
          item.issueKey?.toLowerCase().includes(q),
      )
      .sort((a, b) => (b.system.updatedAt || '').localeCompare(a.system.updatedAt || ''))
      .slice(0, 8);
  }, [allItems, alreadyLinkedIds, query]);

  const linkItem = async (record: TrackerRecord) => {
    if (linkingId) return;
    setLinkingId(record.id);
    try {
      const existing: LinkedPullRequest[] = (record.system.linkedPullRequests ?? []).filter(
        (ref) => !(ref.remote === remote.toLowerCase() && ref.number === prNumber),
      );
      const linkedPullRequests: LinkedPullRequest[] = [
        ...existing,
        { remote: remote.toLowerCase(), number: prNumber, url: buildPrUrl(remote.toLowerCase(), prNumber) },
      ];
      await updateItemFields(record, { linkedPullRequests });
      menu.setIsOpen(false);
      setQuery('');
    } catch (err) {
      console.error('[PrTrackerStrip] Failed to link tracker item:', err);
    } finally {
      setLinkingId(null);
    }
  };

  return (
    <>
      <button
        ref={menu.refs.setReference}
        {...menu.getReferenceProps()}
        type="button"
        data-testid="pr-link-tracker-item"
        className="flex items-center gap-1 px-2 py-0.5 text-[11px] text-nim-faint hover:text-nim rounded transition-colors"
        onClick={() => menu.setIsOpen(!menu.isOpen)}
        title="Link a tracker item to this PR"
      >
        <MaterialSymbol icon="add_link" size={13} />
        Link tracker item
      </button>
      {menu.isOpen && (
        <FloatingPortal>
          <div
            ref={menu.refs.setFloating}
            style={menu.floatingStyles}
            {...menu.getFloatingProps()}
            className="z-50 w-[300px] bg-nim-secondary border border-nim rounded-md shadow-lg p-2"
          >
            <input
              autoFocus
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search items by title or key"
              className="nim-input w-full h-7 text-xs mb-1"
              data-testid="pr-link-tracker-search"
            />
            {candidates.length === 0 ? (
              <div className="px-2 py-2 text-xs text-nim-faint">No matching items</div>
            ) : (
              candidates.map((item) => (
                <button
                  key={item.id}
                  disabled={linkingId != null}
                  className="w-full flex items-center gap-2 px-2 py-1.5 text-left text-xs text-nim-muted hover:bg-nim-tertiary hover:text-nim rounded transition-colors disabled:opacity-50"
                  onClick={() => void linkItem(item)}
                >
                  {item.issueKey && (
                    <span className="font-mono text-[10px] text-nim-faint shrink-0">{item.issueKey}</span>
                  )}
                  <span className="truncate">{getRecordTitle(item)}</span>
                  <span className="ml-auto text-[10px] text-nim-faint shrink-0">{item.primaryType}</span>
                </button>
              ))
            )}
          </div>
        </FloatingPortal>
      )}
    </>
  );
}

/**
 * Surfaced (never auto-applied) hint for a PR that reached a terminal state
 * outside this view: offers the item's declared prMergedStatus as a one-click
 * action. Types without the role show nothing — no semantics invented.
 */
function StaleItemHint({ record }: { record: TrackerRecord }): JSX.Element | null {
  const [busy, setBusy] = useState(false);
  const model = globalRegistry.get(record.primaryType);
  const mergedStatus = model ? getRoleField(model, 'prMergedStatus') : undefined;
  if (!mergedStatus || getRecordStatus(record) === mergedStatus) return null;
  const option = getStatusOptions(record.primaryType).find((o) => o.value === mergedStatus);

  const apply = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const statusFieldName = resolveRoleFieldName(record.primaryType, 'workflowStatus');
      await updateItemFields(record, { [statusFieldName]: mergedStatus });
    } catch (err) {
      console.error('[PrTrackerStrip] Failed to apply merged status:', err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      data-testid="pr-tracker-stale-hint"
      disabled={busy}
      onClick={() => void apply()}
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium text-nim-warning bg-nim-warning/10 hover:bg-nim-warning/20 transition-colors disabled:opacity-60"
      title={`This PR is merged but ${record.issueKey ?? 'the tracker item'} is still ${getRecordStatus(record)} — click to set ${option?.label ?? mergedStatus}`}
    >
      <MaterialSymbol icon="warning" size={12} />
      PR merged — set {option?.label ?? mergedStatus}?
    </button>
  );
}

export function PrTrackerStrip({
  workspacePath,
  remote,
  prNumber,
  prState,
}: PrTrackerStripProps): JSX.Element {
  const { items, primary, sessions } = usePrTrackerContext(workspacePath, remote, prNumber);
  const alreadyLinkedIds = useMemo(() => new Set(items.map((i) => i.id)), [items]);
  const setWindowMode = useSetAtom(setWindowModeAtom);

  const openSession = (sessionId: string) => {
    void dispatchOpenSessionInTab(sessionId).then(() => setWindowMode('agent'));
  };

  const notes = typeof primary?.fields.notes === 'string' ? primary.fields.notes : '';

  return (
    <div className="pr-tracker-strip px-4 pb-1" data-testid="pr-tracker-strip">
      <div className="flex items-center gap-2 flex-wrap min-w-0">
        {items.map((item) => (
          <span key={item.id} className="inline-flex items-center gap-1 min-w-0">
            {item.issueKey && (
              <button
                type="button"
                data-testid="pr-tracker-chip"
                className="font-mono text-[11px] text-nim-muted hover:text-nim hover:underline transition-colors"
                onClick={() => navigateToTrackerItem(item.id)}
                title={`Open ${item.issueKey} in tracker`}
              >
                {item.issueKey}
              </button>
            )}
            <StatusPill record={item} />
            {prState === 'merged' && <StaleItemHint record={item} />}
          </span>
        ))}
        <SessionsButton sessions={sessions} onOpen={openSession} />
        <LinkTrackerItemButton remote={remote} prNumber={prNumber} alreadyLinkedIds={alreadyLinkedIds} />
      </div>
      {notes && (
        <div
          className="mt-1 text-[11px] text-nim-faint truncate select-text"
          data-testid="pr-tracker-notes"
          title={notes}
        >
          {notes}
        </div>
      )}
    </div>
  );
}
