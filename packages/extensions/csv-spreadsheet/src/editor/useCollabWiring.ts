/**
 * Collaborative wiring (a no-op when host.collaboration is undefined).
 *
 * CSV uses a single Y.Text for the whole document (see csvBinding.ts for the
 * reasoning). Local edits are pushed via a debounced poll because RevoGrid
 * lacks a single "any mutation" event to hook into. Remote Y.Text changes flow
 * back through the existing applyContent path so every existing
 * format/header/metadata invariant is preserved.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useCollaborativeEditor, type EditorHost } from '@nimbalyst/extension-sdk';
import type { RevoGridElement } from '../revogrid-types';
import type { GridSourceData } from '../utils/gridOperations';
import type { SpreadsheetMetadata } from '../hooks/useSpreadsheetMetadata';
import { createCsvEditorBinding } from '../collab/createCsvEditorBinding';
import { isCsvYDocEmpty, seedCsvYDoc } from '../collab/seed';
import type { RemotePresence } from '../collab/presence';
import { LocalPresenceTracker } from '../collab/localPresence';
import { SheetsTextEditor } from '../editors/SheetsTextEditor';
import type { CellPosition, EditorCore } from './editorCore';
import { metaSnapshotOf } from './editorUtils';

const AWARENESS_THROTTLE_MS = 100;

export function useCollabWiring(
  host: EditorHost,
  core: EditorCore,
  applyGridSource: (grid: RevoGridElement, gridData: GridSourceData) => void,
) {
  const { collabBindingRef, collabActiveRef, diffStateRef, hydration, gridContainerRef } = core;

  // Remote collaborator presence (selected/editing cells) for the in-grid
  // overlay. `presenceRepaintTick` forces the overlay to re-measure cell rects
  // on scroll/resize even when the presence list itself is unchanged.
  const [remotePresences, setRemotePresences] = useState<RemotePresence[]>([]);
  const [presenceRepaintTick, setPresenceRepaintTick] = useState(0);
  const presenceRafRef = useRef<number | null>(null);
  // Trailing throttle for local selection publishes (rapid arrow-key nav).
  const awarenessThrottleRef = useRef<{ timer: ReturnType<typeof setTimeout> | null; last: number }>({ timer: null, last: 0 });
  // Single writer for the local `selectedCell`/`editingCell` pair. Lazily
  // constructed rather than `useRef(new ...)` so a hot re-render does not
  // allocate a tracker it immediately discards.
  const localPresenceRef = useRef<LocalPresenceTracker | undefined>(undefined);
  localPresenceRef.current ??= new LocalPresenceTracker();
  const localPresence = localPresenceRef.current;
  const { isCollaborative: isCollabActive } = useCollaborativeEditor(host, {
    isEmpty: isCsvYDocEmpty,
    initializeFromContent: seedCsvYDoc,
    createBinding: (context) => createCsvEditorBinding(context, {
      loadedCsvContentRef: core.loadedCsvContentRef,
      pendingDataRef: core.pendingDataRef,
      revoGridRef: core.revoGridRef,
      dataLoadedRef: core.dataLoadedRef,
      spreadsheetMetaRef: core.spreadsheetMetaRef,
      metaBindingRef: core.metaBindingRef,
      lastPublishedMetaRef: core.lastPublishedMetaRef,
      collabBindingRef,
      collabActiveRef,
      gridOpsRef: core.gridOpsRef,
      hydration,
      prepareGridData: core.prepareGridData,
      applyGridSource,
      setRemotePresences,
    }),
  });

  // Forward local edits into the Y.Text. RevoGrid has no single "data
  // mutation" event we can hook, so we poll on a 1s cadence. The binding's
  // internal diff check is the actual sync gate -- when content hasn't
  // changed, syncNow is a quick string-compare + no Y.Text writes.
  useEffect(() => {
    if (!isCollabActive) return;
    const id = setInterval(() => {
      // Same reason the save path bails: the grid is showing phantom rows, and
      // syncing them would broadcast the AI's deleted rows to collaborators as
      // live content.
      if (diffStateRef.current?.isActive || !hydration.isReady) return;
      collabBindingRef.current?.scheduleSync();
    }, 1000);
    return () => clearInterval(id);
  }, [isCollabActive, hydration, diffStateRef, collabBindingRef]);

  // Coalesced repaint of the presence overlay. Cell rects are read from the
  // live DOM, so any scroll/resize needs a re-measure even when the presence
  // list is unchanged. rAF-batched so a scroll burst repaints once per frame.
  const schedulePresenceRepaint = useCallback(() => {
    if (presenceRafRef.current !== null) return;
    presenceRafRef.current = requestAnimationFrame(() => {
      presenceRafRef.current = null;
      setPresenceRepaintTick((t) => t + 1);
    });
  }, []);

  // Publish the local selected cell to awareness, trailing-throttled so rapid
  // arrow-key navigation doesn't churn the awareness channel. The editing cell
  // rides along unchanged: RevoGrid emits focus and range events while a cell
  // editor is open, and a selection publish that asserted "not editing" there
  // retracted the flag mid-edit (see localPresence.ts).
  const publishLocalSelection = useCallback((cell: CellPosition | null) => {
    if (!collabActiveRef.current) return;
    const state = awarenessThrottleRef.current;
    const flush = () => {
      state.last = Date.now();
      state.timer = null;
      collabBindingRef.current?.setLocalAwareness(localPresence.select(cell));
    };
    const elapsed = Date.now() - state.last;
    if (state.timer) clearTimeout(state.timer);
    if (elapsed >= AWARENESS_THROTTLE_MS) {
      flush();
    } else {
      state.timer = setTimeout(flush, AWARENESS_THROTTLE_MS - elapsed);
    }
  }, [localPresence, collabActiveRef, collabBindingRef]);

  // Clean up the throttle timer / pending rAF on unmount.
  useEffect(() => {
    return () => {
      if (awarenessThrottleRef.current.timer) clearTimeout(awarenessThrottleRef.current.timer);
      if (presenceRafRef.current !== null) cancelAnimationFrame(presenceRafRef.current);
    };
  }, []);

  // Re-measure presence markers when the grid container resizes (pane resize,
  // window resize, formula-bar show/hide). No-op when not collaborating.
  useEffect(() => {
    if (!isCollabActive) return;
    const el = gridContainerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => schedulePresenceRepaint());
    ro.observe(el);
    return () => ro.disconnect();
  }, [isCollabActive, schedulePresenceRepaint, gridContainerRef]);

  // Stable editors object.
  //
  // The subclass exists so the open-editor lifetime -- not a later focus event
  // -- is what ends the published `editingCell`. `disconnectedCallback` covers
  // every close RevoGrid has: commit, Escape, and unmount. Each instance
  // captures the session it opened under so an outgoing editor disconnecting
  // after the next one opened cannot clear the incoming flag.
  const editors = useMemo(() => ({
    sheets: class PresenceAwareSheetsTextEditor extends SheetsTextEditor {
      private readonly presenceSession = localPresence.currentSession();

      // The key controller drives the open editor (commit, cancel, newline),
      // so it registers itself for that lifetime.
      constructor(...args: ConstructorParameters<typeof SheetsTextEditor>) {
        super(...args);
        this.editSession = core.openingEditSessionRef.current ?? core.editSessionRef.current;
        core.activeEditorRef.current = this;
        this.initialText = core.pendingEditTextRef.current;
        core.pendingEditTextRef.current = null;
        core.openingEditSessionRef.current = null;
      }

      async componentDidRender(): Promise<void> {
        // Opened for an edit the keyboard has already committed past.
        if (this.editSession !== core.editSessionRef.current) {
          this.cancel();
          return;
        }
        await super.componentDidRender();
      }

      disconnectedCallback(): void {
        const patch = localPresence.endEdit(this.presenceSession);
        if (patch) collabBindingRef.current?.setLocalAwareness(patch);
        if (core.activeEditorRef.current === this) core.activeEditorRef.current = null;
        if (this.editSession === core.editSessionRef.current) {
          core.keyStateRef.current = { ...core.keyStateRef.current, mode: 'none' };
        }
      }
    },
  }), [localPresence, collabBindingRef, core]);

  return {
    isCollabActive,
    remotePresences,
    presenceRepaintTick,
    schedulePresenceRepaint,
    publishLocalSelection,
    localPresence,
    editors,
  };
}

/**
 * Push local metadata edits into the shared map. Keyed on the metadata object
 * rather than on each setter so every path that changes it -- the format
 * dialog, a column resize, the header toggle -- publishes the same way.
 */
export function useMetaPublish(core: EditorCore, metadata: SpreadsheetMetadata): void {
  const { metaBindingRef } = core;
  useEffect(() => {
    const metaBinding = metaBindingRef.current;
    if (!metaBinding) return;
    metaBinding.publish(metaSnapshotOf(metadata));
  }, [metadata, metaBindingRef]);
}
