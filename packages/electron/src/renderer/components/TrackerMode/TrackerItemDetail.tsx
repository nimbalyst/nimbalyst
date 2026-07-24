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
import { $getRoot, $setSelection } from 'lexical';
import * as Y from 'yjs';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import { globalRegistry } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import type { FieldDefinition } from '@nimbalyst/runtime/plugins/TrackerPlugin/models/TrackerDataModel';
import { getRecordTitle, getRecordStatus, getRecordPriority, getRecordField, isSameIdentity, isItemSharedWithTeam } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerRecordAccessors';
import type { TrackerIdentity } from '@nimbalyst/runtime';
import { TrackerFieldEditor, type TeamMemberOption } from '@nimbalyst/runtime/plugins/TrackerPlugin/components/TrackerFieldEditor';
import type { RelationshipCandidate } from '@nimbalyst/runtime/plugins/TrackerPlugin/components/RelationshipFieldEditor';
import { UserAvatar } from '@nimbalyst/runtime/plugins/TrackerPlugin/components/UserAvatar';
import { trackerItemByIdAtom, trackerItemsMapAtom, trackerDataLoadedAtom } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerDataAtoms';
import { resolveRelationshipType, isRelationshipField } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import { refreshSessionListAtom, sessionRegistryAtom, type SessionMeta } from '../../store/atoms/sessions';
import { resolveLinkedSessions } from '../../utils/resolveLinkedSessions';
import { prRemoteAtom, navigateToPullRequest } from '../../store/atoms/pullRequests';
import { getRecordPrReferences } from '@nimbalyst/runtime/plugins/TrackerPlugin/prReferences';
import { buildTrackerDeepLink } from '../../store/atoms/collabDocuments';
import { errorNotificationService } from '../../services/ErrorNotificationService';
import { getRelativeTimeString } from '../../utils/dateFormatting';
import { useTrackerContentCollab } from '../../hooks/useTrackerContentCollab';
import { useColdPaintFallback } from '../../hooks/useColdPaintFallback';
import { useCollabSyncCurtain } from '../../hooks/useCollabSyncCurtain';
import { useMarkTrackerViewed } from '../../hooks/useTrackerUnread';
import { useRecordTrackerOpened } from '../../hooks/useRecordTrackerOpened';
import { reconcileExternalFieldChanges } from './trackerDetailFieldSync';
import { sanitizeTitleInput, useAutoSizedTitle } from './trackerTitleAutoSize';
import { invokeTrackerCommentMutation } from './trackerCommentMutation';
import { formatTrackerActivity } from './trackerActivityPresentation';

