/**
 * The body of a tracker item: how it is edited, and the editor configs that
 * load and save it. Shared by Tracker mode's detail pane (`TrackerItemDetail`)
 * and the Pages-mode page view (`TrackerPageView`), so both read and write the
 * body through one path: content load from PGLite, the collaborative provider
 * with its sync curtain and cold-paint recovery, and the debounced save with
 * the collab empty-guard.
 *
 * Also here: the workspace's team lookup, which both the body (collab vs
 * local) and the hosts' people chips need.
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import type { EditorConfig } from '@nimbalyst/runtime/editor';
import { $convertFromEnhancedMarkdownString, getEditorTransformers } from '@nimbalyst/runtime/editor';
import { $getRoot, $setSelection, type LexicalEditor } from 'lexical';
import * as Y from 'yjs';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import { globalRegistry } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import { getRecordTitle, isItemPublished as recordIsPublished } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerRecordAccessors';
import type { TeamMemberOption } from '@nimbalyst/runtime/plugins/TrackerPlugin/components/TrackerFieldEditor';
import type { TrackerSharing } from '@nimbalyst/tracker-schema';
import { isNativeItem, resolveTrackerContentMode } from './trackerContentMode';
import { useTrackerContentCollab } from '../../hooks/useTrackerContentCollab';
import { useColdPaintFallback } from '../../hooks/useColdPaintFallback';
import { useCollabSyncCurtain } from '../../hooks/useCollabSyncCurtain';
import { registerLiveTypedPageEditor } from '../../services/personalAgentEdit';
import { useCollabBodyHistory } from '../HistoryDialog/useCollabBodyHistory';
import { personalTypedPageHistoryKey } from '../../../shared/personalPageUri';

/** How this item's body is edited -- see `resolveTrackerContentMode`. */
export type TrackerContentMode = 'file-backed' | 'local-pglite' | 'collaborative';

export interface TrackerTeam {
  /**
   * Tri-state:
   *   undefined -- team lookup pending
   *   null      -- confirmed no team for this workspace
   *   string    -- orgId resolved
   */
  teamOrgId: string | null | undefined;
  teamMembers: TeamMemberOption[];
}

/** Back-off between re-asks while main reports the team lookup as incomplete. */
const INCOMPLETE_TEAM_LOOKUP_RETRY_MS = [500, 1000, 2000, 4000, 8000] as const;

/**
 * Detect whether this workspace has a team. The team check feeds the content
 * editor mode (collab vs local); the member list feeds the assignee picker.
 * NIM-638: these are split into two effects so a slow or hung
 * `team:list-members` doesn't strand `teamOrgId === undefined` and keep the
 * collab editor stuck on "Connecting..." forever -- the editor only needs the
 * orgId, not the members.
 */
export function useTrackerTeam(workspacePath: string | undefined): TrackerTeam {
  const [teamOrgId, setTeamOrgId] = useState<string | null | undefined>(undefined);
  const [teamMembers, setTeamMembers] = useState<TeamMemberOption[]>([]);

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
        const lookup = () => Promise.race([
          window.electronAPI.invoke('team:find-for-workspace', workspacePath),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('team:find-for-workspace timed out')), TEAM_LOOKUP_TIMEOUT_MS),
          ),
        ]);
        let teamResult = await lookup();
        // `complete: false` means main could not read the team directory yet
        // (typically the first seconds after launch), so its null team is not
        // "this workspace has no team". Answering null here opened a team item's
        // body in local mode. Stay pending and ask again; give up to local mode
        // only once the schedule runs out.
        for (const delayMs of INCOMPLETE_TEAM_LOOKUP_RETRY_MS) {
          if (cancelled || teamResult?.complete !== false) break;
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          if (cancelled) return;
          teamResult = await lookup();
        }
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

  return { teamOrgId, teamMembers };
}

