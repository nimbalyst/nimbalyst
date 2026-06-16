/**
 * TrackerItemDetail - Detail/edit panel for a selected tracker item.
 * Shows all model-defined fields with real editors, description area,
 * and metadata. Appears as a right-side panel in TrackerMainView.
 *
 * For native (database-stored) items, includes an embedded Lexical editor
 * for rich content editing with debounced saves to PGLite.
 */

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { NimbalystEditor, MaterialSymbol, ProviderIcon } from '@nimbalyst/runtime';
import type { EditorConfig } from '@nimbalyst/runtime/editor';
import { $convertFromEnhancedMarkdownString, getEditorTransformers } from '@nimbalyst/runtime/editor';
import { $getRoot } from 'lexical';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import { globalRegistry } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import type { FieldDefinition } from '@nimbalyst/runtime/plugins/TrackerPlugin/models/TrackerDataModel';
import { getRecordTitle, getRecordStatus, getRecordPriority, getRecordField } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerRecordAccessors';
import { TrackerFieldEditor, type TeamMemberOption } from '@nimbalyst/runtime/plugins/TrackerPlugin/components/TrackerFieldEditor';
import { UserAvatar } from '@nimbalyst/runtime/plugins/TrackerPlugin/components/UserAvatar';
import { trackerItemByIdAtom } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerDataAtoms';
import { refreshSessionListAtom, sessionRegistryAtom, type SessionMeta } from '../../store/atoms/sessions';
import { buildTrackerDeepLink } from '../../store/atoms/collabDocuments';
import { errorNotificationService } from '../../services/ErrorNotificationService';
import { getRelativeTimeString } from '../../utils/dateFormatting';
import { useTrackerContentCollab } from '../../hooks/useTrackerContentCollab';
import { reconcileExternalFieldChanges } from './trackerDetailFieldSync';

interface TrackerItemDetailProps {
  itemId: string;
  workspacePath?: string;
  onClose: () => void;
  onSwitchToFilesMode?: () => void;
  onSwitchToAgentMode?: (sessionId: string) => void;
  onLaunchSession?: (trackerItemId: string) => void;
  onArchive?: (itemId: string, archive: boolean) => void;
  onDelete?: (itemId: string) => void;
}

const STATUS_COLORS: Record<string, string> = {
  'to-do': '#6b7280',
  'in-progress': '#eab308',
  'in-review': '#8b5cf6',
  'done': '#22c55e',
  'blocked': '#ef4444',
};

const PRIORITY_COLORS: Record<string, string> = {
  critical: '#dc2626',
  high: '#f97316',
  medium: '#eab308',
  low: '#6b7280',
};

const TYPE_COLORS: Record<string, string> = {
  bug: '#dc2626',
  task: '#2563eb',
  plan: '#7c3aed',
  idea: '#ca8a04',
  decision: '#8b5cf6',
  feature: '#10b981',
};

function getTypeIcon(type: string): string {
  const icons: Record<string, string> = {
    bug: 'bug_report',
    task: 'check_box',
    plan: 'assignment',
    idea: 'lightbulb',
    decision: 'gavel',
    feature: 'rocket_launch',
  };
  return icons[type] || 'label';
}

