import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';

import { InboxContextPane } from './InboxContextPane';
import { InboxEmptyState, InboxOfflineWithoutCache } from './InboxEmptyState';
import { InboxFilterBar } from './InboxFilterBar';
import { InboxRow } from './InboxRow';
import { InboxSearchEscalation, InboxSearchField } from './InboxSearchField';
import { InboxSkeleton } from './InboxSkeleton';
import { InboxStatusBanner } from './InboxStatusBanner';
import { InboxStatePicker } from './InboxStatePicker';
import { DEFAULT_INBOX_PREFERENCES, persistInboxPreferences, readInboxPreferences } from './inboxPreferences';
import {
  consumeInboxSearchFocusRequest,
  subscribeInboxSearchFocus,
} from '../orgWindowCommandBus';
import { useInboxProvider, type InboxProvider } from './inboxProvider';
import {
  INBOX_FILTERS,
  deriveScopeOptions,
  groupRows,
  isScopeActive,
  openRow,
  selectRows,
} from './inboxViewModel';
import { EMPTY_INBOX_SCOPE, type InboxFilterId, type InboxRowView, type InboxScope, type InboxSubscriptionState } from './inboxTypes';

/** How often relative timestamps re-render in the absence of any data change. */
const RELATIVE_LABEL_TICK_MS = 60_000;

/**
 * The messaging Inbox — the first section of the organization-management window.
 *
 * Reads exclusively from an `InboxProvider` and renders only `InboxRowView`s
 * produced by `toRowView`, which is what keeps an unavailable delivery from
 * leaking its former source. With no provider mounted above it, the surface
 * shows an empty inbox — fixtures only arrive when a caller injects them.
 *
 * Layout: list plus a right-hand context pane. The pane is a container query
 * away — below `inbox-surface` 900px it collapses and the list takes the full
 * width, which is what the org window's default size produces today.
 */
