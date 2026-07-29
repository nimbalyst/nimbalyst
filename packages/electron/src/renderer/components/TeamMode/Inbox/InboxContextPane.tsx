import React, { useMemo } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';
import { useStore } from 'jotai';

import { CommentThread } from '../../Comments/CommentThread';
import { createConversationCommentAdapter } from '../../Comments/ConversationCommentAdapter';
import type { CommentCapabilities } from '../../Comments/commentTypes';
import type { InboxRowView, InboxSubscriptionState } from './inboxTypes';

/**
 * The right-hand pane beside the list.
 *
 * Today it is the context surface for the selected delivery: what arrived, from
 * whom, where, and what you may do about it. The plan's compose-from-inbox flow
 * (destination picker + the destination rendered here while you write) mounts
 * into this same pane in a later phase — the composer below is the placeholder
 * for that slot and carries the read-only explanation now.
 */
export function InboxContextPane({
  row,
  conversationTransport = false,
  canChangeSubscription = false,
  onSubscriptionChange,
  onOpenSource,
}: {
  row: InboxRowView | null;
  conversationTransport?: boolean;
  /**
   * The provider can actually change the follow state. False hides the mute
   * control rather than offering a button whose handler does nothing.
   */
  canChangeSubscription?: boolean;
  onSubscriptionChange: (row: InboxRowView, state: InboxSubscriptionState) => void;
  onOpenSource: (row: InboxRowView) => void;
}) {
  if (!row) {
    return (
      <aside
        className="inbox-context-pane inbox-context-pane-empty flex min-w-0 flex-col items-center justify-center gap-2 border-l border-[var(--nim-border)] p-8 text-center"
        data-testid="inbox-context-pane"
        data-component="InboxContextPane"
      >
        <MaterialSymbol icon="chat" size={22} className="text-[var(--nim-text-faint)]" />
        <p className="m-0 max-w-[260px] text-[12px] leading-relaxed text-[var(--nim-text-muted)]">
          Select a delivery to see its context here, or start a new message to pick a destination.
        </p>
      </aside>
    );
  }

  const unavailable = row.availability !== 'available';
  // Carries the id rather than a boolean so the thread below cannot be mounted
  // without the conversation it is supposed to open.
  const conversationId =
    conversationTransport
    && !unavailable
    && row.sourceId
    && (
      row.sourceKind === 'roomMessage'
      || row.sourceKind === 'documentDiscussion'
      || row.sourceKind === 'dmMessage'
    )
      ? row.sourceId
      : null;

  return (
    <aside
      className="inbox-context-pane flex min-w-0 flex-col border-l border-[var(--nim-border)]"
      data-testid="inbox-context-pane"
      data-component="InboxContextPane"
    >
      <header className="inbox-context-header border-b border-[var(--nim-border)] px-4 py-3">
        <p className="m-0 text-[11px] font-semibold uppercase tracking-wide text-[var(--nim-text-faint)]">{row.reasonLabel}</p>
        <h3 className="m-0 mt-0.5 truncate text-[14px] font-semibold text-[var(--nim-text)]">
          {unavailable ? row.unavailableLabel : row.sourceTitle ?? 'Conversation'}
        </h3>
        <p className="m-0 mt-0.5 text-[11px] text-[var(--nim-text-faint)]">
          {row.orgName}
          {row.projectName ? ` · ${row.projectName}` : ''}
          {` · ${row.timestampLabel}`}
        </p>
      </header>

      {conversationId
        ? <InboxConversationThread row={row} conversationId={conversationId} />
        : <div className="inbox-context-body min-h-0 flex-1 overflow-y-auto p-4">
        {unavailable
          ? (
            <p className="m-0 flex items-start gap-2 text-[12px] leading-relaxed text-[var(--nim-text-muted)]" data-testid="inbox-context-unavailable">
              <MaterialSymbol icon="lock" size={14} className="mt-px shrink-0" />
              {row.availability === 'accessRemoved'
                ? 'You no longer have access to the source of this delivery. Dismiss it to clear it from your inbox.'
                : 'The source of this delivery was deleted. Dismiss it to clear it from your inbox.'}
            </p>
          )
          : (
            <>
              {row.actor && (
                <div className="inbox-context-actor mb-3 flex items-center gap-2">
                  {row.actor.kind === 'agent'
                    ? (
                      <span className="flex size-6 items-center justify-center rounded-md bg-[color-mix(in_srgb,var(--nim-primary)_18%,transparent)] text-[var(--nim-primary)]">
                        <MaterialSymbol icon="smart_toy" size={14} />
                      </span>
                    )
                    : (
                      <span className="flex size-6 items-center justify-center rounded-full bg-[var(--nim-bg-active)] text-[10px] font-semibold text-[var(--nim-text-muted)]">
                        {row.actor.displayName.slice(0, 1).toUpperCase()}
                      </span>
                    )}
                  <span className="text-[13px] font-medium text-[var(--nim-text)]">{row.actor.displayName}</span>
                  {row.actor.onBehalfOfDisplayName && (
                    <span className="text-[12px] text-[var(--nim-text-faint)]">for {row.actor.onBehalfOfDisplayName}</span>
                  )}
                  {row.actor.pending && (
                    <span className="flex items-center gap-1 rounded-full bg-[var(--nim-bg-tertiary)] px-1.5 text-[10px] text-[var(--nim-text-muted)]">
                      <MaterialSymbol icon="hourglass_top" size={10} /> Pending dispatch
                    </span>
                  )}
                </div>
              )}

              {row.preview && (
                <p className="inbox-context-preview m-0 select-text text-[13px] leading-relaxed text-[var(--nim-text)]">
                  {row.previewStale && (
                    <span className="mr-1.5 rounded bg-[var(--nim-bg-tertiary)] px-1 py-px text-[10px] uppercase tracking-wide text-[var(--nim-text-faint)]">Stale</span>
                  )}
                  {row.preview}
                </p>
              )}

              <p className="m-0 mt-3 text-[11px] text-[var(--nim-text-faint)]">
                This is the bounded preview stored with the delivery. Open the source for the current content.
              </p>

              <div className="inbox-context-actions mt-4 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="inbox-context-open rounded-md bg-[var(--nim-primary)] px-2.5 py-1 text-[12px] text-[var(--nim-on-primary)] hover:bg-[var(--nim-primary-hover)]"
                  data-testid="inbox-context-open"
                  onClick={() => onOpenSource(row)}
                >
                  Open source
                </button>
                {canChangeSubscription && row.subscription && (
                  <button
                    type="button"
                    className="inbox-context-subscription flex items-center gap-1.5 rounded-md border border-[var(--nim-border)] px-2.5 py-1 text-[12px] text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]"
                    data-testid="inbox-context-subscription"
                    onClick={() => onSubscriptionChange(row, row.subscription === 'muted' ? 'following' : 'muted')}
                  >
                    <MaterialSymbol icon={row.subscription === 'muted' ? 'notifications' : 'notifications_off'} size={14} />
                    {row.subscription === 'muted' ? 'Unmute' : 'Mute'}
                  </button>
                )}
              </div>
            </>
          )}
      </div>}

      {!conversationId && <footer className="inbox-context-composer border-t border-[var(--nim-border)] p-3" data-testid="inbox-context-composer">
        {row.canReply
          ? (
            <div className="inbox-composer-placeholder rounded-md border border-dashed border-[var(--nim-border)] px-3 py-2 text-[12px] text-[var(--nim-text-faint)]">
              The shared composer mounts here — replies and compose-from-inbox route through the destination's own create flow.
            </div>
          )
          : (
            <p
              className="inbox-composer-read-only m-0 flex items-start gap-1.5 text-[11px] leading-relaxed text-[var(--nim-text-faint)]"
              data-testid="inbox-composer-read-only"
            >
              <MaterialSymbol icon="visibility_lock" size={13} className="mt-px shrink-0" />
              {row.readOnlyReason ?? 'You can read this conversation but not post to it.'}
            </p>
          )}
      </footer>}
    </aside>
  );
}