export interface UseTrackerItemBodyOptions {
  itemId: string;
  item: TrackerRecord | null | undefined;
  workspacePath?: string;
  teamOrgId: string | null | undefined;
  /**
   * Keep the draggable-block and selection toolbar controls of other editor
   * tabs even when the surface is narrow. On for full document surfaces.
   */
  forceFloatingToolbar: boolean;
  /** Publish the body's Lexical editor to the host (null when it goes away). */
  onBodyEditorReady?: (editor: unknown | null) => void;
  /** Called with the saved markdown after a body save lands, so the host can refetch derived links. */
  onContentSaved?: (markdown: string) => void;
}

export interface TrackerItemBody {
  sharing: TrackerSharing;
  isItemPublished: boolean;
  contentMode: TrackerContentMode;
  /** Only native items have embedded Lexical content. */
  hasRichContent: boolean;
  contentMarkdown: string | null;
  contentLoaded: boolean;
  /** Bumped when an external writer replaced the body; part of the local editor key. */
  externalContentEpoch: number;
  collabLoading: boolean;
  collabStatus: ReturnType<typeof useTrackerContentCollab>['status'];
  providerEpoch: number;
  /** False until the collab provider has reached 'connected' for this generation. */
  hasSyncedOnce: boolean;
  /** The mounted body editor, for the saved-description recovery card. */
  recoveryEditor: LexicalEditor | null;
  localEditorConfig: EditorConfig | null;
  collabEditorConfig: EditorConfig | null;
  /**
   * What the history dialog opens for this body: the room's `collab://` URI
   * for a collaborative body, the local-history key for a Personal one. Null
   * while neither applies (file-backed, or still connecting).
   */
  historyKey: string | null;
}

