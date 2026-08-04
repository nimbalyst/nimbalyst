import React, { useEffect, useMemo, useRef, useState } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';

import type { ConversationDirectoryEntry } from '../../../shared/conversationDirectory';
import { OrgDialog, OrgDialogSecondaryButton } from './OrgDialog';
import { openOrCreateDirectMessage } from './roomManagementActions';
import {
  buildComposeDestinations,
  type ComposeDestination,
} from './roomManagementViewModel';
import type { OrgRosterMember } from './useOrgRoster';

/**
 * The Inbox's "New message" destination picker.
 *
 * One list over rooms and people: picking a room opens it, picking a person
 * opens the direct message with them, creating it when none is known. It does
 * not compose the message itself — the room's own composer is the one place
 * mentions, resource refs and agent posting are already wired.
 *
 * Driven entirely from the search field: the caret never leaves it, arrows move
 * the highlight, Enter opens the highlighted destination, and Escape closes
 * (`OrgDialog` owns that key). This is the whole point of the Cmd+K entry — the
 * flow from shortcut to a focused composer must never need the pointer.
 */
export function ComposeDestinationDialog({
  orgId,
  conversations,
  members,
  viewerUserId,
  participantsByConversationId,
  allowRooms = true,
  allowDirectMessages = true,
  onClose,
  onOpenConversation,
}: {
  orgId: string;
  conversations: readonly ConversationDirectoryEntry[];
  members: readonly OrgRosterMember[];
  viewerUserId: string | null;
  participantsByConversationId?: Readonly<Record<string, readonly string[]>>;
  /** False when the organization has turned rooms off; they leave the list. */
  allowRooms?: boolean;
  /** False when the organization has turned direct messages off. */
  allowDirectMessages?: boolean;
  onClose: () => void;
  onOpenConversation: (conversationId: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const destinations = useMemo(
    () => buildComposeDestinations({
      conversations,
      members,
      viewerUserId,
      query,
      allowRooms,
      allowDirectMessages,
    }),
    [allowDirectMessages, allowRooms, conversations, members, query, viewerUserId],
  );

  // Typing re-filters the list under the highlight, so it goes back to the top
  // match rather than pointing at whatever now happens to sit at that index.
  useEffect(() => { setActiveIndex(0); }, [query]);

  // Keep the highlight in view when the arrows walk past either edge of the
  // scrollable list.
  useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    // jsdom has no scrollIntoView, and neither does an unattached node.
    active?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex, destinations]);

  const choose = async (destination: ComposeDestination) => {
    if (busyId) return;
    if (destination.kind === 'room') {
      onOpenConversation(destination.id);
      return;
    }
    setBusyId(destination.id);
    setError(null);
    try {
      const conversationId = await openOrCreateDirectMessage({
        orgId,
        selectedMemberIds: [destination.id],
        viewerUserId,
        conversations,
        participantsByConversationId,
      });
      onOpenConversation(conversationId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setBusyId(null);
    }
  };

  const onSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (destinations.length === 0) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      // Wraps, so a long list is reachable from either end without holding a
      // key down past the far edge.
      const step = event.key === 'ArrowDown' ? 1 : -1;
      event.preventDefault();
      setActiveIndex((current) => (
        (current + step + destinations.length) % destinations.length
      ));
      return;
    }
    if (event.key === 'Enter') {
      const destination = destinations[activeIndex];
      if (!destination) return;
      event.preventDefault();
      void choose(destination);
    }
  };

  return (
    <OrgDialog
      title="New message"
      description="Pick a room or a person to write to."
      testId="compose-destination-dialog"
      error={error}
      onClose={onClose}
      footer={(
        <OrgDialogSecondaryButton testId="compose-destination-cancel" onClick={onClose}>
          Cancel
        </OrgDialogSecondaryButton>
      )}
    >
      <div className="compose-destination-search relative mb-2">
        <MaterialSymbol
          icon="search"
          size={15}
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--nim-text-faint)]"
        />
        <input
          type="text"
          className="w-full rounded-md border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] py-2 pl-8 pr-3 text-[13px] text-[var(--nim-text)] outline-none focus:border-[var(--nim-primary)]"
          data-testid="compose-destination-search"
          placeholder="Search rooms and people"
          autoFocus
          role="combobox"
          aria-expanded={destinations.length > 0}
          aria-controls="compose-destination-list"
          aria-activedescendant={destinations[activeIndex]
            ? `compose-destination-${destinations[activeIndex].kind}-${destinations[activeIndex].id}`
            : undefined}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onSearchKeyDown}
        />
      </div>

      <div
        ref={listRef}
        id="compose-destination-list"
        role="listbox"
        className="compose-destination-list rounded-md border border-[var(--nim-border)]"
      >
        {destinations.length === 0 && (
          <p
            className="m-0 px-3 py-2 text-[12px] text-[var(--nim-text-muted)]"
            data-testid="compose-destination-empty"
          >
            {query ? `Nothing matches “${query}”.` : 'Nothing to write to yet.'}
          </p>
        )}
        {destinations.map((destination, index) => (
          <button
            key={`${destination.kind}-${destination.id}`}
            id={`compose-destination-${destination.kind}-${destination.id}`}
            type="button"
            role="option"
            aria-selected={index === activeIndex}
            // Kept out of the Tab order: the caret stays in the search field
            // and the arrows drive the highlight, so tabbing through every room
            // in the organization would only be a trap.
            tabIndex={-1}
            data-active={index === activeIndex}
            className={`compose-destination-row flex w-full items-center gap-2.5 px-3 py-2 text-left text-[12px] text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)] disabled:cursor-not-allowed disabled:text-[var(--nim-text-disabled)] ${
              index === activeIndex ? 'compose-destination-row-active bg-[var(--nim-bg-hover)]' : ''
            }`}
            data-testid={`compose-destination-${destination.kind}-${destination.id}`}
            disabled={busyId !== null}
            onMouseEnter={() => setActiveIndex(index)}
            onClick={() => { void choose(destination); }}
          >
            <MaterialSymbol
              icon={destination.icon}
              size={15}
              className="shrink-0 text-[var(--nim-text-faint)]"
            />
            <span className="min-w-0 flex-1 truncate">
              {destination.kind === 'room' ? `#${destination.label}` : destination.label}
            </span>
            {destination.sublabel && (
              <span className="min-w-0 shrink truncate text-[11px] text-[var(--nim-text-faint)]">
                {busyId === destination.id ? 'Opening…' : destination.sublabel}
              </span>
            )}
          </button>
        ))}
      </div>
    </OrgDialog>
  );
}