export function InboxSection({
  provider: providerProp,
  now: nowProp,
  onBrowseRooms,
  onNewMessage,
  composeUnavailableLabel = 'Compose is available in the organization window',
}: {
  provider?: InboxProvider;
  /** Deterministic clock seam for grouping and relative-label tests. */
  now?: number;
  /**
   * Where "Browse rooms" goes. Supplied by the org window, which owns the
   * rooms directory; absent when the Inbox is mounted without one.
   */
  onBrowseRooms?: () => void;
  /**
   * Opens the compose destination picker. Supplied by the org window, which
   * owns the conversation directory the picker lists; the control renders
   * disabled without it rather than doing nothing when clicked.
   */
  onNewMessage?: () => void;
  /**
   * Why compose is unavailable, when it is. The default speaks to the project
   * window; the org window overrides it when the organization turned messaging
   * off, where "open the organization window" would be nonsense advice.
   */
  composeUnavailableLabel?: string;
} = {}) {
  const provider = useInboxProvider(providerProp);

  const snapshot = useSyncExternalStore(provider.subscribe, provider.getSnapshot, provider.getSnapshot);

  const [filter, setFilter] = useState<InboxFilterId>(DEFAULT_INBOX_PREFERENCES.filter);
  const [unreadOnly, setUnreadOnly] = useState<boolean>(DEFAULT_INBOX_PREFERENCES.unreadOnly);
  const [scope, setScope] = useState<InboxScope>(DEFAULT_INBOX_PREFERENCES.scope);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activationNotice, setActivationNotice] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const preferencesLoaded = useRef(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // Messages > Search Messages. The command routes the window to the Inbox
  // first, so it may well arrive before this surface exists — hence the latched
  // request, consumed either on mount or on notification, whichever comes second.
  useEffect(() => {
    const focusSearch = () => {
      if (!consumeInboxSearchFocusRequest()) return;
      const input = searchInputRef.current;
      if (!input) return;
      input.focus();
      input.select();
    };
    focusSearch();
    return subscribeInboxSearchFocus(focusSearch);
  }, []);

  useEffect(() => {
    // A quiet inbox still ages: without a tick, "12m" would sit there until the
    // next delivery arrived. One coarse tick a minute matches the finest
    // granularity `formatRelativeTimestamp` renders.
    if (nowProp !== undefined) return;
    const timer = setInterval(() => setTick((value) => value + 1), RELATIVE_LABEL_TICK_MS);
    return () => clearInterval(timer);
  }, [nowProp]);

  // `now` is frozen per render pass so relative labels and day grouping stay
  // stable while the user types; the provider re-renders on real changes.
  const now = useMemo(() => nowProp ?? Date.now(), [nowProp, snapshot, tick]);

  useEffect(() => {
    let cancelled = false;
    void readInboxPreferences().then((preferences) => {
      if (cancelled) return;
      setFilter(preferences.filter);
      setUnreadOnly(preferences.unreadOnly);
      setScope(preferences.scope);
      preferencesLoaded.current = true;
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    // Don't write back the defaults before the stored value has been read.
    if (!preferencesLoaded.current) return;
    void persistInboxPreferences({ filter, unreadOnly, scope });
  }, [filter, unreadOnly, scope]);

  const loading = snapshot.status === 'loading';
  const offline = snapshot.status === 'offlineWithCache' || snapshot.status === 'offlineWithoutCache';
  const offlineWithoutCache = snapshot.status === 'offlineWithoutCache';

  const { rows, scoped, counts, unreadInScope, typeCounts } = useMemo(
    () => selectRows({
      deliveries: snapshot.deliveries,
      filter,
      unreadOnly,
      scope,
      query,
      now,
      stalePreviews: offline,
    }),
    [snapshot.deliveries, filter, unreadOnly, scope, query, now, offline],
  );

  const scopeOptions = useMemo(() => deriveScopeOptions(snapshot.deliveries), [snapshot.deliveries]);
  const groups = useMemo(() => groupRows(rows, now), [rows, now]);
  const selectedRow = useMemo(() => rows.find((row) => row.id === selectedId) ?? null, [rows, selectedId]);
  const filterLabel = INBOX_FILTERS.find((entry) => entry.id === filter)?.label ?? 'All';

  // Selecting is free: it fills the context pane and never moves you. Every
  // navigation is an explicit second act, so a click is safe to spend on
  // reading a row you are not sure about.
  const handleSelect = useCallback((row: InboxRowView) => {
    setSelectedId(row.id);
    setActivationNotice(null);
  }, []);

  const handleOpen = useCallback(async (row: InboxRowView) => {
    setSelectedId(row.id);
    setActivationNotice(null);
    const result = await openRow(row, {
      navigate: (target) => provider.navigate(target),
      markRead: (id) => provider.markRead([id]),
    });
    if (result.outcome === 'navigationFailed') {
      // Read state is the user's record of what they have actually seen. A
      // failed open must not consume it.
      setActivationNotice('Could not open that conversation. It stays unread.');
    }
  }, [provider]);

  const handleMarkAllRead = useCallback(() => {
    // Scoped to the active filter, per the plan; the search query does not
    // narrow it, so nothing silently escapes the batch.
    void provider.markRead(scoped.filter((row) => row.unread).map((row) => row.id));
  }, [provider, scoped]);

  const handleSubscription = useCallback((row: InboxRowView, state: InboxSubscriptionState) => {
    // The control is hidden when the provider cannot mute, so this is a residual
    // path only; a rejection must not surface as an unhandled rejection.
    void provider.setSubscriptionState?.(row.id, state).catch(() => undefined);
  }, [provider]);

  const clearFilters = useCallback(() => {
    setFilter('all');
    setUnreadOnly(false);
    setScope(EMPTY_INBOX_SCOPE);
    setQuery('');
  }, []);

  return (
    <section
      className="inbox-surface flex h-full min-h-0 flex-col [container-name:inbox-surface] [container-type:inline-size]"
      data-testid="inbox-surface"
      data-component="InboxSection"
      data-source="packages/electron/src/renderer/components/TeamMode/Inbox/InboxSection.tsx"
      data-status={snapshot.status}
    >
      <header
        className="inbox-header org-window-drag-region shrink-0 border-b border-[var(--nim-border)] px-5 py-4"
        data-window-drag-region="true"
      >
        <div className="inbox-header-title flex items-center gap-2">
          <h2 className="m-0 text-[15px] font-semibold text-[var(--nim-text)]">Inbox</h2>
          {unreadInScope > 0 && (
            <span
              className="inbox-header-unread rounded-full bg-[var(--nim-primary)] px-1.5 text-[10px] font-semibold leading-4 text-[var(--nim-on-primary)]"
              data-testid="inbox-header-unread"
            >
              {unreadInScope}
            </span>
          )}
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              className="inbox-mark-all-read org-window-no-drag rounded-md border border-[var(--nim-border)] px-2.5 py-1 text-[12px] text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)] disabled:cursor-not-allowed disabled:text-[var(--nim-text-disabled)]"
              data-testid="inbox-mark-all-read"
              disabled={loading || unreadInScope === 0}
              title={`Mark everything in ${filterLabel} as read`}
              onClick={handleMarkAllRead}
            >
              Mark {filterLabel.toLowerCase()} read
            </button>
            <button
              type="button"
              className="inbox-new-message org-window-no-drag flex items-center gap-1.5 rounded-md bg-[var(--nim-primary)] px-2.5 py-1 text-[12px] text-[var(--nim-on-primary)] hover:bg-[var(--nim-primary-hover)] disabled:cursor-not-allowed disabled:opacity-60"
              data-testid="inbox-new-message"
              disabled={!onNewMessage}
              title={onNewMessage
                ? 'Write to a room or a person'
                : composeUnavailableLabel}
              onClick={onNewMessage}
            >
              <MaterialSymbol icon="edit_square" size={14} /> New message
            </button>
          </div>
        </div>

        {/* The alpha disclosure is the org window's bottom status bar now
            (2026-07-28 layout decision) — two lines of it above every Inbox
            was the thing being replaced. */}
        <div className="inbox-controls org-window-no-drag mt-3 flex flex-col gap-2">
          <InboxSearchField value={query} filterLabel={filterLabel} disabled={loading} inputRef={searchInputRef} onChange={setQuery} />
          <InboxFilterBar
            filter={filter}
            counts={counts}
            unreadOnly={unreadOnly}
            unreadCount={unreadInScope}
            typeCounts={typeCounts}
            scope={scope}
            scopeOptions={scopeOptions}
            disabled={loading}
            onFilterChange={setFilter}
            onUnreadOnlyChange={setUnreadOnly}
            onScopeChange={setScope}
          />
        </div>
      </header>

      <InboxStatusBanner status={snapshot.status} lastSyncedAt={snapshot.lastSyncedAt} now={now} />

      {snapshot.unavailableOrganizations?.map((organization) => (
        <div
          key={organization.orgId}
          className="inbox-organization-unavailable flex items-center gap-3 border-b border-[var(--nim-border)] bg-[color-mix(in_srgb,var(--nim-warning)_10%,transparent)] px-5 py-2.5 text-[12px] text-[var(--nim-text)]"
          data-testid={`inbox-organization-unavailable-${organization.orgId}`}
          data-org-id={organization.orgId}
        >
          <MaterialSymbol icon="encrypted_off" size={15} />
          <span className="min-w-0 flex-1">
            Messaging is not available for {organization.orgName}. Migrate this organization to server-managed encryption to enable it.
          </span>
          <button
            type="button"
            className="inbox-organization-migrate shrink-0 rounded-md border border-[var(--nim-border)] bg-[var(--nim-bg)] px-2.5 py-1 text-[12px] hover:bg-[var(--nim-bg-hover)]"
            onClick={() => {
              void provider.migrateOrganization(organization.orgId);
            }}
          >
            Migrate organization
          </button>
        </div>
      ))}

      {activationNotice && (
        <p
          className="inbox-activation-notice m-0 flex items-center gap-1.5 border-b border-[var(--nim-border)] bg-[color-mix(in_srgb,var(--nim-error)_10%,transparent)] px-5 py-2 text-[12px] text-[var(--nim-text)]"
          data-testid="inbox-activation-notice"
          role="status"
        >
          <MaterialSymbol icon="error" size={14} /> {activationNotice}
        </p>
      )}

      <div className="inbox-body flex min-h-0 flex-1">
        <div className="inbox-list-pane min-w-0 flex-1 overflow-y-auto" data-testid="inbox-list-pane">
          {loading && <InboxSkeleton />}

          {!loading && offlineWithoutCache && <InboxOfflineWithoutCache />}

          {!loading && !offlineWithoutCache && rows.length === 0 && (
            <InboxEmptyState
              filter={filter}
              unreadOnly={unreadOnly}
              query={query}
              scopeActive={isScopeActive(scope)}
              onClearFilters={clearFilters}
              onBrowse={onBrowseRooms}
            >
              {query ? <InboxSearchEscalation query={query} matchCount={0} onEscalate={() => { /* federated search lands in Phase 4 */ }} /> : null}
            </InboxEmptyState>
          )}

          {!loading && !offlineWithoutCache && rows.length > 0 && (
            <div className="inbox-list" data-testid="inbox-list" role="list">
              {groups.map((group) => (
                <div key={group.id} className="inbox-list-group" data-testid={`inbox-group-${group.id}`}>
                  <div className="inbox-list-group-label sticky top-0 z-[1] bg-[var(--nim-bg)] px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--nim-text-faint)]">
                    {group.label}
                  </div>
                  {group.rows.map((row) => (
                    <InboxRow
                      key={row.id}
                      row={row}
                      selected={row.id === selectedId}
                      onSelect={handleSelect}
                      onOpen={(target) => { void handleOpen(target); }}
                      onDismiss={(target) => { void provider.dismiss(target.id); }}
                    />
                  ))}
                </div>
              ))}

              {query && (
                <div className="inbox-list-escalation border-t border-[var(--nim-border)] px-4 py-3">
                  <InboxSearchEscalation query={query} matchCount={rows.length} onEscalate={() => { /* federated search lands in Phase 4 */ }} />
                </div>
              )}
            </div>
          )}
        </div>

        <div className="inbox-context-slot w-[340px] shrink-0" data-testid="inbox-context-slot">
          <InboxContextPane
            row={selectedRow}
            conversationTransport={provider.conversationTransport === true}
            canChangeSubscription={provider.setSubscriptionState !== undefined}
            onSubscriptionChange={handleSubscription}
            onOpenSource={(row) => { void handleOpen(row); }}
          />
        </div>
      </div>

      {provider.simulateStatus && (
        <InboxStatePicker status={snapshot.status} onChange={(status) => provider.simulateStatus?.(status)} />
      )}
    </section>
  );
}