export function useTrackerItemBody({
  itemId,
  item,
  workspacePath,
  teamOrgId,
  forceFloatingToolbar,
  onBodyEditorReady,
  onContentSaved,
}: UseTrackerItemBodyOptions): TrackerItemBody {
  const hasRichContent = item ? isNativeItem(item) : false; // Only native items have embedded Lexical content
  const onContentSavedRef = useRef(onContentSaved);
  onContentSavedRef.current = onContentSaved;

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

  const sharing = useMemo((): TrackerSharing => {
    const tracker = globalRegistry.get(item?.primaryType ?? '');
    return tracker?.sharing ?? 'personal';
  }, [item?.primaryType]);

  // Whether THIS team-tracker item is published. The existing `share` flag
  // carries Draft/Published (surfaced under customFields by rowToTrackerItem),
  // while draftByDefault handles items without an explicit flag. Legacy items that
  // were pushed to the room before the explicit flag existed (sync_status
  // 'synced'/'pending') count as shared so they keep collaborating.
  const isItemPublished = useMemo(() => {
    if (!item) return false;
    // Single source of truth shared with the tracker table's Publication column.
    return recordIsPublished(item);
  }, [item]);

  const contentMode = useMemo(
    () => resolveTrackerContentMode({ item, sharing, isItemPublished, teamOrgId }),
    [item, sharing, teamOrgId, isItemPublished],
  );

  // Collaborative content editing for team-synced items. Dormant unless the
  // workspace actually has a team -- see useTrackerContentCollab for the
  // teamOrgId tri-state contract.
  const {
    collaboration: collabConfig,
    loading: collabLoading,
    status: collabStatus,
    syncProvider,
    commentsConfig,
    providerEpoch,
    bodyCacheMarkdown,
    history: collabHistory,
  } = useTrackerContentCollab({
    itemId,
    title: item?.issueKey || (item ? getRecordTitle(item) : itemId),
    workspacePath,
    sharing,
    teamOrgId,
    itemPublished: isItemPublished,
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

  // The host's document header bar needs the body editor for its TOC and
  // editor-backed actions. Held in a ref so the editor configs (memos) don't
  // re-create -- a new config identity remounts the editor and drops the
  // Y.Doc binding -- and republished on unmount so a stale editor never
  // outlives the item.
  const [recoveryEditor, setRecoveryEditor] = useState<LexicalEditor | null>(null);
  useEffect(() => setRecoveryEditor(null), [itemId]);
  const bodyEditorReadyRef = useRef(onBodyEditorReady);
  bodyEditorReadyRef.current = onBodyEditorReady;
  useEffect(() => () => bodyEditorReadyRef.current?.(null), [itemId]);
  // A local body editor takes agent edits itself while mounted, so its pending
  // autosave cannot write over them (see personalAgentEdit).
  const unregisterLiveEditorRef = useRef<(() => void) | null>(null);
  useEffect(() => () => {
    unregisterLiveEditorRef.current?.();
    unregisterLiveEditorRef.current = null;
  }, [itemId]);

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
        onContentSavedRef.current?.(markdown);
      } catch (err) {
        console.error('[TrackerItemDetail] Failed to save content:', err);
      } finally {
        contentSaveInFlightRef.current = false;
      }
    }, 800);
  }, [item?.id]);

  // Cleanup the pending save timer. Declared before the flush below so that,
  // on unmount, the flush still sees the timer ref set and writes the edit.
  useEffect(() => {
    return () => {
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

  /** Editor config for local PGLite mode (non-team native items only) */
  const localEditorConfig = useMemo((): EditorConfig | null => {
    if (contentMode !== 'local-pglite' || !contentLoaded) return null;
    return {
      isRichText: true,
      editable: true,
      showToolbar: false,
      // Focused tracker bodies are full document surfaces. Keep the same
      // draggable-block and selection toolbar controls as other editor tabs,
      // even when the three-pane layout makes the center pane narrow.
      forceFloatingToolbar,
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
      onEditorReady: (editor: any) => {
        setRecoveryEditor(editor);
        bodyEditorReadyRef.current?.(editor);
        unregisterLiveEditorRef.current?.();
        unregisterLiveEditorRef.current = registerLiveTypedPageEditor(itemId, {
          editor,
          getContent: () => getContentFnRef.current?.() ?? contentMarkdown ?? '',
          replaceContent: (markdown: string) => {
            editor.update(() => {
              // Clearing a selected node without moving selection first makes
              // Lexical throw "selection has been lost ..." (NIM-2005).
              $setSelection(null);
              $getRoot().clear();
              $convertFromEnhancedMarkdownString(markdown, getEditorTransformers());
            });
          },
        });
      },
    };
  }, [itemId, contentMode, contentLoaded, contentMarkdown, forceFloatingToolbar, saveContent]);

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
    return {
      isRichText: true,
      editable: true,
      showToolbar: false,
      forceFloatingToolbar,
      isCodeHighlighted: true,
      hasLinkAttributes: true,
      markdownOnly: true,
      collaboration: {
        ...collabConfig,
        initialEditorState: hookInitial
          ?? (collabConfig.shouldBootstrap && mdContent
            ? () => {
                // Clearing a selected node without moving selection first makes
                // Lexical throw "selection has been lost ..." (NIM-2005).
                $setSelection(null);
                const root = $getRoot();
                root.clear();
                $convertFromEnhancedMarkdownString(mdContent, getEditorTransformers());
              }
            : undefined),
      },
      comments: commentsConfig ?? undefined,
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
        setRecoveryEditor(editor);
        bodyEditorReadyRef.current?.(editor);
      },
    };
  }, [contentMode, collabConfig, collabLoading, commentsConfig, contentLoaded, contentMarkdown, forceFloatingToolbar, saveContent]);

  // A collaborative body's page history: revisions in its room, restored
  // through this editor.
  useCollabBodyHistory({
    uri: contentMode === 'collaborative' ? collabHistory?.uri ?? null : null,
    client: collabHistory?.client ?? null,
    syncProvider,
    editor: contentMode === 'collaborative' ? recoveryEditor : null,
  });
  const historyKey = contentMode === 'collaborative'
    ? collabHistory?.uri ?? null
    : contentMode === 'local-pglite' && sharing === 'personal' ? personalTypedPageHistoryKey(itemId) : null;

  return {
    sharing,
    isItemPublished,
    contentMode,
    hasRichContent,
    contentMarkdown,
    contentLoaded,
    externalContentEpoch,
    collabLoading,
    collabStatus,
    providerEpoch,
    hasSyncedOnce,
    recoveryEditor,
    localEditorConfig,
    collabEditorConfig,
    historyKey,
  };
}