interface TrackerItemDetailProps {
  itemId: string;
  workspacePath?: string;
  onClose: () => void;
  onSwitchToFilesMode?: () => void;
  onSwitchToAgentMode?: (sessionId: string) => void;
  onLaunchSession?: (trackerItemId: string) => void;
  onLaunchWorktree?: (trackerItemId: string) => void;
  onArchive?: (itemId: string, archive: boolean) => void;
  onDelete?: (itemId: string) => void;
  /** Open another tracker item (relationship pill / backlink click). */
  onOpenItem?: (itemId: string) => void;
  /**
   * When true, show a content-focus toggle that expands the collaborative body
   * to fill the surface (compact header, metadata sections hidden). Enabled by
   * the workstream tab host for shared/collaborative bodies; off in Tracker Mode.
   */
  enableContentFocus?: boolean;
  /** Controlled content-focus value (persisted per tab by the host). */
  contentFocus?: boolean;
  /** Called when the user toggles content focus (host persists it). */
  onContentFocusChange?: (focus: boolean) => void;
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
  onLaunchWorktree,
  onArchive,
  onDelete,
  onOpenItem,
  enableContentFocus = false,
  contentFocus: controlledContentFocus,
  onContentFocusChange,
}) => {
  // Content-focus layout: collapse metadata sections and let the collaborative
  // body fill the surface. Toggling this does NOT remount the editor (same
  // NimbalystEditor key), so the Y.Doc/provider is preserved. Controlled by the
  // host (persisted per tab) when props are supplied; otherwise local state.
  const [internalContentFocus, setInternalContentFocus] = useState(false);
  const contentFocus = controlledContentFocus ?? internalContentFocus;
  const setContentFocus = useCallback(
    (next: boolean) => {
      if (onContentFocusChange) onContentFocusChange(next);
      else setInternalContentFocus(next);
    },
    [onContentFocusChange]
  );
  // Read directly from per-item atom -- only re-renders when THIS item changes,
  // not when any other item in the workspace updates.
  const item = useAtomValue(trackerItemByIdAtom(itemId));
  // Whether the tracker store has finished its initial load — lets us show a
  // loading state vs. an "unavailable" state when `item` is absent.
  const trackerDataLoaded = useAtomValue(trackerDataLoadedAtom);
  // Loaded items, used to build relationship-field typeahead candidates.
  const itemsMap = useAtomValue(trackerItemsMapAtom);
  const sessionRegistry = useAtomValue(sessionRegistryAtom);
  const refreshSessionList = useSetAtom(refreshSessionListAtom);

  const model = useMemo(() => globalRegistry.get(item?.primaryType ?? ''), [item?.primaryType]);

  // Mark this item read while it is open (debounced; refires when a newer
  // version arrives). Clears its unread dot in the list/board views.
  useMarkTrackerViewed(item, workspacePath);
  useRecordTrackerOpened(item?.id, workspacePath);

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
        // NIM-638: bound the team lookup with a client-side timeout. Without it,
        // a hung `team:find-for-workspace` IPC leaves teamOrgId === undefined
        // (pending) forever, so the content editor stays stuck on "Connecting...".
        // On timeout, degrade to local mode (null) -- the body still paints from
        // the cold cache instead of spinning indefinitely.
        const TEAM_LOOKUP_TIMEOUT_MS = 12_000;
        const teamResult = await Promise.race([
          window.electronAPI.invoke('team:find-for-workspace', workspacePath),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('team:find-for-workspace timed out')), TEAM_LOOKUP_TIMEOUT_MS),
          ),
        ]);
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

  // Resolve linked sessions from registry via the shared resolver so this view
  // and the PR view surface identical results (see resolveLinkedSessions.ts).
  const linkedSessions = useMemo(
    () => resolveLinkedSessions(item, sessionRegistry),
    [item, sessionRegistry]
  );

  // PR reference on the workspace's detected GitHub remote → "Open PR view"
  // jump. Reference-based (url-field match or explicit link), any item type.
  const prRemote = useAtomValue(prRemoteAtom);
  const prReference = useMemo(() => {
    if (!item || !prRemote || prRemote.workspacePath !== workspacePath) return null;
    const wanted = prRemote.remote.toLowerCase();
    return getRecordPrReferences(item).find((ref) => ref.remote === wanted) ?? null;
  }, [item, prRemote, workspacePath]);
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
  // Title is a textarea so long titles wrap; it grows with its content (NIM-1615).
  const titleRef = useAutoSizedTitle(localTitle);
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

  // Whether THIS item is shared with the team. For `shared`-mode types every
  // item is always shared; for `hybrid` it's per-item, driven by the `share`
  // flag (surfaced under customFields by rowToTrackerItem). Legacy items that
  // were pushed to the room before the explicit flag existed (sync_status
  // 'synced'/'pending') count as shared so they keep collaborating.
  const isItemShared = useMemo(() => {
    if (!item) return false;
    // Single source of truth shared with the tracker table's "Shared" column.
    return isItemSharedWithTeam(item);
  }, [item]);

  const contentMode = useMemo(() => {
    if (!item || !isNativeItem(item)) return 'file-backed' as const;
    if (syncMode === 'local') return 'local-pglite' as const;
    // Hybrid trackers are per-item: an unshared hybrid item edits locally and
    // never connects its body room. (Sharing flips this to collaborative.)
    if (syncMode === 'hybrid' && !isItemShared) return 'local-pglite' as const;
    // Shared/hybrid trackers need a team for collaborative editing. Without
    // one, content is purely local. While the team check is still pending
    // (`teamOrgId === undefined`) stay in collaborative mode so the loading
    // UI runs -- otherwise the local editor would mount and risk being
    // clobbered if a team is then discovered.
    if (teamOrgId === null) return 'local-pglite' as const;
    return 'collaborative' as const;
  }, [item, syncMode, teamOrgId, isItemShared]);

  // The per-item "Share with team" toggle is offered only for hybrid native
  // items in a workspace that has a team. `shared` types are always shared (no
  // choice) and `local` types never sync.
  // Native items + file-backed plans/decisions (frontmatter/import) can be
  // shared. Inline trackers (#bug[...]) are always local -- promote them first.
  const canToggleShare = Boolean(
    item &&
    editable &&
    (isNativeItem(item) || item.source === 'frontmatter' || item.source === 'import') &&
    syncMode === 'hybrid' &&
    typeof teamOrgId === 'string'
  );
  // File-backed plans/decisions can be UNSHARED safely (the row re-projects from
  // the file as local). Native items cannot yet: the sync engine's unshare path
  // deletes the local row, so unsharing a native item would lose it. So a
  // shared native item's toggle is locked (share is one-way until the engine
  // gains a "remove from room, keep local" primitive).
  const isFileBacked = Boolean(item && (item.source === 'frontmatter' || item.source === 'import'));
  const unshareLocked = isItemShared && !isFileBacked;
  const [sharePending, setSharePending] = useState(false);
  const handleToggleShare = useCallback(async () => {
    if (!item || sharePending) return;
    const next = !isItemShared;
    // Guard: never attempt to unshare a native item (would delete it).
    if (!next && !(item.source === 'frontmatter' || item.source === 'import')) return;
    setSharePending(true);
    try {
      const res = await window.electronAPI.documentService.setTrackerItemShared({
        itemId: item.id,
        shared: next,
      });
      if (!res?.success) throw new Error(res?.error || 'Share toggle failed');
      errorNotificationService.showInfo(
        next ? 'Shared with team' : 'Made local',
        next
          ? 'This item is now in your team’s shared tracker.'
          : 'This item is now local-only and was removed from the team tracker.',
        { duration: 3000 }
      );
    } catch (err) {
      console.error('[TrackerItemDetail] Failed to toggle share:', err);
      errorNotificationService.showError(
        'Share failed',
        err instanceof Error ? err.message : String(err)
      );
    } finally {
      setSharePending(false);
    }
  }, [item, isItemShared, sharePending]);

  // Collaborative content editing for team-synced items. Dormant unless the
  // workspace actually has a team -- see useTrackerContentCollab for the
  // teamOrgId tri-state contract.
  const {
    collaboration: collabConfig,
    loading: collabLoading,
    status: collabStatus,
    syncProvider,
    reviewState,
    acceptRemoteChanges,
    rejectRemoteChanges,
    providerEpoch,
    bodyCacheMarkdown,
  } = useTrackerContentCollab({
    itemId,
    title: item?.issueKey || (item ? getRecordTitle(item) : itemId),
    workspacePath,
    syncMode,
    teamMemberCount: teamMembers.length,
    teamOrgId,
    itemShared: isItemShared,
  });

  // Whether the collab provider has reached 'connected' for the CURRENT
  // provider generation. We show a static loading indicator over the editor
  // until then, because the editor may mount with an empty Y.Doc while the
  // WebSocket sync is still in flight -- without this the user would see a
  // blank editor and mistake it for "no content".
  //
  // NIM-1985: this must be epoch-aware, not two order-dependent effects.
  // See useCollabSyncCurtain's doc comment for the warm-reopen inversion
  // that left the curtain permanently covering a fully-painted body.
  const hasSyncedOnce = useCollabSyncCurtain(collabStatus, providerEpoch);

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
  // See NIM-1589 and useColdPaintFallback's own doc comment: a single
  // point-in-time "empty" read races the async Yjs->Lexical reconciliation
  // on a large/slow-to-render doc, so this fires paint only after two
  // spaced-apart empty reads, and at most once per provider lifecycle.
  const collabEditorInstanceRef = useRef<any>(null);
  useColdPaintFallback({
    collabStatus,
    bodyCacheMarkdown,
    providerEpoch,
    itemId,
    isVisuallyEmpty: useCallback(() => {
      // Authoritative check first: read the raw synced Y.Doc directly,
      // bypassing Lexical's (possibly still-in-flight) reconciliation. By
      // the time `collabStatus` reaches 'connected' the server's sync
      // response has already been applied to the Y.Doc (see
      // CollabLexicalProvider.handleStatusChange), so this is accurate
      // immediately -- no render-lag race, unlike the Lexical text read
      // below. A non-empty root here means the room genuinely has content,
      // full stop; never paint over it regardless of what Lexical shows.
      const ydoc = syncProvider?.getYDoc();
      if (ydoc && ydoc.get('root', Y.XmlText).length > 0) return false;

      const getContent = getContentFnRef.current;
      if (!getContent) return false;
      // The check must be `trim() === ''` -- a fresh Lexical doc renders
      // as a single empty paragraph that serializes to '' after trim, so
      // anything content-bearing returns a non-empty trimmed string.
      return getContent().trim() === '';
    }, [syncProvider]),
    paint: useCallback(() => {
      const editor = collabEditorInstanceRef.current;
      if (!editor || !bodyCacheMarkdown) return;
      console.warn(
        '[TrackerItemDetail] Cold-paint fallback firing: editor is empty after sync(connected) but tracker_body_cache has bytes. Forcing paint.',
        { itemId, mdLen: bodyCacheMarkdown.length, providerEpoch },
      );
      editor.update(() => {
        // Clearing a selected node without moving selection first makes
        // Lexical throw "selection has been lost ..." (NIM-2005).
        $setSelection(null);
        const root = $getRoot();
        root.clear();
        $convertFromEnhancedMarkdownString(bodyCacheMarkdown, getEditorTransformers());
      });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [bodyCacheMarkdown, itemId, providerEpoch]),
  });

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
      // Refresh the derived relationship index for this item (Epic C Phase 2) so
      // backlinks stay current after a relationship field edit. Fire-and-forget,
      // idempotent; harmless for non-relationship field saves.
      window.electronAPI
        .invoke('document-service:tracker-item-reindex-relationships', { itemId: item.id })
        .catch(() => {});
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

  /**
   * Candidate target items for a relationship field's typeahead: every loaded
   * item except this one, narrowed to the field's allowed target tracker types.
   */
  const buildRelationshipCandidates = useCallback((field: FieldDefinition): RelationshipCandidate[] => {
    const targets = field.targetTrackerTypes;
    const candidates: RelationshipCandidate[] = [];
    for (const rec of itemsMap.values()) {
      if (rec.id === itemId) continue;
      if (targets && targets !== '*' && !targets.includes(rec.primaryType)) continue;
      candidates.push({
        itemId: rec.id,
        // Resolve the display title via the schema's title role -- custom types
        // (e.g. customer-contact) store their title under a non-"title" field.
        title: getRecordTitle(rec) || undefined,
        issueKey: rec.issueKey || undefined,
        trackerType: rec.primaryType,
      });
    }
    return candidates;
  }, [itemsMap, itemId]);

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
                // Clearing a selected node without moving selection first makes
                // Lexical throw "selection has been lost ..." (NIM-2005).
                $setSelection(null);
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

  // Content-focus is only offered for collaborative (shared) bodies in the
  // workstream tab host. focusActive gates the layout, so if the mode changes
  // away from collaborative the focus layout collapses automatically.
  const showFocusToggle = enableContentFocus && contentMode === 'collaborative';
  const focusActive = contentFocus && showFocusToggle;

  // No item in the atom: distinguish "still loading" (tracker store not yet
  // hydrated — e.g. a restored tab before sync completes) from "unavailable"
  // (data loaded but this id is gone/inaccessible). Without this, a restored
  // tracker tab briefly flashes "no longer available" during cold restore.
  if (!item) {
    return (
      <div
        className="tracker-item-detail flex flex-col h-full bg-nim overflow-hidden items-center justify-center text-nim-faint text-sm"
        data-testid="tracker-item-detail"
      >
        {trackerDataLoaded ? 'This tracker item is no longer available' : 'Loading…'}
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
            <textarea
              ref={titleRef}
              rows={1}
              value={localTitle}
              onChange={(e) => handleTextFieldChange('title', sanitizeTitleInput(e.target.value))}
              onKeyDown={(e) => {
                e.stopPropagation();
                // Titles stay single-line: Enter commits instead of adding a row.
                if (e.key === 'Enter') {
                  e.preventDefault();
                  e.currentTarget.blur();
                }
              }}
              className="w-full bg-transparent border-none outline-none text-base font-semibold text-nim placeholder:text-nim-faint p-0 m-0 resize-none overflow-hidden leading-snug break-words"
              placeholder="Item title..."
              data-testid="tracker-detail-title"
            />
          ) : (
            <h3 className="text-base font-semibold text-nim m-0 leading-snug break-words">{getRecordTitle(item)}</h3>
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
          {prReference && (
            <button
              className="flex items-center gap-1 px-2 py-1 rounded text-[12px] font-medium text-nim-muted hover:bg-nim-tertiary"
              onClick={() => navigateToPullRequest(prReference.remote, prReference.number)}
              title={`Open #${prReference.number} in the PRs view`}
              data-testid="tracker-open-pr-view"
            >
              <MaterialSymbol icon="merge" size={16} />
              <span>PR #{prReference.number}</span>
            </button>
          )}
          {canToggleShare && (
            <button
              className={`flex items-center gap-1 px-2 py-1 rounded text-[12px] font-medium ${
                isItemShared
                  ? 'bg-[var(--nim-primary)]/15 text-[var(--nim-primary)] hover:bg-[var(--nim-primary)]/25'
                  : 'text-nim-muted hover:bg-nim-tertiary'
              } disabled:opacity-50`}
              onClick={handleToggleShare}
              disabled={sharePending || unshareLocked}
              title={
                unshareLocked
                  ? 'Shared with your team. Unsharing native items from the UI isn’t supported yet.'
                  : isItemShared
                    ? 'Shared with your team — click to make this item local-only'
                    : 'Share this item with your team so they can review it'
              }
              data-testid="tracker-share-toggle"
              aria-pressed={isItemShared}
            >
              <MaterialSymbol
                icon={sharePending ? 'hourglass_empty' : isItemShared ? 'group' : 'group_add'}
                size={16}
              />
              <span>{isItemShared ? 'Shared' : 'Share'}</span>
            </button>
          )}
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
          {showFocusToggle && (
            <button
              className={`p-1 rounded hover:bg-nim-tertiary ${focusActive ? 'text-[var(--nim-primary)]' : 'text-nim-muted'}`}
              onClick={() => setContentFocus(!focusActive)}
              title={focusActive ? 'Exit content focus' : 'Focus content'}
              data-testid="tracker-content-focus-toggle"
              aria-pressed={focusActive}
            >
              <MaterialSymbol icon={focusActive ? 'close_fullscreen' : 'open_in_full'} size={18} />
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
      <div
        className={
          focusActive
            ? 'flex-1 min-h-0 overflow-hidden px-4 py-3 flex flex-col'
            : 'flex-1 overflow-y-auto px-4 py-3 space-y-4'
        }
      >
        {!focusActive && (
        <>
        {/* Linked Sessions -- kept at the top so they're visible without scrolling */}
        {(linkedSessions.length > 0 || onLaunchSession || onLaunchWorktree || canLinkExistingSession || isLinkingExistingSession) && (
          <div className="tracker-sessions-section">
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
                {onLaunchWorktree && (
                  <button
                    className="flex items-center gap-1 px-1.5 py-0.5 text-[11px] font-medium rounded text-nim-muted hover:text-nim hover:bg-nim-tertiary transition-colors"
                    onClick={() => onLaunchWorktree(item.id)}
                    title="Launch a new isolated worktree session for this item"
                  >
                    <MaterialSymbol icon="account_tree" size={14} />
                    Launch Worktree
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

        {/* Primary fields grid (status, priority, owner) */}
        {primaryFields.length > 0 && (
          <div className="grid grid-cols-2 gap-3 pt-1 border-t border-nim">
            {primaryFields.map((field) => (
              <div key={field.name}>
                {editable ? (
                  <TrackerFieldEditor
                    field={field}
                    value={getFieldValue(field.name)}
                    onChange={(value) => handleFieldChange(field, value)}
                    teamMembers={teamMembers}
                    relationshipCandidates={isRelationshipField(field) ? buildRelationshipCandidates(field) : undefined}
                    onOpenRelationship={onOpenItem}
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
                    relationshipCandidates={isRelationshipField(field) ? buildRelationshipCandidates(field) : undefined}
                    onOpenRelationship={onOpenItem}
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

        </>
        )}

        {/* Rich Content Editor / Description */}
        <div className={focusActive ? 'flex-1 min-h-0 flex flex-col' : 'pt-1 border-t border-nim'}>
          {!focusActive && (
          <label className="text-[11px] font-medium text-nim-muted uppercase tracking-[0.5px] block mb-1">
            Content
          </label>
          )}
          {contentMode === 'local-pglite' && localEditorConfig ? (
            <div
              className={`tracker-content-editor border border-nim rounded bg-nim overflow-hidden ${focusActive ? 'flex-1 min-h-0' : 'min-h-[200px]'}`}
              data-testid="tracker-detail-content-editor"
            >
              <NimbalystEditor key={`${item.id}-${externalContentEpoch}`} config={localEditorConfig} />
            </div>
          ) : contentMode === 'collaborative' && collabEditorConfig ? (
            <div
              className={`tracker-content-editor relative border border-nim rounded bg-nim overflow-hidden ${focusActive ? 'flex-1 min-h-0 flex flex-col' : 'min-h-[200px]'}`}
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

        {/* Linked Commits */}
        {!focusActive && item.system.linkedCommits && item.system.linkedCommits.length > 0 && (
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

        {/* Linked From (incoming relationships, Epic C Phase 2) */}
        {!focusActive && <BacklinksSection itemId={item.id} onOpenItem={onOpenItem} />}

        {/* Comments section */}
        {!focusActive && item.source !== 'inline' && item.source !== 'frontmatter' && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-medium text-nim-muted uppercase tracking-wide">Comments</h4>
            </div>
            <CommentsSection itemId={item.id} comments={item.system.comments} />
          </div>
        )}

        {/* Activity log */}
        {!focusActive && item.system.activity && item.system.activity.length > 0 && (
          <div className="space-y-2">
            <h4 className="text-xs font-medium text-nim-muted uppercase tracking-wide">Activity</h4>
            <div className="space-y-1">
              {item.system.activity.slice(-10).reverse().map((entry: any) => (
                <div key={entry.id} className="flex items-start gap-2 text-[11px]">
                  <span className="text-nim-muted shrink-0">{entry.authorIdentity?.displayName || 'Unknown'}</span>
                  <span className="text-nim-faint">
                    {formatTrackerActivity(entry)}
                  </span>
                  <span className="text-nim-faint ml-auto shrink-0">{getRelativeTimeString(entry.timestamp)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Metadata footer */}
        {!focusActive && (
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
        )}
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

/**
 * "Linked From" — incoming relationships (Epic C Phase 2). Reads the derived
 * tracker_relationship_index via IPC; resolves each source item's display from
 * the loaded items map. Hidden when there are no backlinks.
 */
interface Backlink { sourceItemId: string; sourceFieldId: string; relationshipTypeKey?: string | null }

const BacklinksSection: React.FC<{ itemId: string; onOpenItem?: (itemId: string) => void }> = ({ itemId, onOpenItem }) => {
  const [backlinks, setBacklinks] = useState<Backlink[]>([]);
  const itemsMap = useAtomValue(trackerItemsMapAtom);

  useEffect(() => {
    let cancelled = false;
    window.electronAPI
      .invoke('document-service:tracker-item-backlinks', { itemId })
      .then((res: any) => {
        if (cancelled) return;
        setBacklinks(res?.success && Array.isArray(res.backlinks) ? res.backlinks : []);
      })
      .catch(() => { if (!cancelled) setBacklinks([]); });
    return () => { cancelled = true; };
  }, [itemId]);

  if (backlinks.length === 0) return null;

  return (
    <div className="space-y-2 tracker-backlinks">
      <h4 className="text-xs font-medium text-nim-muted uppercase tracking-wide">Linked from</h4>
      <div className="flex flex-wrap gap-1">
        {backlinks.map((b) => {
          const src = itemsMap.get(b.sourceItemId);
          const label = src?.issueKey || (src ? getRecordTitle(src) : undefined) || b.sourceItemId;
          // Show the inverse direction: if the source links to us via "depends-on",
          // we are what it "blocks". Falls back to the forward label.
          const rel = resolveRelationshipType(b.relationshipTypeKey ?? undefined);
          const relLabel = rel?.inverseDisplayName ?? rel?.displayName ?? b.relationshipTypeKey ?? 'links to';
          return (
            <button
              key={`${b.sourceItemId}:${b.sourceFieldId}`}
              type="button"
              className="tracker-backlink-pill inline-flex items-center gap-1 rounded-full bg-nim-tertiary px-2 py-0.5 text-[11px] text-nim hover:bg-nim-hover disabled:cursor-default"
              title={`${label} — ${relLabel}`}
              disabled={!onOpenItem}
              onClick={() => onOpenItem?.(b.sourceItemId)}
            >
              <span className="text-nim-faint">{relLabel}:</span>
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
};

/** Inline comments section for tracker items */
const CommentsSection: React.FC<{ itemId: string; comments?: any[] }> = ({ itemId, comments }) => {
  const [newComment, setNewComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // Optimistic comments shown immediately on submit, before the atom round-trips
  const [optimisticComments, setOptimisticComments] = useState<any[]>([]);
  // Current user identity, used to gate edit/delete to the comment author (NIM-360).
  const [currentIdentity, setCurrentIdentity] = useState<TrackerIdentity | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editBody, setEditBody] = useState('');
  const [commentError, setCommentError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.electronAPI
      .invoke('document-service:get-current-identity')
      .then((result: any) => {
        if (cancelled) return;
        if (result?.success && result.identity) setCurrentIdentity(result.identity);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const handleEditSave = useCallback(async (commentId: string) => {
    const body = editBody.trim();
    if (!body) return;
    setCommentError(null);
    try {
      await invokeTrackerCommentMutation(window.electronAPI.invoke, 'document-service:tracker-item-update-comment', {
        itemId,
        commentId,
        body,
      });
      setEditingId(null);
    } catch (err) {
      console.error('Failed to edit comment:', err);
      setCommentError(err instanceof Error ? err.message : String(err));
    }
  }, [itemId, editBody]);

  const handleDelete = useCallback(async (commentId: string) => {
    setCommentError(null);
    try {
      await invokeTrackerCommentMutation(window.electronAPI.invoke, 'document-service:tracker-item-update-comment', {
        itemId,
        commentId,
        deleted: true,
      });
    } catch (err) {
      console.error('Failed to delete comment:', err);
      setCommentError(err instanceof Error ? err.message : String(err));
    }
  }, [itemId]);

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
    setCommentError(null);
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
      await invokeTrackerCommentMutation(window.electronAPI.invoke, 'document-service:tracker-item-add-comment', {
        itemId,
        body,
      });
    } catch (err) {
      console.error('Failed to add comment:', err);
      // Remove the optimistic comment on failure
      setOptimisticComments(prev => prev.filter(c => c.body !== body));
      setNewComment(body);
      setCommentError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }, [itemId, newComment, submitting]);

  return (
    <div className="space-y-2">
      {visibleComments.map((comment: any) => {
        const isAuthor = !comment._optimistic
          && isSameIdentity(comment.authorIdentity ?? null, currentIdentity);
        const isEditing = editingId === comment.id;
        return (
          <div key={comment.id} className={`tracker-comment group rounded bg-nim-tertiary p-2 space-y-1${comment._optimistic ? ' opacity-70' : ''}`}>
            <div className="flex items-center gap-2 text-[11px]">
              <span className="font-medium text-nim-muted">{comment.authorIdentity?.displayName || 'You'}</span>
              <span className="text-nim-faint">{getRelativeTimeString(comment.createdAt)}</span>
              {comment.updatedAt && <span className="text-nim-faint">(edited)</span>}
              {isAuthor && !isEditing && (
                <span className="ml-auto flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    className="tracker-comment-edit text-nim-faint hover:text-nim"
                    title="Edit comment"
                    onClick={() => { setEditingId(comment.id); setEditBody(comment.body); }}
                  >
                    <MaterialSymbol icon="edit" size={13} />
                  </button>
                  <button
                    className="tracker-comment-delete text-nim-faint hover:text-nim-error"
                    title="Delete comment"
                    onClick={() => handleDelete(comment.id)}
                  >
                    <MaterialSymbol icon="delete" size={13} />
                  </button>
                </span>
              )}
            </div>
            {isEditing ? (
              <div className="flex gap-1">
                <input
                  type="text"
                  value={editBody}
                  autoFocus
                  onChange={e => setEditBody(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleEditSave(comment.id); }
                    if (e.key === 'Escape') { setEditingId(null); }
                  }}
                  className="flex-1 bg-nim-secondary border border-nim rounded px-2 py-1 text-xs text-nim outline-none focus:border-nim-primary"
                />
                <button
                  onClick={() => handleEditSave(comment.id)}
                  disabled={!editBody.trim()}
                  className="px-2 py-1 rounded text-xs bg-nim-primary text-nim-on-primary disabled:opacity-40"
                >
                  Save
                </button>
                <button
                  onClick={() => setEditingId(null)}
                  className="px-2 py-1 rounded text-xs text-nim-muted hover:text-nim"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <p className="text-xs text-nim m-0 whitespace-pre-wrap">{comment.body}</p>
            )}
          </div>
        );
      })}
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
      {commentError && (
        <p className="tracker-comment-error m-0 text-xs text-nim-error" role="alert">
          {commentError}
        </p>
      )}
    </div>
  );
};