function formatTimestamp(value: string | Date | number | undefined): string {
  if (!value) return '\u2014';
  const date = value instanceof Date ? value : new Date(value);
  if (isNaN(date.getTime()) || date.getTime() === 0) return '\u2014';
  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Whether this record is a native DB item (no file backing) */
function isNativeItem(record: TrackerRecord): boolean {
  return record.source === 'native' || !record.system.documentPath;
}

/** Whether this record's metadata fields are editable */
function isEditable(record: TrackerRecord): boolean {
  return isNativeItem(record) || record.source === 'frontmatter' || record.source === 'import' || record.source === 'inline';
}

/** Source label for the metadata footer */
function getSourceLabel(record: TrackerRecord): string | null {
  if (!record.source || record.source === 'native') return 'Database (no file backing)';
  if (record.source === 'inline') return `Inline marker${record.sourceRef ? ` in ${record.sourceRef}` : ''}`;
  if (record.source === 'frontmatter') return `Frontmatter${record.sourceRef ? ` in ${record.sourceRef}` : ''}`;
  if (record.source === 'import') return `Imported${record.sourceRef ? ` from ${record.sourceRef}` : ''}`;
  return null;
}

/** Inline editor for adding/removing secondary type tags */
const TypeTagsEditor: React.FC<{
  typeTags: string[];
  primaryType: string;
  onUpdate: (tags: string[]) => void;
}> = ({ typeTags, primaryType, onUpdate }) => {
  const [isOpen, setIsOpen] = useState(false);
  const allModels = globalRegistry.getAll().filter(m => m.primaryCapable !== false && m.creatable !== false);
  const secondaryTags = typeTags.filter(t => t !== primaryType);
  const availableTypes = allModels.filter(m => m.type !== primaryType && !typeTags.includes(m.type));

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <span className="text-[10px] text-nim-faint font-medium uppercase tracking-wider">Type Tags</span>
        <button
          className="text-[10px] text-nim-muted hover:text-nim px-1 py-0.5 rounded hover:bg-nim-tertiary"
          onClick={() => setIsOpen(!isOpen)}
        >
          {isOpen ? 'Done' : '+ Add'}
        </button>
      </div>
      {secondaryTags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {secondaryTags.map(tag => {
            const tagModel = globalRegistry.get(tag);
            const tagColor = TYPE_COLORS[tag] || '#6b7280';
            return (
              <span
                key={tag}
                className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded cursor-pointer group"
                style={{ color: tagColor, backgroundColor: `${tagColor}15`, border: `1px solid ${tagColor}30` }}
                onClick={() => onUpdate(typeTags.filter(t => t !== tag))}
                title={`Remove ${tagModel?.displayName || tag} tag`}
              >
                {tagModel?.displayName || tag}
                <span className="opacity-0 group-hover:opacity-100 text-[9px]">&times;</span>
              </span>
            );
          })}
        </div>
      )}
      {isOpen && availableTypes.length > 0 && (
        <div className="flex flex-wrap gap-1 pt-1">
          {availableTypes.map(m => {
            const tagColor = TYPE_COLORS[m.type] || '#6b7280';
            return (
              <button
                key={m.type}
                className="text-[10px] font-medium px-1.5 py-0.5 rounded hover:opacity-80"
                style={{ color: tagColor, backgroundColor: `${tagColor}10`, border: `1px dashed ${tagColor}40` }}
                onClick={() => {
                  onUpdate([...typeTags, m.type]);
                }}
              >
                + {m.displayName}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

export const TrackerItemDetail: React.FC<TrackerItemDetailProps> = ({
  itemId,
  workspacePath,
  onClose,
  onSwitchToFilesMode,
  onSwitchToAgentMode,
  onLaunchSession,
  onArchive,
  onDelete,
}) => {
  // Read directly from per-item atom -- only re-renders when THIS item changes,
  // not when any other item in the workspace updates.
  const item = useAtomValue(trackerItemByIdAtom(itemId));
  const sessionRegistry = useAtomValue(sessionRegistryAtom);
  const refreshSessionList = useSetAtom(refreshSessionListAtom);

  const model = useMemo(() => globalRegistry.get(item?.primaryType ?? ''), [item?.primaryType]);

  // Detect whether this workspace has a team. The team check feeds the
  // content editor mode (collab vs local); the member list feeds the
  // assignee picker. NIM-638: these are split into two effects so a slow
  // or hung `team:list-members` doesn't strand `teamOrgId === undefined`
  // and keep the collab editor stuck on "Connecting..." forever -- the
  // editor only needs the orgId, not the members.
  //
  // Tri-state `teamOrgId`:
  //   undefined -- team lookup pending
  //   null      -- confirmed no team for this workspace
  //   string    -- orgId resolved
  const [teamOrgId, setTeamOrgId] = useState<string | null | undefined>(undefined);
  const [teamMembers, setTeamMembers] = useState<TeamMemberOption[]>([]);

  const handleCopyLink = useCallback(async () => {
    if (!item || !teamOrgId) return;
    const url = buildTrackerDeepLink(item.id, teamOrgId);
    try {
      await navigator.clipboard.writeText(url);
      errorNotificationService.showInfo(
        'Link copied',
        'Paste it anywhere to open this tracker in Nimbalyst.',
        { duration: 3000 }
      );
    } catch (err) {
      console.error('[TrackerItemDetail] Failed to copy link:', err);
      errorNotificationService.showError(
        'Copy failed',
        'Could not write the link to the clipboard.'
      );
    }
  }, [item, teamOrgId]);

  useEffect(() => {
    if (!workspacePath) {
      setTeamOrgId(null);
      setTeamMembers([]);
      return;
    }
    let cancelled = false;
    setTeamOrgId(undefined);
    setTeamMembers([]);
    (async () => {
      try {
        const teamResult = await window.electronAPI.invoke('team:find-for-workspace', workspacePath);
        if (cancelled) return;
        const orgId: string | null = teamResult?.success && teamResult.team?.orgId
          ? teamResult.team.orgId
          : null;
        setTeamOrgId(orgId);
      } catch {
        if (!cancelled) setTeamOrgId(null);
      }
    })();
    return () => { cancelled = true; };
  }, [workspacePath]);
  // Members load on a separate effect keyed on the resolved orgId so a
  // slow members call cannot block the editor. The list-members IPC has
  // its own server-side timeout (see fetchTeamApi); on failure the
  // assignee picker degrades to an empty list, which is fine.
  useEffect(() => {
    if (typeof teamOrgId !== 'string') {
      setTeamMembers([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const membersResult = await window.electronAPI.invoke('team:list-members', teamOrgId);
        if (cancelled) return;
        const members: TeamMemberOption[] = membersResult?.success && membersResult.members
          ? membersResult.members
              .filter((m: any) => m.email)
              .map((m: any) => ({ email: m.email, name: m.name || undefined }))
          : [];
        setTeamMembers(members);
      } catch {
        if (!cancelled) setTeamMembers([]);
      }
    })();
    return () => { cancelled = true; };
  }, [teamOrgId]);
  const typeColor = TYPE_COLORS[item?.primaryType ?? ''] || '#6b7280';
  const icon = model?.icon || getTypeIcon(item?.primaryType ?? '');

  // External-source provenance (source chip). origin lives in record system metadata.
  const externalOrigin =
    item?.system?.origin?.kind === 'external' ? item.system.origin.external : null;
  const [importerSummaries, setImporterSummaries] = useState<
    Array<{ id: string; displayName: string; icon: string }>
  >([]);
  const [resnapshotting, setResnapshotting] = useState(false);
  const [bodyBusy, setBodyBusy] = useState(false);
  const handleResnapshot = useCallback(async () => {
    if (!externalOrigin || !workspacePath || resnapshotting) return;
    setResnapshotting(true);
    try {
      await window.electronAPI.invoke('tracker:importer:resnapshot', {
        workspacePath,
        urn: externalOrigin.urn,
      });
    } catch (e) {
      errorNotificationService.showError(
        'Re-snapshot failed',
        e instanceof Error ? e.message : String(e)
      );
    } finally {
      setResnapshotting(false);
    }
  }, [externalOrigin, workspacePath, resnapshotting]);
  const handleBodyAction = useCallback(
    async (action: 'applyBody' | 'dismissBody') => {
      if (!externalOrigin || !workspacePath || bodyBusy) return;
      setBodyBusy(true);
      try {
        await window.electronAPI.invoke(`tracker:importer:${action}`, {
          workspacePath,
          urn: externalOrigin.urn,
        });
      } catch (e) {
        errorNotificationService.showError(
          'Update failed',
          e instanceof Error ? e.message : String(e)
        );
      } finally {
        setBodyBusy(false);
      }
    },
    [externalOrigin, workspacePath, bodyBusy]
  );
  useEffect(() => {
    if (!externalOrigin || !workspacePath) return;
    let cancelled = false;
    window.electronAPI
      .invoke('tracker:importer:list', workspacePath)
      .then((list: unknown) => {
        if (!cancelled && Array.isArray(list)) setImporterSummaries(list as typeof importerSummaries);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalOrigin?.providerId, workspacePath]);

  // Resolve linked sessions from registry (silently filter deleted ones)
  // Two sources: 1) tracker item's linkedSessions[] (forward link from DB items)
  //              2) sessions whose linkedTrackerItemIds contains this item's ID or file path (reverse link)
  const linkedSessions = useMemo(() => {
    const sessionSet = new Set<string>();

    // Forward: tracker record stores session IDs in system
    const forwardIds: string[] = item?.system?.linkedSessions || [];
    for (const id of forwardIds) sessionSet.add(id);

    // Reverse: sessions that link to this item by ID or by file path
    const trackerItemId = item?.id;
    const filePath = item?.system?.documentPath;
    const fileRef = filePath ? `file:${filePath}` : null;

    // console.log('[TrackerItemDetail] reverse lookup:', { trackerItemId, filePath, fileRef });

    sessionRegistry.forEach((session, sessionId) => {
      const linked = session.linkedTrackerItemIds;
      if (!linked) return;
      if (trackerItemId && linked.includes(trackerItemId)) sessionSet.add(sessionId);
      if (fileRef && linked.includes(fileRef)) sessionSet.add(sessionId);
    });

    if (sessionSet.size === 0) return [];
    return Array.from(sessionSet)
      .map(id => sessionRegistry.get(id))
      .filter((s): s is SessionMeta => s != null)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }, [item, sessionRegistry]);
  const linkedSessionIds = useMemo(() => new Set(linkedSessions.map((session) => session.id)), [linkedSessions]);
  const canLinkExistingSession = Boolean(item && workspacePath);
  const [isLinkingExistingSession, setIsLinkingExistingSession] = useState(false);
  const [sessionSearchQuery, setSessionSearchQuery] = useState('');
  const [linkingSessionId, setLinkingSessionId] = useState<string | null>(null);
  const [linkSessionError, setLinkSessionError] = useState<string | null>(null);
  const availableSessions = useMemo(() => {
    if (!workspacePath) return [] as SessionMeta[];
    return Array.from(sessionRegistry.values())
      .filter((session) => {
        if (session.workspaceId !== workspacePath) return false;
        if (session.isArchived) return false;
        return !linkedSessionIds.has(session.id);
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }, [linkedSessionIds, sessionRegistry, workspacePath]);
  const filteredAvailableSessions = useMemo(() => {
    if (!sessionSearchQuery.trim()) {
      return availableSessions.slice(0, 8);
    }
    const query = sessionSearchQuery.trim().toLowerCase();
    return availableSessions
      .filter((session) =>
        session.title.toLowerCase().includes(query)
        || session.provider.toLowerCase().includes(query)
        || session.id.toLowerCase().includes(query)
      )
      .slice(0, 8);
  }, [availableSessions, sessionSearchQuery]);

  // Local state for text fields (debounced save)
  const [localTitle, setLocalTitle] = useState(item ? getRecordTitle(item) : '');
  const [localDescription, setLocalDescription] = useState(item ? (item.fields.description as string ?? '') : '');
  const [localCustomFields, setLocalCustomFields] = useState<Record<string, any>>({});
  // Per-field debounce timers (not one shared timer) so editing one field never
  // drops another field's pending save, and so reconciliation can tell which
  // fields are mid-edit. `pendingFieldsRef` holds fields with an unflushed save;
  // `externalFieldBaselineRef` is the last-reconciled snapshot of persisted
  // values used to detect external writes (NIM-790).
  const fieldSaveTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const pendingFieldsRef = useRef<Set<string>>(new Set());
  const externalFieldBaselineRef = useRef<Record<string, unknown>>({});
  const editable = item ? isEditable(item) : false;
  const hasRichContent = item ? isNativeItem(item) : false; // Only native items have embedded Lexical content

  // Rich content editor state
  const [contentMarkdown, setContentMarkdown] = useState<string | null>(null);
  const [contentLoaded, setContentLoaded] = useState(false);
  // Bumped when an external writer (MCP, sync) changes the body content
  // out from under us, so the Lexical editor remounts with the new value.
  // Lexical only consumes `initialContent` at mount, so a key change is
  // the only way to surface fresh content without an in-place editor API.
  const [externalContentEpoch, setExternalContentEpoch] = useState(0);
  const getContentFnRef = useRef<(() => string) | null>(null);
  const contentSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contentSaveInFlightRef = useRef(false);
  // Baseline of what was last persisted to PGLite for THIS item. Used as a
  // safety rail: if the collab editor mounts empty (e.g., because Lexical's
  // `main` binding is empty while the server Y.Doc only has legacy bytes
  // under `root`), onDirtyChange would otherwise save "" and clobber the
  // real content in PGLite. We refuse any save that would shrink a
  // known-non-empty baseline to empty.
  // Also acts as the comparator for detecting external content updates --
  // if the atom's content diverges from this baseline, the change came
  // from somewhere other than this panel's own save path.
  const loadedBaselineRef = useRef<string | null>(null);

  // Reset local editing state when navigating to a different item.
  // We don't sync on item data changes (saves) to avoid clobbering in-progress text.
  // TrackerItemDetail subscribes to trackerItemByIdAtom(itemId) directly, so it only
  // re-renders when its own item changes -- no prop-drilling churn from parent re-renders.
  useEffect(() => {
    if (!item) return;
    setLocalTitle(getRecordTitle(item));
    setLocalDescription(item.fields.description as string ?? '');
    setLocalCustomFields({});
    // Clear any stale per-field debounce timers from the previous item and seed
    // the reconciliation baseline with the new item's persisted fields.
    for (const timer of fieldSaveTimersRef.current.values()) clearTimeout(timer);
    fieldSaveTimersRef.current.clear();
    pendingFieldsRef.current.clear();
    externalFieldBaselineRef.current = { ...item.fields };
    setIsLinkingExistingSession(false);
    setSessionSearchQuery('');
    setLinkingSessionId(null);
    setLinkSessionError(null);
  }, [itemId]); // itemId only -- not item fields

  // Reconcile in-progress field overrides against external writes (MCP, sync,
  // another window). When a field the user is NOT actively editing changes
  // underneath us, drop the stale local override so the panel shows -- and
  // saves -- the fresh value instead of clobbering it (NIM-790).
  const itemFields = item?.fields;
  useEffect(() => {
    if (!itemFields) return;
    const baseline = externalFieldBaselineRef.current;
    externalFieldBaselineRef.current = { ...itemFields };
    setLocalCustomFields((prev) => {
      const overriddenFields = Object.keys(prev);
      if (overriddenFields.length === 0) return prev;
      const { clearedFields } = reconcileExternalFieldChanges({
        previousPersisted: baseline,
        currentPersisted: itemFields,
        overriddenFields,
        pendingFields: pendingFieldsRef.current,
      });
      if (clearedFields.length === 0) return prev;
      const next = { ...prev };
      for (const f of clearedFields) delete next[f];
      return next;
    });
  }, [itemFields]);

  // Load rich content from PGLite once when navigating to a new item.
  // After initial load, the Lexical editor owns the content and saves via debounced saveContent.
  // We intentionally do NOT re-fetch on updatedAt changes -- our own saves update updatedAt,
  // and refetching would destroy/remount the editor, causing text to vanish mid-typing.
  useEffect(() => {
    if (!hasRichContent) {
      setContentLoaded(true);
      return;
    }

    let cancelled = false;
    setContentLoaded(false);
    setContentMarkdown(null);
    loadedBaselineRef.current = null;
    getContentFnRef.current = null;

    window.electronAPI.documentService.getTrackerItemContent({ itemId: item!.id })
      .then((result) => {
        if (cancelled) return;
        if (result.success && result.content != null) {
          const markdown = typeof result.content === 'string'
            ? result.content
            : result.content?.markdown ?? '';
          setContentMarkdown(markdown);
          loadedBaselineRef.current = markdown;
        } else {
          setContentMarkdown('');
          loadedBaselineRef.current = '';
        }
        setContentLoaded(true);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('[TrackerItemDetail] Failed to load content:', err);
        setContentMarkdown('');
        setContentLoaded(true);
      });

    return () => { cancelled = true; };
  }, [item?.id, hasRichContent]);

  // External content update detection.
  // The atom's `content` is refreshed by trackerSyncListeners whenever a
  // tracker-items-changed event arrives -- including MCP writes, sync
  // pushes, comment additions, and our own field saves. Our own content
  // saves are recognized because saveContent advances the baseline before
  // the IPC round-trip, so when the broadcast echo arrives the atom value
  // already matches. Any other divergence means an external writer changed
  // the body, and Lexical can only adopt that by remounting -- bump the
  // epoch in the editor key so it picks up the fresh initialContent.
  const atomContentString = useMemo<string | null>(() => {
    if (!hasRichContent) return null;
    const c = item?.content;
    if (c == null) return null;
    return typeof c === 'string' ? c : (c as any)?.markdown ?? null;
  }, [item?.content, hasRichContent]);

  useEffect(() => {
    if (!hasRichContent) return;
    if (atomContentString == null) return;
    const baseline = loadedBaselineRef.current;
    // Initial load hasn't completed yet -- the load effect owns this state
    if (baseline === null) return;
    if (atomContentString === baseline) return;
    // Local typing wins over a racing external write. If this panel already
    // has a pending or in-flight body save, remounting Lexical here would
    // discard the user's unsaved characters. Let the local save finish and
    // intentionally keep the editor on the locally-authored content.
    if (contentSaveTimerRef.current || contentSaveInFlightRef.current) {
      return;
    }
    // External update detected: refresh the editor.
    loadedBaselineRef.current = atomContentString;
    setContentMarkdown(atomContentString);
    setExternalContentEpoch((e) => e + 1);
  }, [atomContentString, hasRichContent]);

  // Escape to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const syncMode = useMemo(() => {
    const tracker = globalRegistry.get(item?.primaryType ?? '');
    return tracker?.sync?.mode || 'local';
  }, [item?.primaryType]);

  const contentMode = useMemo(() => {
    if (!item || !isNativeItem(item)) return 'file-backed' as const;
    if (syncMode === 'local') return 'local-pglite' as const;
    // Shared/hybrid trackers need a team for collaborative editing. Without
    // one, content is purely local. While the team check is still pending
    // (`teamOrgId === undefined`) stay in collaborative mode so the loading
    // UI runs -- otherwise the local editor would mount and risk being
    // clobbered if a team is then discovered.
    if (teamOrgId === null) return 'local-pglite' as const;
    return 'collaborative' as const;
  }, [item, syncMode, teamOrgId]);

  // Collaborative content editing for team-synced items. Dormant unless the
  // workspace actually has a team -- see useTrackerContentCollab for the
  // teamOrgId tri-state contract.
  const {
    collaboration: collabConfig,
    loading: collabLoading,
    status: collabStatus,
    reviewState,
    acceptRemoteChanges,
    rejectRemoteChanges,
    providerEpoch,
    bodyCacheMarkdown,
  } = useTrackerContentCollab({
    itemId,
    workspacePath,
    syncMode,
    teamMemberCount: teamMembers.length,
    teamOrgId,
  });

  // Track whether the collab provider has ever reached 'connected' for this
  // item/provider lifecycle. We show a static loading indicator over the
  // editor until then, because the editor may mount with an empty Y.Doc
  // while the WebSocket sync is still in flight -- without this the user
  // would see a blank editor and mistake it for "no content".
  const [hasSyncedOnce, setHasSyncedOnce] = useState(false);
  useEffect(() => {
    // Reset when a fresh provider is created (new item or new session).
    setHasSyncedOnce(false);
  }, [providerEpoch]);
  useEffect(() => {
    if (collabStatus === 'connected') setHasSyncedOnce(true);
  }, [collabStatus]);

  // Defensive cold-paint fallback for shared `fullDocument` trackers.
  //
  // The happy path: `useTrackerContentCollab` provides `initialEditorState`
  // built from `tracker_body_cache`, CollaborationPlugin's `_xmlText._length`
  // check fires bootstrap, the seed runs, content renders.
  //
  // The seam this catches: in prod we have seen the WebSocket reach
  // `connected` for a shared tracker, the `tracker_body_cache` row has
  // valid body bytes, AND no `initialEditorState fn CALLED` log fires --
  // the editor stays empty. The most likely cause is that
  // `@lexical/yjs` considers the shared XmlText non-empty after the
  // server-sync response is applied (the binding writes a root element
  // even when the room has never been seeded with real content), so
  // bootstrap is suppressed and the seed never gets a chance.
  //
  // This effect: 600ms after status reaches `connected`, if we have
  // cached body markdown AND the editor is visually empty, apply the
  // cached markdown via `editor.update()`. Going through the editor
  // (rather than `editor.parseEditorState`) means the change propagates
  // through `@lexical/yjs` into the Y.Doc, so peers receive the body
  // via the normal CRDT merge -- the empty server room finally gets
  // populated.
  const collabEditorInstanceRef = useRef<any>(null);
  useEffect(() => {
    if (collabStatus !== 'connected') return;
    if (!bodyCacheMarkdown || bodyCacheMarkdown.trim().length === 0) return;
    const t = setTimeout(() => {
      const editor = collabEditorInstanceRef.current;
      const getContent = getContentFnRef.current;
      if (!editor || !getContent) return;
      const current = getContent();
      // The check must be `trim() === ''` -- a fresh Lexical doc renders
      // as a single empty paragraph that serializes to '' after trim, so
      // anything content-bearing returns a non-empty trimmed string.
      if (current.trim() !== '') return;
      console.warn(
        '[TrackerItemDetail] Cold-paint fallback firing: editor is empty after sync(connected) but tracker_body_cache has bytes. Forcing paint.',
        { itemId, mdLen: bodyCacheMarkdown.length, providerEpoch },
      );
      editor.update(() => {
        const root = $getRoot();
        root.clear();
        $convertFromEnhancedMarkdownString(bodyCacheMarkdown, getEditorTransformers());
      });
    }, 600);
    return () => clearTimeout(t);
  }, [collabStatus, bodyCacheMarkdown, providerEpoch, itemId]);

  /** Save a field update -- routes to file-based save for file-backed items, DB for native */
  const saveField = useCallback(async (updates: Record<string, any>) => {
    if (!editable || !item) return;
    try {
      if ((item.source === 'frontmatter' || item.source === 'import' || item.source === 'inline') && item.system.documentPath) {
        // File-backed items with a real document path: update in source file
        await window.electronAPI.documentService.updateTrackerItemInFile({
          itemId: item.id,
          updates,
        });
      } else {
        // Native DB items, or file-backed items whose document_path is missing/empty
        await window.electronAPI.documentService.updateTrackerItem({
          itemId: item.id,
          updates,
          syncMode,
        });
      }
    } catch (err) {
      console.error('[TrackerItemDetail] Failed to save field:', err);
    }
  }, [item?.id, item?.source, editable, syncMode]);

  /** Debounced save for a single text field. Per-field timers + pending-field
   *  tracking let the reconciliation effect distinguish "user is editing this
   *  field" from "external write landed" (NIM-790). */
  const debouncedSaveField = useCallback((fieldName: string, value: any) => {
    pendingFieldsRef.current.add(fieldName);
    const timers = fieldSaveTimersRef.current;
    const existing = timers.get(fieldName);
    if (existing) clearTimeout(existing);
    timers.set(fieldName, setTimeout(async () => {
      timers.delete(fieldName);
      try {
        await saveField({ [fieldName]: value });
      } finally {
        pendingFieldsRef.current.delete(fieldName);
      }
    }, 500));
  }, [saveField]);

  /** Debounced save for rich content.
   *
   * `guardEmpty` is a collab-mode safety rail: if the collaborative editor
   * mounts before the Y.Doc has been populated from the server, its initial
   * onDirtyChange may fire with an empty markdown and would otherwise
   * clobber the user's PGLite content. When true, an empty save is only
   * allowed if the baseline was already empty (i.e., new items or
   * intentional clears in collab mode require the user to make a real edit
   * after content has rendered). Local-only editing does not need this
   * guard -- its initialContent is fed synchronously, so onDirtyChange
   * only fires on real user edits. */
  const saveContent = useCallback((markdown: string, guardEmpty = false) => {
    if (guardEmpty) {
      const baseline = loadedBaselineRef.current;
      if (markdown.trim() === '' && baseline != null && baseline.trim() !== '') {
        console.warn(
          '[TrackerItemDetail] Skipping save: collab editor reported empty before server sync populated content.',
          { itemId: item?.id, baselineLen: baseline.length }
        );
        return;
      }
    }
    if (contentSaveTimerRef.current) clearTimeout(contentSaveTimerRef.current);
    contentSaveTimerRef.current = setTimeout(async () => {
      contentSaveTimerRef.current = null;
      // Update the baseline before the IPC round-trip. The main-process
      // updateTrackerItemContent path also broadcasts tracker-items-changed,
      // which races with the invoke result -- if the broadcast arrives first
      // and we haven't moved the baseline forward yet, the external-update
      // detector below would mistake our own echo for a remote change and
      // remount the editor mid-typing. On save failure the editor still
      // owns the live value and the next dirty event will retry, so a
      // briefly-optimistic baseline is safe.
      loadedBaselineRef.current = markdown;
      contentSaveInFlightRef.current = true;
      try {
        await window.electronAPI.documentService.updateTrackerItemContent({
          itemId: item!.id,
          content: markdown,
        });
      } catch (err) {
        console.error('[TrackerItemDetail] Failed to save content:', err);
      } finally {
        contentSaveInFlightRef.current = false;
      }
    }, 800);
  }, [item?.id]);

  // Cleanup timers
  useEffect(() => {
    const timers = fieldSaveTimersRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      if (contentSaveTimerRef.current) clearTimeout(contentSaveTimerRef.current);
    };
  }, []);

  // Flush pending content save when item changes or component unmounts
  useEffect(() => {
    const isCollabMode = contentMode === 'collaborative';
    return () => {
      if (contentSaveTimerRef.current && getContentFnRef.current) {
        clearTimeout(contentSaveTimerRef.current);
        const markdown = getContentFnRef.current();
        if (isCollabMode) {
          const baseline = loadedBaselineRef.current;
          // Same collab-only data-loss guard as saveContent: don't let a
          // mount-time empty editor state win the unmount race.
          if (markdown.trim() === '' && baseline != null && baseline.trim() !== '') {
            return;
          }
        }
        // Fire-and-forget final save
        window.electronAPI.documentService.updateTrackerItemContent({
          itemId: item!.id,
          content: markdown,
        }).catch(() => {});
      }
    };
  }, [item?.id, contentMode]);

  /** Handle immediate field change (selects, checkboxes) */
  const handleImmediateFieldChange = useCallback((fieldName: string, value: any) => {
    saveField({ [fieldName]: value });
  }, [saveField]);

  /** Handle debounced text field change */
  const handleTextFieldChange = useCallback((fieldName: string, value: any) => {
    if (fieldName === 'title') {
      setLocalTitle(value);
    } else if (fieldName === 'description') {
      setLocalDescription(value);
    } else {
      setLocalCustomFields(prev => ({ ...prev, [fieldName]: value }));
    }
    debouncedSaveField(fieldName, value);
  }, [debouncedSaveField]);

  /** Open the source document in Files mode */
  const handleOpenDocument = useCallback(() => {
    if (!item?.system.documentPath) return;
    const documentService = (window as any).documentService;
    if (!documentService?.openDocument || !documentService?.getDocumentByPath) return;

    if (onSwitchToFilesMode) onSwitchToFilesMode();

    documentService.getDocumentByPath(item.system.documentPath).then((doc: any) => {
      if (doc) {
        documentService.openDocument(doc.id);
      }
    });
  }, [item?.system.documentPath, onSwitchToFilesMode]);

  const handleLinkExistingSession = useCallback(async (sessionId: string) => {
    if (!item) return;
    setLinkSessionError(null);
    setLinkingSessionId(sessionId);
    try {
      const trackerId = item.system.documentPath
        ? `file:${item.system.documentPath}`
        : item.id;
      const result = await window.electronAPI.invoke('tracker:link-session', {
        trackerId,
        sessionId,
      });
      if (!result?.success) {
        throw new Error(result?.error || 'Failed to link session');
      }
      await refreshSessionList();
      setIsLinkingExistingSession(false);
      setSessionSearchQuery('');
    } catch (err) {
      setLinkSessionError(err instanceof Error ? err.message : 'Failed to link session');
    } finally {
      setLinkingSessionId(null);
    }
  }, [item, refreshSessionList]);

  // Separate fields into categories for layout
  const { primaryFields, customFields } = useMemo(() => {
    if (!model) return { primaryFields: [] as FieldDefinition[], customFields: [] as FieldDefinition[] };

    const builtinNames = new Set(['title', 'description', 'created', 'updated']);
    // Resolve primary field names from schema roles instead of hardcoding
    const primaryNames = new Set<string>();
    for (const role of ['workflowStatus', 'priority', 'assignee', 'reporter', 'dueDate'] as const) {
      const fieldName = model.roles?.[role];
      if (fieldName) primaryNames.add(fieldName);
    }
    // Fallback conventional names when roles aren't declared
    if (primaryNames.size === 0) {
      for (const name of ['status', 'priority', 'owner', 'assigneeEmail', 'reporterEmail', 'dueDate']) {
        if (model.fields.some(f => f.name === name)) primaryNames.add(name);
      }
    }
    const primary: FieldDefinition[] = [];
    const custom: FieldDefinition[] = [];

    for (const field of model.fields) {
      if (builtinNames.has(field.name)) continue;
      if (primaryNames.has(field.name)) {
        primary.push(field);
      } else {
        custom.push(field);
      }
    }

    return { primaryFields: primary, customFields: custom };
  }, [model]);

  /** Get field value -- use in-progress local state for text fields, atom for select/etc */
  const getFieldValue = useCallback((fieldName: string): any => {
    if (!item) return undefined;
    // For text-like fields being edited, localCustomFields holds the in-progress value.
    // handleTextFieldChange stores owner (and other string fields) in localCustomFields,
    // so we must check it first to avoid resetting input on each keystroke.
    if (fieldName in localCustomFields) return localCustomFields[fieldName];
    // All fields are now in record.fields (schema-driven)
    return item.fields[fieldName];
  }, [item, localCustomFields]);

  /** Determine whether a field change should be immediate or debounced */
  const handleFieldChange = useCallback((field: FieldDefinition, value: any) => {
    const isTextLike = field.type === 'string' || field.type === 'text' || field.type === 'user';
    if (isTextLike) {
      handleTextFieldChange(field.name, value);
    } else {
      handleImmediateFieldChange(field.name, value);
    }
  }, [handleTextFieldChange, handleImmediateFieldChange]);

  /** Editor config for local PGLite mode (non-team native items only) */
  const localEditorConfig = useMemo((): EditorConfig | null => {
    if (contentMode !== 'local-pglite' || !contentLoaded) return null;
    return {
      isRichText: true,
      editable: true,
      showToolbar: false,
      isCodeHighlighted: true,
      hasLinkAttributes: true,
      markdownOnly: true,
      initialContent: contentMarkdown || '',
      onGetContent: (getContentFn: () => string) => {
        getContentFnRef.current = getContentFn;
      },
      onDirtyChange: (isDirty: boolean) => {
        if (isDirty && getContentFnRef.current) {
          const markdown = getContentFnRef.current();
          saveContent(markdown);
        }
      },
    };
  }, [contentMode, contentLoaded, contentMarkdown, saveContent]);

  /** Editor config for collaborative mode (team-synced native items) */
  const collabEditorConfig = useMemo((): EditorConfig | null => {
    if (contentMode !== 'collaborative' || !collabConfig || collabLoading) return null;
    if (!contentLoaded) return null;
    const mdContent = contentMarkdown;
    // Prefer the body-cache cold paint when the hook supplies it (the
    // `tracker_body_cache` row matching the current body_version). Fall
    // back to the per-item PGLite markdown for new items that have never
    // been saved (no cache row yet).
    const hookInitial = collabConfig.initialEditorState;
    // electron-log's renderer transport serializes only the first arg
    // as a string -- inline the diagnostic into the message itself so
    // a future cold-paint failure is debuggable from the log file.
    console.log(
      `[TrackerItemDetail] Building collab editor config itemId=${item?.id} shouldBootstrap=${collabConfig.shouldBootstrap} mdContentLen=${mdContent?.length ?? 0} hasHookInitial=${!!hookInitial}`,
    );
    return {
      isRichText: true,
      editable: true,
      showToolbar: false,
      isCodeHighlighted: true,
      hasLinkAttributes: true,
      markdownOnly: true,
      collaboration: {
        ...collabConfig,
        initialEditorState: hookInitial
          ?? (mdContent
            ? () => {
                console.log('[TrackerItemDetail] initialEditorState fn CALLED',
                  { itemId: item?.id, mdContentLen: mdContent.length });
                const root = $getRoot();
                root.clear();
                $convertFromEnhancedMarkdownString(mdContent, getEditorTransformers());
                console.log('[TrackerItemDetail] seeded editor root, children:', root.getChildrenSize());
              }
            : undefined),
      },
      onGetContent: (getContentFn: () => string) => {
        getContentFnRef.current = getContentFn;
      },
      onDirtyChange: (isDirty: boolean) => {
        if (isDirty && getContentFnRef.current) {
          const markdown = getContentFnRef.current();
          // guardEmpty=true: protect against the collab editor reporting
          // empty on mount before the Y.Doc sync has populated content.
          saveContent(markdown, true);
        }
      },
      onEditorReady: (editor: any) => {
        // Captured for the cold-paint fallback effect above. Without an
        // editor reference we cannot recover when CollaborationPlugin's
        // bootstrap check declines to fire `initialEditorState`.
        collabEditorInstanceRef.current = editor;
      },
    };
  }, [contentMode, collabConfig, collabLoading, contentLoaded, contentMarkdown, saveContent]);

  // Item deleted while panel was open (or not yet in atom — brief loading state)
  if (!item) {
    return (
      <div
        className="tracker-item-detail flex flex-col h-full bg-nim overflow-hidden items-center justify-center text-nim-faint text-sm"
        data-testid="tracker-item-detail"
      >
        Item no longer exists
      </div>
    );
  }

  const sourceLabel = getSourceLabel(item);

  return (
    <div
      className="tracker-item-detail flex flex-col h-full bg-nim overflow-hidden"
      data-testid="tracker-item-detail"
    >
      {/* Header */}
      <div className="flex items-start gap-2 px-4 pt-4 pb-3 border-b border-nim shrink-0">
        <span className="mt-1 shrink-0" style={{ color: typeColor }}>
          <MaterialSymbol icon={icon} size={20} />
        </span>
        <div className="flex-1 min-w-0">
          {editable ? (
            <input
              type="text"
              value={localTitle}
              onChange={(e) => handleTextFieldChange('title', e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              className="w-full bg-transparent border-none outline-none text-base font-semibold text-nim placeholder:text-nim-faint p-0"
              placeholder="Item title..."
              data-testid="tracker-detail-title"
            />
          ) : (
            <h3 className="text-base font-semibold text-nim m-0 leading-snug">{getRecordTitle(item)}</h3>
          )}
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            <span
              className="text-[10px] font-medium px-1.5 py-0.5 rounded"
              style={{
                color: typeColor,
                backgroundColor: `${typeColor}20`,
              }}
            >
              {model?.displayName || item.primaryType}
            </span>
            {/* Secondary type tags */}
            {item.typeTags
              .filter(tag => tag !== item.primaryType)
              .map(tag => {
                const tagModel = globalRegistry.get(tag);
                const tagColor = TYPE_COLORS[tag] || '#6b7280';
                return (
                  <span
                    key={tag}
                    className="text-[10px] font-medium px-1.5 py-0.5 rounded"
                    style={{
                      color: tagColor,
                      backgroundColor: `${tagColor}15`,
                      border: `1px solid ${tagColor}30`,
                    }}
                  >
                    {tagModel?.displayName || tag}
                  </span>
                );
              })}
            {isNativeItem(item) && (
              <span
                className="text-[10px] font-medium px-1.5 py-0.5 rounded flex items-center gap-0.5 bg-gray-500/[0.125] text-gray-400"
                title="Stored in database — not backed by a file"
                data-testid="tracker-source-db-badge"
              >
                <MaterialSymbol icon="storage" size={11} />
                Database
              </span>
            )}
            {(item.issueKey || item.id) && (
              <span className="text-[10px] text-nim-faint font-mono">{item.issueKey || item.id}</span>
            )}
            {item.archived && (
              <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-[#6b728020] text-nim-faint">
                Archived
              </span>
            )}
          </div>
          {externalOrigin && (() => {
            const summary = importerSummaries.find((s) => s.id === externalOrigin.providerId);
            const installed = Boolean(summary);
            const ref = externalOrigin.urn.includes('://')
              ? externalOrigin.urn.split('://')[1]
              : externalOrigin.externalId;
            return (
              <div
                className="flex items-center gap-1.5 mt-1.5 text-[11px]"
                data-testid="tracker-source-chip"
                title={installed ? undefined : 'Install the importer to refresh this item'}
              >
                <span className={installed ? 'text-nim-muted' : 'text-nim-faint'}>
                  <MaterialSymbol icon={summary?.icon || 'cloud_download'} size={13} />
                </span>
                <span className={installed ? 'text-nim-muted' : 'text-nim-faint'}>
                  From {summary?.displayName || externalOrigin.providerId}
                </span>
                <span className="text-nim-faint">·</span>
                <span className="font-mono text-nim-faint truncate max-w-[180px]">{ref}</span>
                {installed && (
                  <button
                    type="button"
                    className="ml-1 inline-flex items-center text-nim-muted hover:text-nim-accent disabled:opacity-50"
                    title="Pull latest from source"
                    data-testid="tracker-source-resnapshot"
                    disabled={resnapshotting}
                    onClick={handleResnapshot}
                  >
                    <MaterialSymbol icon={resnapshotting ? 'hourglass_empty' : 'sync'} size={12} />
                  </button>
                )}
                <button
                  type="button"
                  className="ml-1 inline-flex items-center gap-0.5 text-nim-muted hover:text-nim-accent"
                  title="Open original"
                  data-testid="tracker-source-open"
                  onClick={() => {
                    window.electronAPI
                      .invoke('tracker:importer:openExternal', {
                        workspacePath,
                        providerId: externalOrigin.providerId,
                        externalId: externalOrigin.externalId,
                        url: externalOrigin.url,
                      })
                      .catch(() => {
                        if (externalOrigin.url) window.open(externalOrigin.url, '_blank');
                      });
                  }}
                >
                  Open
                  <MaterialSymbol icon="open_in_new" size={11} />
                </button>
              </div>
            );
          })()}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {teamOrgId && (
            <button
              className="p-1 rounded hover:bg-nim-tertiary text-nim-muted"
              onClick={handleCopyLink}
              title="Copy shareable link"
              data-testid="tracker-copy-link"
            >
              <MaterialSymbol icon="link" size={18} />
            </button>
          )}
          {onArchive && (
            <button
              className="p-1 rounded hover:bg-nim-tertiary text-nim-muted"
              onClick={() => onArchive(item.id, !item.archived)}
              title={item.archived ? 'Unarchive' : 'Archive'}
            >
              <MaterialSymbol icon={item.archived ? 'unarchive' : 'archive'} size={18} />

            </button>
          )}
          {onDelete && (
            <button
              className="p-1 rounded hover:bg-nim-tertiary text-nim-muted hover:text-[#ef4444]"
              onClick={() => {
                if (window.confirm(`Delete "${getRecordTitle(item)}"? This cannot be undone.`)) {
                  onDelete(item.id);
                }
              }}
              title="Delete permanently"
            >
              <MaterialSymbol icon="delete" size={18} />
            </button>
          )}
          <button
            className="p-1 rounded hover:bg-nim-tertiary text-nim-muted"
            onClick={onClose}
            title="Close (Esc)"
          >
            <MaterialSymbol icon="close" size={18} />
          </button>
        </div>
      </div>

      {/* Upstream body-change banner (re-snapshot detected an upstream edit) */}
      {externalOrigin?.upstreamBodyChanged && (
        <div
          className="flex items-center gap-2 px-4 py-2 border-b border-nim bg-[var(--nim-warning)]/10 text-xs text-nim shrink-0"
          data-testid="tracker-upstream-body-banner"
        >
          <MaterialSymbol icon="sync_problem" size={14} className="text-nim-warning" />
          <span className="flex-1">The source body changed upstream. Update to overwrite the local body, or dismiss to keep yours.</span>
          <button
            type="button"
            className="px-2 py-0.5 rounded text-white bg-[var(--nim-primary)] hover:opacity-90 disabled:opacity-50"
            disabled={bodyBusy}
            onClick={() => handleBodyAction('applyBody')}
          >
            Update body
          </button>
          <button
            type="button"
            className="px-2 py-0.5 rounded border border-nim text-nim-muted hover:bg-nim-tertiary disabled:opacity-50"
            disabled={bodyBusy}
            onClick={() => handleBodyAction('dismissBody')}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
        {/* Primary fields grid (status, priority, owner) */}
        {primaryFields.length > 0 && (
          <div className="grid grid-cols-2 gap-3">
            {primaryFields.map((field) => (
              <div key={field.name}>
                {editable ? (
                  <TrackerFieldEditor
                    field={field}
                    value={getFieldValue(field.name)}
                    onChange={(value) => handleFieldChange(field, value)}
                    teamMembers={teamMembers}
                  />
                ) : (
                  <ReadOnlyField
                    field={field}
                    value={getFieldValue(field.name)}
                  />
                )}
              </div>
            ))}
          </div>
        )}

        {/* Type tags editor (for native/editable items) */}
        {editable && (
          <TypeTagsEditor
            typeTags={item.typeTags}
            primaryType={item.primaryType}
            onUpdate={(newTags) => {
              // Save via IPC -- typeTags are stored in the DB column, not JSONB data
              window.electronAPI.documentService.updateTrackerItem({
                itemId: item.id,
                updates: { typeTags: newTags },
                syncMode,
              }).catch((err: any) => console.error('[TrackerItemDetail] Failed to save type tags:', err));
            }}
          />
        )}

        {/* Custom fields */}
        {customFields.length > 0 && (
          <div className="space-y-3 pt-1 border-t border-nim">
            {customFields.map((field) => (
              <div key={field.name}>
                {editable ? (
                  <TrackerFieldEditor
                    field={field}
                    value={getFieldValue(field.name)}
                    onChange={(value) => handleFieldChange(field, value)}
                    teamMembers={teamMembers}
                  />
                ) : (
                  <ReadOnlyField
                    field={field}
                    value={getFieldValue(field.name)}
                  />
                )}
              </div>
            ))}
          </div>
        )}

        {/* Rich Content Editor / Description */}
        <div className="pt-1 border-t border-nim">
          <label className="text-[11px] font-medium text-nim-muted uppercase tracking-[0.5px] block mb-1">
            Content
          </label>
          {contentMode === 'local-pglite' && localEditorConfig ? (
            <div
              className="tracker-content-editor border border-nim rounded bg-nim min-h-[200px] overflow-hidden"
              data-testid="tracker-detail-content-editor"
            >
              <NimbalystEditor key={`${item.id}-${externalContentEpoch}`} config={localEditorConfig} />
            </div>
          ) : contentMode === 'collaborative' && collabEditorConfig ? (
            <div
              className="tracker-content-editor relative border border-nim rounded bg-nim min-h-[200px] overflow-hidden"
              data-testid="tracker-detail-content-editor"
            >
              {!hasSyncedOnce && (
                <div
                  className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none bg-nim"
                  data-testid="tracker-content-loading"
                >
                  <span className="text-sm text-nim-muted">Loading content...</span>
                </div>
              )}
              {reviewState?.hasUnreviewed && (
                <div
                  className="flex items-center gap-2 px-3 py-1.5 text-xs border-b border-nim bg-nim-tertiary"
                  data-testid="tracker-content-review-banner"
                >
                  <MaterialSymbol icon="rate_review" size={14} className="text-nim-warning" />
                  <span className="flex-1 text-nim-muted">
                    {reviewState.unreviewedCount} pending change{reviewState.unreviewedCount !== 1 ? 's' : ''} from{' '}
                    {reviewState.unreviewedAuthors.length > 0
                      ? reviewState.unreviewedAuthors.join(', ')
                      : 'collaborators'}
                  </span>
                  <button
                    className="px-2 py-0.5 rounded text-[11px] font-medium bg-green-600 text-white hover:bg-green-700 transition-colors"
                    onClick={acceptRemoteChanges}
                  >
                    Accept
                  </button>
                  <button
                    className="px-2 py-0.5 rounded text-[11px] font-medium text-nim-muted hover:text-nim hover:bg-nim-tertiary border border-nim transition-colors"
                    onClick={rejectRemoteChanges}
                  >
                    Reject
                  </button>
                </div>
              )}
              <NimbalystEditor key={`collab-${item.id}-${providerEpoch}`} config={collabEditorConfig} />
            </div>
          ) : (contentMode === 'local-pglite' || contentMode === 'collaborative') && !contentLoaded ? (
            <div className="text-sm text-nim-faint py-4 text-center">Loading...</div>
          ) : contentMode === 'collaborative' && collabLoading ? (
            <div className="text-sm text-nim-faint py-4 text-center">Connecting...</div>
          ) : item.system.documentPath ? (
            <div className="flex items-center gap-2 py-2">
              <span className="text-sm text-nim-muted flex-1 truncate font-mono">
                {item.system.documentPath}
              </span>
              <button
                className="flex items-center gap-1 px-2 py-1 text-xs font-medium rounded border border-nim text-nim-muted hover:text-nim hover:bg-nim-tertiary transition-colors"
                onClick={handleOpenDocument}
              >
                <MaterialSymbol icon="open_in_new" size={14} />
                Open in Editor
              </button>
            </div>
          ) : (
            <p className="text-sm text-nim-faint m-0">No content</p>
          )}
        </div>

        {/* Linked Sessions */}
        {(linkedSessions.length > 0 || onLaunchSession || canLinkExistingSession || isLinkingExistingSession) && (
          <div className="pt-1 border-t border-nim">
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-[11px] font-medium text-nim-muted uppercase tracking-[0.5px]">
                Sessions{linkedSessions.length > 0 ? ` (${linkedSessions.length})` : ''}
              </label>
              <div className="flex items-center gap-1">
                {canLinkExistingSession && (
                  <button
                    className="flex items-center gap-1 px-1.5 py-0.5 text-[11px] font-medium rounded text-nim-muted hover:text-nim hover:bg-nim-tertiary transition-colors"
                    onClick={() => {
                      setLinkSessionError(null);
                      setSessionSearchQuery('');
                      void refreshSessionList();
                      setIsLinkingExistingSession((prev) => !prev);
                    }}
                    title="Link an existing AI session to this item"
                  >
                    <MaterialSymbol icon="link" size={14} />
                    {isLinkingExistingSession ? 'Cancel' : 'Link Existing'}
                  </button>
                )}
                {onLaunchSession && (
                  <button
                    className="flex items-center gap-1 px-1.5 py-0.5 text-[11px] font-medium rounded text-nim-muted hover:text-nim hover:bg-nim-tertiary transition-colors"
                    onClick={() => onLaunchSession(item.id)}
                    title="Launch a new AI session for this item"
                  >
                    <MaterialSymbol icon="add" size={14} />
                    Launch Session
                  </button>
                )}
              </div>
            </div>
            {isLinkingExistingSession && (
              <div className="tracker-session-linker mb-2 rounded border border-nim bg-nim-tertiary p-2">
                <input
                  className="w-full rounded border border-nim bg-nim px-2 py-1.5 text-xs text-nim outline-none focus:border-nim-focus"
                  type="text"
                  value={sessionSearchQuery}
                  onChange={(e) => setSessionSearchQuery(e.target.value)}
                  placeholder={`Search ${availableSessions.length} existing session${availableSessions.length === 1 ? '' : 's'}`}
                />
                <div className="mt-2 space-y-1">
                  {filteredAvailableSessions.length > 0 ? (
                    filteredAvailableSessions.map((session) => (
                      <button
                        key={session.id}
                        className="tracker-session-linker-option w-full rounded px-2 py-1.5 text-left hover:bg-nim-hover transition-colors disabled:opacity-60"
                        onClick={() => handleLinkExistingSession(session.id)}
                        disabled={linkingSessionId !== null}
                        title={`Link session: ${session.title || 'Untitled session'}`}
                      >
                        <div className="flex items-center gap-2">
                          <ProviderIcon provider={session.provider || 'claude'} size={14} />
                          <span className="flex-1 truncate text-xs text-nim">
                            {session.title || 'Untitled session'}
                          </span>
                          <span className="shrink-0 text-[10px] text-nim-faint">
                            {linkingSessionId === session.id ? 'Linking...' : getRelativeTimeString(session.updatedAt)}
                          </span>
                        </div>
                      </button>
                    ))
                  ) : (
                    <p className="m-0 text-[11px] text-nim-faint">
                      {availableSessions.length === 0
                        ? 'No unlinked sessions available.'
                        : 'No sessions match that search.'}
                    </p>
                  )}
                </div>
                {linkSessionError && (
                  <p className="mt-2 mb-0 text-[11px] text-nim-error">{linkSessionError}</p>
                )}
              </div>
            )}
            {linkedSessions.length > 0 ? (
              <div className="space-y-1">
                {linkedSessions.map((session) => (
                  <button
                    key={session.id}
                    className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-left hover:bg-nim-tertiary transition-colors group"
                    onClick={() => onSwitchToAgentMode?.(session.id)}
                    title={`Open session: ${session.title}`}
                  >
                    <ProviderIcon provider={session.provider || 'claude'} size={14} />
                    <span className="flex-1 text-xs text-nim truncate">
                      {session.title || 'Untitled session'}
                    </span>
                    <span className="text-[10px] text-nim-faint shrink-0">
                      {getRelativeTimeString(session.updatedAt)}
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <p className="text-[11px] text-nim-faint m-0">No linked sessions</p>
            )}
          </div>
        )}

        {/* Linked Commits */}
        {item.system.linkedCommits && item.system.linkedCommits.length > 0 && (
          <div className="pt-1 border-t border-nim">
            <label className="text-[11px] font-medium text-nim-muted uppercase tracking-[0.5px] mb-1.5 block">
              Commits ({item.system.linkedCommits.length})
            </label>
            <div className="space-y-1">
              {item.system.linkedCommits.slice().reverse().map((commit: { sha: string; message: string; sessionId?: string; timestamp: string }) => (
                <div
                  key={commit.sha}
                  className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-nim-tertiary transition-colors group"
                >
                  <button
                    className="text-[11px] font-mono text-nim-primary hover:underline shrink-0"
                    onClick={() => {
                      navigator.clipboard.writeText(commit.sha);
                    }}
                    title={`Copy full SHA: ${commit.sha}`}
                  >
                    {commit.sha.slice(0, 7)}
                  </button>
                  <span className="flex-1 text-xs text-nim truncate" title={commit.message}>
                    {commit.message}
                  </span>
                  {commit.sessionId && (
                    <button
                      className="opacity-0 group-hover:opacity-100 transition-opacity"
                      onClick={() => onSwitchToAgentMode?.(commit.sessionId!)}
                      title="Open linked session"
                    >
                      <MaterialSymbol icon="smart_toy" size={14} className="text-nim-faint" />
                    </button>
                  )}
                  <span className="text-[10px] text-nim-faint shrink-0">
                    {getRelativeTimeString(new Date(commit.timestamp).getTime())}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Comments section */}
        {item.source !== 'inline' && item.source !== 'frontmatter' && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-medium text-nim-muted uppercase tracking-wide">Comments</h4>
            </div>
            <CommentsSection itemId={item.id} comments={item.system.comments} />
          </div>
        )}

        {/* Activity log */}
        {item.system.activity && item.system.activity.length > 0 && (
          <div className="space-y-2">
            <h4 className="text-xs font-medium text-nim-muted uppercase tracking-wide">Activity</h4>
            <div className="space-y-1">
              {item.system.activity.slice(-10).reverse().map((entry: any) => (
                <div key={entry.id} className="flex items-start gap-2 text-[11px]">
                  <span className="text-nim-muted shrink-0">{entry.authorIdentity?.displayName || 'Unknown'}</span>
                  <span className="text-nim-faint">
                    {entry.action === 'created' ? 'created this item' :
                     entry.action === 'commented' ? 'added a comment' :
                     entry.action === 'status_changed' ? `changed status to ${entry.newValue}` :
                     entry.action === 'archived' ? (entry.newValue === 'true' ? 'archived' : 'unarchived') :
                     entry.field ? `updated ${entry.field}` : entry.action}
                  </span>
                  <span className="text-nim-faint ml-auto shrink-0">{getRelativeTimeString(entry.timestamp)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Metadata footer */}
        <div className="pt-1 border-t border-nim">
          <div className="grid grid-cols-2 gap-2 text-[11px]">
            {/* Author identity */}
            {item.system.authorIdentity && (
              <div className="col-span-2 flex items-center gap-1.5">
                <span className="text-nim-faint shrink-0">Created by</span>
                <UserAvatar identity={item.system.authorIdentity} showName size={16} />
                {item.system.createdByAgent && (
                  <span className="text-[10px] text-nim-faint bg-nim-tertiary px-1 py-0.5 rounded">via AI</span>
                )}
              </div>
            )}
            {/* Last modifier */}
            {item.system.lastModifiedBy && item.system.lastModifiedBy.displayName !== item.system.authorIdentity?.displayName && (
              <div className="col-span-2 flex items-center gap-1.5">
                <span className="text-nim-faint shrink-0">Modified by</span>
                <UserAvatar identity={item.system.lastModifiedBy} showName size={16} />
              </div>
            )}
            <div>
              <span className="text-nim-faint">Created</span>
              <div className="text-nim-muted">{formatTimestamp(item.system.createdAt)}</div>
            </div>
            <div>
              <span className="text-nim-faint">Updated</span>
              <div className="text-nim-muted">{formatTimestamp(item.system.updatedAt || item.system.lastIndexed)}</div>
            </div>
            {item.issueKey && (
              <div>
                <span className="text-nim-faint">Key</span>
                <div className="text-nim-muted font-mono">{item.issueKey}</div>
              </div>
            )}
            {item.syncStatus && (
              <div>
                <span className="text-nim-faint">Sync</span>
                <div className="text-nim-muted">
                  <span
                    className="inline-block px-1.5 py-0.5 rounded text-[10px] font-medium"
                    style={{
                      backgroundColor: item.syncStatus === 'synced' ? '#22c55e20' : item.syncStatus === 'pending' ? '#eab30820' : '#6b728020',
                      color: item.syncStatus === 'synced' ? '#22c55e' : item.syncStatus === 'pending' ? '#eab308' : '#6b7280',
                    }}
                  >
                    {item.syncStatus}
                  </span>
                </div>
              </div>
            )}
            {sourceLabel && (
              <div className="col-span-2">
                <span className="text-nim-faint">Source</span>
                <div className="text-nim-muted truncate">{sourceLabel}</div>
              </div>
            )}
            {item.system.documentPath && !sourceLabel && (
              <div className="col-span-2">
                <span className="text-nim-faint">Source</span>
                <div className="text-nim-muted font-mono truncate">{item.system.documentPath}</div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

/** Read-only field display for non-editable items (e.g. inline items) */
const ReadOnlyField: React.FC<{ field: FieldDefinition; value: any }> = ({ field, value }) => {
  const label = field.name
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, s => s.toUpperCase())
    .trim();

  let displayValue: string;
  if (value == null || value === '') {
    displayValue = '\u2014';
  } else if (Array.isArray(value)) {
    displayValue = value.join(', ') || '\u2014';
  } else if (value instanceof Date) {
    displayValue = value.toLocaleDateString();
  } else if (typeof value === 'boolean') {
    displayValue = value ? 'Yes' : 'No';
  } else if (typeof value === 'object') {
    // Safety: format objects as JSON rather than [object Object]
    displayValue = JSON.stringify(value);
  } else {
    displayValue = String(value);
  }

  // For select fields, show the label not the raw value
  if (field.type === 'select' && field.options && value) {
    const option = field.options.find(o => o.value === value);
    if (option) {
      const color = option.color || STATUS_COLORS[value] || PRIORITY_COLORS[value] || '#6b7280';
      return (
        <div className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-[var(--nim-text-muted)] uppercase tracking-[0.5px]">{label}</span>
          <span
            className="inline-block self-start px-2 py-0.5 rounded-[10px] text-[11px] font-medium border"
            style={{
              backgroundColor: `${color}20`,
              color,
              borderColor: color,
            }}
          >
            {option.label}
          </span>
        </div>
      );
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] font-medium text-[var(--nim-text-muted)] uppercase tracking-[0.5px]">{label}</span>
      <span className="text-[13px] text-[var(--nim-text)]">{displayValue}</span>
    </div>
  );
};

/** Inline comments section for tracker items */
const CommentsSection: React.FC<{ itemId: string; comments?: any[] }> = ({ itemId, comments }) => {
  const [newComment, setNewComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // Optimistic comments shown immediately on submit, before the atom round-trips
  const [optimisticComments, setOptimisticComments] = useState<any[]>([]);

  // When server-side comments arrive (atom update), clear optimistic entries
  // that are now present in the real data.
  const serverComments = (comments || []).filter((c: any) => !c.deleted);
  const visibleComments = useMemo(() => {
    if (optimisticComments.length === 0) return serverComments;
    // Keep only optimistic comments whose body isn't yet in the server list
    // (simple dedup -- optimistic entries don't have real IDs)
    const serverBodies = new Set(serverComments.map((c: any) => c.body));
    const stillPending = optimisticComments.filter(c => !serverBodies.has(c.body));
    if (stillPending.length < optimisticComments.length) {
      // Some optimistic comments were confirmed -- schedule cleanup
      // Use queueMicrotask to avoid setState during render
      queueMicrotask(() => setOptimisticComments(stillPending));
    }
    return [...serverComments, ...stillPending];
  }, [serverComments, optimisticComments]);

  const handleSubmit = useCallback(async () => {
    if (!newComment.trim() || submitting) return;
    const body = newComment.trim();
    setSubmitting(true);
    // Optimistically show the comment immediately
    setOptimisticComments(prev => [...prev, {
      id: `optimistic_${Date.now()}`,
      body,
      createdAt: Date.now(),
      updatedAt: null,
      deleted: false,
      _optimistic: true,
    }]);
    setNewComment('');
    try {
      await window.electronAPI.invoke('document-service:tracker-item-add-comment', {
        itemId,
        body,
      });
    } catch (err) {
      console.error('Failed to add comment:', err);
      // Remove the optimistic comment on failure
      setOptimisticComments(prev => prev.filter(c => c.body !== body));
    } finally {
      setSubmitting(false);
    }
  }, [itemId, newComment, submitting]);

  return (
    <div className="space-y-2">
      {visibleComments.map((comment: any) => (
        <div key={comment.id} className={`rounded bg-nim-tertiary p-2 space-y-1${comment._optimistic ? ' opacity-70' : ''}`}>
          <div className="flex items-center gap-2 text-[11px]">
            <span className="font-medium text-nim-muted">{comment.authorIdentity?.displayName || 'You'}</span>
            <span className="text-nim-faint">{getRelativeTimeString(comment.createdAt)}</span>
            {comment.updatedAt && <span className="text-nim-faint">(edited)</span>}
          </div>
          <p className="text-xs text-nim m-0 whitespace-pre-wrap">{comment.body}</p>
        </div>
      ))}
      <div className="flex gap-1">
        <input
          type="text"
          value={newComment}
          onChange={e => setNewComment(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmit(); } }}
          placeholder="Add a comment..."
          className="flex-1 bg-nim-secondary border border-nim rounded px-2 py-1 text-xs text-nim placeholder:text-nim-faint outline-none focus:border-nim-primary"
        />
        <button
          onClick={handleSubmit}
          disabled={!newComment.trim() || submitting}
          className="px-2 py-1 rounded text-xs bg-nim-primary text-nim-on-primary disabled:opacity-40 hover:opacity-90 transition-opacity"
        >
          Post
        </button>
      </div>
    </div>
  );
};
