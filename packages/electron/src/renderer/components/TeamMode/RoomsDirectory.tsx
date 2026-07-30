import React, { useCallback, useEffect, useState } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';

import { HelpTooltip } from '../../help';
import type { ConversationDirectoryEntry } from '../../../shared/conversationDirectory';
import {
  listConversationDirectory,
  setDirectoryConversationMembership,
} from '../../services/conversationDirectoryClient';
import { roomLabel } from './orgSidebarViewModel';

/**
 * "Browse rooms" — every room in the organization the viewer may see: public
 * rooms plus the private ones they belong to, with archived rooms behind a
 * filter because they are deliberately absent from the sidebar.
 *
 * Joining a public room adds an explicit membership. Access does not depend on
 * it (the server grants every active member read/comment on public rooms), but
 * membership is what makes the room follow you into the inbox.
 */
export function RoomsDirectory({
  orgId,
  viewerUserId,
  onOpenConversation,
  onCreateRoom,
}: {
  orgId: string;
  viewerUserId: string | null;
  onOpenConversation: (conversationId: string) => void;
  onCreateRoom?: () => void;
}) {
  const [rooms, setRooms] = useState<ConversationDirectoryEntry[]>([]);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [joined, setJoined] = useState<Record<string, boolean>>({});
  const [joining, setJoining] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const conversations = await listConversationDirectory({
        orgId,
        includeDirect: false,
        includeArchived,
      });
      setRooms(conversations.filter((entry) => entry.kind === 'orgRoom'));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, [includeArchived, orgId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const join = useCallback(async (conversationId: string) => {
    if (!viewerUserId) return;
    setJoining(conversationId);
    setError(null);
    try {
      await setDirectoryConversationMembership({
        orgId,
        conversationId,
        userId: viewerUserId,
        active: true,
      });
      setJoined((current) => ({ ...current, [conversationId]: true }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setJoining(null);
    }
  }, [orgId, viewerUserId]);

  return (
    <section
      className="org-rooms-directory flex h-full min-h-0 flex-col"
      data-testid="org-rooms-directory"
      data-component="RoomsDirectory"
    >
      <header
        className="org-rooms-directory-header org-window-drag-region shrink-0 border-b border-[var(--nim-border)] px-5 py-4"
        data-window-drag-region="true"
      >
        <div className="flex items-center gap-2">
          <h2 className="m-0 text-[15px] font-semibold text-[var(--nim-text)]">Browse rooms</h2>
          <div className="ml-auto flex items-center gap-2">
            <label className="org-rooms-archived-filter org-window-no-drag flex items-center gap-1.5 text-[12px] text-[var(--nim-text-muted)]">
              <input
                type="checkbox"
                className="org-window-no-drag"
                data-testid="org-rooms-archived-filter"
                checked={includeArchived}
                onChange={(event) => setIncludeArchived(event.target.checked)}
              />
              Show archived
            </label>
            <HelpTooltip testId="org-rooms-create" disabled={!onCreateRoom}>
              <button
                type="button"
                className="org-rooms-create org-window-no-drag rounded-md bg-[var(--nim-primary)] px-2.5 py-1 text-[12px] text-[var(--nim-on-primary)] hover:bg-[var(--nim-primary-hover)] disabled:cursor-not-allowed disabled:opacity-60"
                data-testid="org-rooms-create"
                disabled={!onCreateRoom}
                title={onCreateRoom
                  ? 'New room'
                  : 'Only organization admins can create rooms'}
                onClick={onCreateRoom}
              >
                New room
              </button>
            </HelpTooltip>
          </div>
        </div>
        <p className="m-0 mt-1 text-[12px] text-[var(--nim-text-muted)]">
          Public rooms are open to everyone in this organization. Private rooms appear only when you belong to them.
        </p>
      </header>

      {error && (
        <p
          className="org-rooms-directory-error m-0 flex select-text items-center gap-1.5 border-b border-[var(--nim-border)] bg-[color-mix(in_srgb,var(--nim-error)_10%,transparent)] px-5 py-2 text-[12px] text-[var(--nim-text)]"
          data-testid="org-rooms-directory-error"
          role="status"
        >
          <MaterialSymbol icon="error" size={14} /> {error}
        </p>
      )}

      <div className="org-rooms-directory-list min-h-0 flex-1 overflow-y-auto p-3">
        {loading && (
          <p className="m-0 px-2 py-1 text-[12px] text-[var(--nim-text-muted)]">Loading rooms…</p>
        )}
        {!loading && rooms.length === 0 && (
          <RoomsDirectoryEmpty
            includeArchived={includeArchived}
            onCreateRoom={onCreateRoom}
          />
        )}
        {rooms.map((entry) => {
          const archived = entry.archivedAt !== undefined;
          return (
            <div
              key={entry.id}
              className="org-rooms-directory-row flex items-center gap-3 rounded-md px-3 py-2 hover:bg-[var(--nim-bg-hover)]"
              data-testid={`org-rooms-directory-row-${entry.id}`}
            >
              <MaterialSymbol
                icon={entry.visibility === 'private' ? 'lock' : 'tag'}
                size={16}
                className="shrink-0 text-[var(--nim-text-faint)]"
              />
              <div className="min-w-0 flex-1 select-text">
                <p className="m-0 truncate text-[13px] font-medium text-[var(--nim-text)]">
                  {roomLabel(entry)}
                  {archived && (
                    <span className="ml-1.5 rounded bg-[var(--nim-bg-tertiary)] px-1.5 text-[10px] uppercase tracking-wide text-[var(--nim-text-faint)]">
                      Archived
                    </span>
                  )}
                </p>
                {entry.topic && (
                  <p className="m-0 truncate text-[11px] text-[var(--nim-text-muted)]">{entry.topic}</p>
                )}
              </div>
              {entry.visibility === 'public' && !archived && (
                <button
                  type="button"
                  className="org-rooms-directory-join shrink-0 rounded-md border border-[var(--nim-border)] px-2.5 py-1 text-[12px] text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)] disabled:cursor-not-allowed disabled:text-[var(--nim-text-disabled)]"
                  data-testid={`org-rooms-directory-join-${entry.id}`}
                  disabled={!viewerUserId || joined[entry.id] || joining === entry.id}
                  title={viewerUserId ? 'Join this room' : 'Resolving your membership…'}
                  onClick={() => { void join(entry.id); }}
                >
                  {joined[entry.id] ? 'Joined' : joining === entry.id ? 'Joining…' : 'Join'}
                </button>
              )}
              <button
                type="button"
                className="org-rooms-directory-open shrink-0 rounded-md bg-[var(--nim-primary)] px-2.5 py-1 text-[12px] text-[var(--nim-on-primary)] hover:bg-[var(--nim-primary-hover)]"
                data-testid={`org-rooms-directory-open-${entry.id}`}
                onClick={() => onOpenConversation(entry.id)}
              >
                Open
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/**
 * The directory with nothing in it.
 *
 * `#general` is auto-seeded per organization, so a genuinely empty directory
 * means the listing has not reached this client rather than "your org has no
 * rooms" — the copy points at the action that resolves it instead of stating
 * an emptiness the user cannot act on.
 */
function RoomsDirectoryEmpty({
  includeArchived,
  onCreateRoom,
}: {
  includeArchived: boolean;
  onCreateRoom?: () => void;
}) {
  return (
    <div
      className="org-rooms-directory-empty flex flex-col items-center gap-2 px-8 py-14 text-center"
      data-testid="org-rooms-directory-empty"
    >
      <span className="flex size-11 items-center justify-center rounded-full bg-[var(--nim-bg-tertiary)] text-[var(--nim-text-faint)]">
        <MaterialSymbol icon="forum" size={22} />
      </span>
      <h3 className="m-0 text-[14px] font-semibold text-[var(--nim-text)]">No rooms to show</h3>
      <p className="m-0 max-w-[420px] text-[12px] leading-relaxed text-[var(--nim-text-muted)]">
        {includeArchived
          ? 'This organization has no rooms you can see, archived ones included.'
          : 'This organization has no rooms you can see yet. Private rooms appear here once you are added to them.'}
      </p>
      {onCreateRoom && (
        <button
          type="button"
          className="org-rooms-directory-empty-create mt-1 rounded-md border border-[var(--nim-border)] px-2.5 py-1 text-[12px] text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]"
          data-testid="org-rooms-directory-empty-create"
          onClick={onCreateRoom}
        >
          Create the first room
        </button>
      )}
    </div>
  );
}