function InboxConversationThread({
  row,
  conversationId,
}: {
  row: InboxRowView;
  conversationId: string;
}) {
  const targetStore = useStore();
  const capabilities = useMemo<CommentCapabilities>(() => ({
    read: true,
    comment: row.canReply,
    react: row.canReply,
    editOwn: row.canReply,
    deleteOwn: row.canReply,
    moderate: false,
    manageRoom: false,
  }), [row.canReply]);
  const viewerActor = useMemo(() => ({
    kind: 'user' as const,
    userId: row.viewerUserId,
    onBehalfOfUserId: row.viewerUserId,
  }), [row.viewerUserId]);
  const adapter = useMemo(
    () => createConversationCommentAdapter({
      orgId: row.orgId,
      conversationId,
      sourceKind:
        row.sourceKind === 'documentDiscussion'
          ? 'documentDiscussion'
          : row.sourceKind === 'dmMessage'
            ? 'dmMessage'
            : 'roomMessage',
      viewerActor,
      capabilities,
      store: targetStore,
    }),
    [
      capabilities,
      conversationId,
      row.orgId,
      row.sourceKind,
      targetStore,
      viewerActor,
    ],
  );
  const directory = useMemo(() => ({
    people: [{
      userId: row.viewerUserId,
      displayName: 'You',
      handle: 'you',
      avatarInitials: 'YO',
    }],
    agents: [],
    displayNames: { [row.viewerUserId]: 'You' },
  }), [row.viewerUserId]);

  return (
    <div
      className="inbox-context-conversation min-h-0 flex-1"
      data-testid="inbox-context-conversation"
    >
      <CommentThread
        adapter={adapter}
        capabilities={capabilities}
        context={{
          conversationId,
          conversationTitle: row.sourceTitle,
          // The authoritative flag is `ConversationDescriptor.agentPostingEnabled`,
          // which no inbox delivery carries — the descriptor is not synced to
          // this surface yet. Defaulting closed keeps agent posting opt-in until
          // the delivery (or a conversation lookup) can answer it.
          agentPostingEnabled: false,
          attachedAgentSessionIds: [],
          surfaceLabel: row.sourceTitle ?? 'Conversation',
        }}
        directory={directory}
        orgId={row.orgId}
        viewerUserId={row.viewerUserId}
        viewerActor={viewerActor}
      />
    </div>
  );
}
