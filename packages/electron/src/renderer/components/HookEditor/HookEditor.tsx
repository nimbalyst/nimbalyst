/**
 * The hook editor: three settings files as tabs, the blocks in the middle,
 * and JSON, Checks and Changes at the side. Every change goes through the
 * reducer in hookEditorState.ts; main does all disk work.
 */

import { DndContext, DragOverlay, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import type { ReferenceType } from '@floating-ui/react';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';

import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';

import type { OpenedFile } from '../../../main/services/hookEditor/HookFileService';
import type { SettingsSource } from '../../../main/services/hookEditor/hookFiles';
import type { CheckResult } from '../../../shared/hookEditor/hookChecks';
import { readBlocks, type HookDocument, type HookKey } from '../../../shared/hookEditor/hookDocument';
import type { HookEdit, NewBlock, Place } from '../../../shared/hookEditor/hookEdits';
import { HookCanvas, WhenDropArea } from './HookCanvas';
import { HookChangesPane } from './HookChangesPane';
import { HookChecksPane } from './HookChecksPane';
import { HookJsonPane } from './HookJsonPane';
import { HookPausedTray } from './HookPausedTray';
import { AskFields, HookPalette, type PaletteAsk } from './HookPalette';
import { HookRestorePanel } from './HookRestorePanel';
import { HookReviewPanel } from './HookReviewPanel';
import { changeSentences, currentDocument, editTab, fileChangedNeedsSeed, hasUnsaved, hooksOffFile, openTab, pausedRows, placeOfSelection, screenReducer, starterHookFor, unreadTab, writeTab } from './hookEditorState';
import { dropEdit, type DragItem, type DropTarget } from './hookDrops';
import { BUTTON, SETTINGS_TABS, type BlockKind, type PaletteItem } from './hookEditorText';
import { HelpTooltip } from '../../help/HelpTooltip';

export interface HookEditorProps {
  workspacePath: string;
  source: SettingsSource;
  /** The block to select when the editor opens, by its id. */
  selectId: string | null;
  /** Put the cursor in the palette search when the editor opens, for "+ New hook". */
  focusPalette: boolean;
  onClose: () => void;
}

export type SidePane = 'json' | 'checks' | 'changes' | 'backups';

const SIDE_TAB_NAMES: Readonly<Record<SidePane, string>> = { json: 'JSON', checks: 'Checks', changes: 'Changes', backups: 'Backups' };

/** The last part of a file path, such as settings.local.json. */
function fileNameOf(filePath: string | undefined): string {
  return filePath?.split(/[\\/]/).pop() || 'the whole file';
}

/** The colour kind of each block id in a document: event, group, action, Then or kept-as-is. */
export function blockKinds(doc: HookDocument | null): Map<string, BlockKind> {
  const kinds = new Map<string, BlockKind>();
  for (const event of doc === null ? [] : readBlocks(doc)) {
    kinds.set(event.id, 'when');
    for (const group of event.groups) {
      kinds.set(group.id, 'onlyWhen');
      for (const block of group.hooks) kinds.set(block.id, block.kind);
    }
  }
  return kinds;
}

export function HookEditor({ workspacePath, source, selectId, focusPalette, onClose }: HookEditorProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  // True while a block is being dragged. A ref, so the key handler always reads the current value.
  const draggingRef = useRef(false);
  const [state, dispatch] = useReducer(screenReducer, { tabs: [], activeSource: source, notice: null });
  const [selectedId, setSelectedId] = useState<string | null>(selectId);
  const [side, setSide] = useState<SidePane>('json');
  const [forcedChecks, setForcedChecks] = useState<CheckResult[] | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  // Counts restores. The Backups tab starts over after each one, so its list shows the version the restore replaced.
  const [restoreCount, setRestoreCount] = useState(0);
  // True while the Review panel takes the place of the JSON, Checks and Changes panes.
  const [reviewing, setReviewing] = useState(false);
  // A "When" block picked in the palette that has no action yet. It lives on the screen only.
  const [pendingWhen, setPendingWhen] = useState<Place | null>(null);
  // Marks the one delete the "Hook deleted" bar can undo: the file tab and how many undo steps it had after the delete.
  const [deleted, setDeleted] = useState<{ source: SettingsSource; steps: number } | null>(null);

  // A palette block dropped on the canvas. It asks for its fields next to where it landed.
  const [dropAsk, setDropAsk] = useState<{ item: PaletteItem; place: Place; anchor: ReferenceType } | null>(null);
  // A palette block that was clicked and asks for its fields. Null while that popover is closed.
  const [paletteAsk, setPaletteAsk] = useState<PaletteAsk | null>(null);
  // The name of the block being dragged, shown next to the pointer. Null while nothing is dragged.
  const [dragLabel, setDragLabel] = useState<string | null>(null);
  const sensors = useSensors(
    // A 4 px start distance keeps a click on a block a click.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const reload = useCallback(
    async (which: SettingsSource) => {
      try {
        const opened = (await window.electronAPI.invoke('hook-editor:open', workspacePath, which)) as OpenedFile;
        dispatch({ type: 'opened', tab: openTab(which, opened) });
      } catch {
        // The tab still opens, and shows why it is empty.
        dispatch({ type: 'opened', tab: unreadTab(which) });
      }
    },
    [workspacePath],
  );

  useEffect(() => {
    for (const tab of SETTINGS_TABS) void reload(tab.source);
  }, [reload]);

  // After a restore the file is read again. The reload clears the notice, so the notice goes in after it.
  const afterRestore = useCallback(
    (which: SettingsSource, pruneWarning: string | null, restoredFrom: string) => {
      setRestoreCount((count) => count + 1);
      void reload(which).then(() => {
        const restored = `Restored the backup from ${restoredFrom}. The version it replaced is now a backup too.`;
        dispatch({ type: 'notice', text: pruneWarning === null ? restored : `${restored} ${pruneWarning}` });
      });
    },
    [reload],
  );

  const active = state.tabs.find((tab) => tab.source === state.activeSource);
  const document = active === undefined ? null : currentDocument(active);
  const written = useMemo(() => (active === undefined ? null : writeTab(active)), [active]);
  const kinds = useMemo(() => blockKinds(document), [document]);
  const changes = active === undefined ? [] : changeSentences(active);
  const unsaved = state.tabs.some(hasUnsaved);
  // While changes are not saved, a reload, a window close or a quit asks first. The main process asks the question.
  useEffect(() => {
    if (!unsaved) return;
    window.electronAPI.send('hook-editor:set-unsaved', true);
    const holdPage = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', holdPage);
    return () => {
      window.removeEventListener('beforeunload', holdPage);
      window.electronAPI.send('hook-editor:set-unsaved', false);
    };
  }, [unsaved]);
  const offFile = hooksOffFile(state.tabs);
  // FileChanged hooks only run for files on a watch list. Warn while no open file gives it one.
  const openDocuments = state.tabs.map(currentDocument).filter((doc): doc is HookDocument => doc !== null);
  // Wait until all three files are read, or the warning would flash while they load.
  const needsSeed = state.tabs.length === SETTINGS_TABS.length && document !== null && fileChangedNeedsSeed(document, openDocuments);
  // The "Add the watch list" button the form opens next to. Null while the form is closed.
  const [seedAnchor, setSeedAnchor] = useState<Element | null>(null);
  // When the warning goes away, the watch-list form goes with it.
  useEffect(() => {
    if (!needsSeed) setSeedAnchor(null);
  }, [needsSeed]);

  // Every edit carries the document the user saw, so a stale key is refused, not misapplied.
  // A refused save shows its own Checks results. Any later edit makes them out of date, so they go.
  const sendEdit = (edit: HookEdit) => {
    if (document === null) return;
    setForcedChecks(null);
    dispatch({ type: 'edit', seen: document, edit });
  };
  const step = (type: 'undo' | 'redo') => {
    setForcedChecks(null);
    // An open popover was asked for the old state of the file. After a step it would add to the wrong place, and it would hold Escape.
    setPaletteAsk(null);
    setDropAsk(null);
    dispatch({ type });
  };
  const target = pendingWhen ?? (document === null ? null : placeOfSelection(document, selectedId));

  const select = (id: string | null) => {
    setPendingWhen(null);
    setSelectedId(id);
  };

  // Works out first whether an edit goes through. A refused edit sends nothing and hands back its reason, so a popover can show it.
  const tryEdit = (edit: HookEdit): string | null => {
    if (active === undefined || document === null) return null;
    const { reason } = editTab(active, document, edit);
    if (reason === null) sendEdit(edit);
    return reason;
  };

  const onDelete = (key: HookKey) => {
    if (active === undefined || document === null) return;
    const edit: HookEdit = { kind: 'remove', key };
    // Work out first whether the delete will go through. A refused delete shows its reason and no bar.
    const result = editTab(active, document, edit);
    sendEdit(edit);
    if (result.reason !== null || result.tab.history === null) return;
    setSelectedId(null);
    setDeleted({ source: active.source, steps: result.tab.history.past.length });
  };

  // A paused hook leaves the canvas, so the hooks after it move up. Close the form, as Delete does.
  const onPause = (key: HookKey) => {
    sendEdit({ kind: 'pause', key });
    setSelectedId(null);
  };

  // The bar belongs to that one delete. Any later edit, undo or tab change changes the step count, so the bar goes.
  const deleteIsLatest = deleted !== null && active?.source === deleted.source && active.history?.past.length === deleted.steps;
  useEffect(() => {
    if (deleted !== null && !deleteIsLatest) setDeleted(null);
  }, [deleted, deleteIsLatest]);

  // The "Hook deleted" bar also goes away by itself after a few seconds.
  useEffect(() => {
    if (deleted === null) return;
    const timer = setTimeout(() => setDeleted(null), 6000);
    return () => clearTimeout(timer);
  }, [deleted]);

  // The Review panel is for changes. With none left (after a save, an undo or a reload), or in another file, it closes.
  useEffect(() => {
    if (changes.length === 0) setReviewing(false);
  }, [changes.length, state.activeSource]);

  // A "When" block that waits for its first action belongs to the file tab it was picked in.
  useEffect(() => {
    setPendingWhen(null);
    setDropAsk(null);
    setPaletteAsk(null);
    setSeedAnchor(null);
  }, [state.activeSource]);

  const onAdd = (place: Place, block: NewBlock): string | null => {
    const reason = tryEdit({ kind: 'add', place, block });
    if (reason === null) setPendingWhen(null);
    return reason;
  };

  // Picking a "When" block adds an example hook through the same add path as the palette, so undo, the unsaved count and the review work as usual.
  // The new hook opens its form. If no example fits, the picked event shows as a heading and waits for a first action.
  const pickWhen = (event: string) => {
    const starter = document === null ? null : starterHookFor(state.activeSource, document, event);
    if (starter !== null && onAdd(starter.place, starter.block) === null) {
      setSelectedId(starter.selectId);
      return;
    }
    setSelectedId(null);
    setPendingWhen({ event, matcher: null });
  };

  const onDragStart = ({ active }: DragStartEvent) => {
    draggingRef.current = true;
    setDragLabel((active.data.current?.label as string | undefined) ?? null);
  };

  // A hook dropped in a new place is one move edit. A palette block dropped on the canvas asks for its fields first.
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    draggingRef.current = false;
    setDragLabel(null);
    const drag = active.data.current?.drag as DragItem | undefined;
    if (drag === undefined || over === null) return;
    // A "When" chip dropped anywhere on the canvas starts a hook, the same as its Add button.
    if (drag.kind === 'when') return pickWhen(drag.event);
    const target = over.data.current?.target as DropTarget | undefined;
    if (target === undefined) return;
    const result = dropEdit(drag, target, state.activeSource);
    if (result.kind === 'refused') dispatch({ type: 'notice', text: result.reason });
    if (result.kind === 'edit') {
      sendEdit(result.edit);
      // A move shifts the hooks around, so the selected id may now name a different hook. The selection is cleared, not followed.
      if (result.edit.kind === 'move') setSelectedId(null);
    }
    if (result.kind === 'askFields') {
      const { left, top, width, height } = over.rect;
      const rect = { x: left, y: top, left, top, width, height, right: left + width, bottom: top + height };
      setDropAsk({ item: result.item, place: result.place, anchor: { getBoundingClientRect: () => rect } });
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const onPage = event.target === window.document.body;
    if (event.key === 'Escape') {
      // Escape that cancels typed input-method text must not close the editor.
      if (event.isComposing) return;
      // Escape that cancels a keyboard drag belongs to the drag.
      if (draggingRef.current) return;
      // While a popover is open, Escape belongs to it. The popover closes itself.
      if (paletteAsk !== null || dropAsk !== null || seedAnchor !== null) return;
      // A popover renders outside the editor on the page. Escape there closes only the popover.
      if (!onPage && !rootRef.current?.contains(event.target as Node)) return;
      event.preventDefault();
      // Escape in a text box only leaves the box. Leaving it puts the typed text into the hook,
      // and the focus goes to the editor, so the next Escape asks before it closes.
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) {
        event.target.blur();
        rootRef.current?.focus();
        return;
      }
      close();
      return;
    }
    if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'z') return;
    // Text boxes keep their own undo. A slider, a checkbox or a radio button has no typed text, so Cmd+Z there undoes the hook.
    const { target } = event;
    if (target instanceof HTMLTextAreaElement || (target instanceof HTMLInputElement && !['range', 'checkbox', 'radio'].includes(target.type))) return;
    event.preventDefault();
    step(event.shiftKey ? 'redo' : 'undo');
  };

  const close = () => (changes.length > 0 ? setConfirmClose(true) : onClose());

  // A click can remove or turn off the control that has the focus: a chip rebuilds its row, and Undo
  // turns off when nothing is left to undo. The focus then falls to the page, outside the editor.
  // Keys that land on the page come back to the editor, so Cmd+Z and Escape still work.
  const keyRef = useRef(onKeyDown);
  keyRef.current = onKeyDown;
  useEffect(() => {
    const onPageKey = (event: KeyboardEvent) => {
      if (event.target !== window.document.body) return;
      rootRef.current?.focus();
      keyRef.current(event);
    };
    window.addEventListener('keydown', onPageKey);
    return () => window.removeEventListener('keydown', onPageKey);
  }, []);

  useEffect(() => {
    // The palette's "When" box takes focus for "+ New hook"; otherwise the editor does, so its keys work at once.
    if (!focusPalette) rootRef.current?.focus();
  }, [focusPalette]);

  return (
    <div ref={rootRef} className="hook-editor outline-none flex h-full flex-col bg-[var(--nim-bg)] text-[var(--nim-text)]" data-testid="hook-editor" onKeyDown={(event) => onKeyDown(event.nativeEvent)} tabIndex={-1}>
      <header className="flex items-center gap-3 border-b border-[var(--nim-border)] px-4 py-2">
        <h2 className="text-base font-semibold">Claude Code hooks</h2>
        {changes.length > 0 && (
          <span className="flex items-center gap-1 text-sm text-[var(--nim-warning)]" data-testid="hook-unsaved-count">
            <span className="h-2 w-2 rounded-full bg-[var(--nim-warning)]" />
            {changes.length === 1 ? '1 change not saved' : `${changes.length} changes not saved`}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <HelpTooltip testId="hook-review">
            <button type="button" data-testid="hook-review" className={BUTTON.primary} disabled={changes.length === 0} onClick={() => setReviewing(true)}>
              Review and save
            </button>
          </HelpTooltip>
          <HelpTooltip testId="hook-undo">
            <button type="button" data-testid="hook-undo" aria-label="Undo" className={`${BUTTON.ghost} ${BUTTON.small}`} disabled={!active?.history?.past.length} onClick={() => step('undo')}>
              <MaterialSymbol icon="undo" />
            </button>
          </HelpTooltip>
          <button type="button" data-testid="hook-redo" title="Redo" aria-label="Redo" className={`${BUTTON.ghost} ${BUTTON.small}`} disabled={!active?.history?.future.length} onClick={() => step('redo')}>
            <MaterialSymbol icon="redo" />
          </button>
          <button type="button" data-testid="hook-close" className={BUTTON.secondary} onClick={close}>
            Close
          </button>
        </div>
      </header>

      {confirmClose && (
        <div className="flex items-center gap-2 bg-[var(--nim-bg-secondary)] px-4 py-2 text-sm">
          <span className="flex-1">Close without saving? Your changes are lost.</span>
          <button type="button" data-testid="hook-close-anyway" className={`${BUTTON.danger} ${BUTTON.small}`} onClick={onClose}>
            Close without saving
          </button>
          <button type="button" className={`${BUTTON.secondary} ${BUTTON.small}`} onClick={() => setConfirmClose(false)}>
            Keep editing
          </button>
        </div>
      )}

      <nav className="flex gap-1 border-b border-[var(--nim-border)] px-4">
        {SETTINGS_TABS.map((tab) => {
          const file = state.tabs.find((candidate) => candidate.source === tab.source);
          return (
            <button
              key={tab.source}
              type="button"
              data-testid={`hook-file-tab-${tab.source}`}
              className={tab.source === state.activeSource ? 'border-b-2 border-[var(--nim-primary)] px-3 py-2' : 'px-3 py-2 text-[var(--nim-text-muted)]'}
              onClick={() => {
                // Another file has other hooks. A hook at the same place there must not open just because the place matches.
                if (tab.source !== state.activeSource) setSelectedId(null);
                dispatch({ type: 'show', source: tab.source });
              }}
            >
              {tab.name}
              <span className="ml-2 select-text text-xs text-[var(--nim-text-faint)]">{file?.filePath ?? ''}</span>
              {tab.inGit && <span className="ml-2 rounded bg-[var(--nim-bg-tertiary)] px-1 text-xs">in git</span>}
            </button>
          );
        })}
      </nav>

      {state.notice !== null && (
        <p className="select-text bg-[var(--nim-bg-secondary)] px-4 py-2 text-sm" data-testid="hook-notice">
          {state.notice}
        </p>
      )}
      {offFile !== null && (
        <p className="select-text bg-[var(--nim-bg-secondary)] px-4 py-2 text-sm text-[var(--nim-warning)]" data-testid="hook-hooks-off">
          Hooks are off in {offFile}. Nothing in this file runs.
        </p>
      )}

      <div className="flex min-h-0 flex-1">
        <main className="hook-canvas-area min-w-0 flex-1 overflow-auto" data-testid="hook-canvas-area">
          {active?.openProblem != null && (
            <div className="m-4 rounded border border-[var(--nim-error)]">
              <p className="select-text p-3 text-sm" data-testid="hook-open-problem">
                {active.openProblem} Restore a backup, or fix the file in a text editor.
              </p>
              <HookRestorePanel
                workspacePath={workspacePath}
                source={active.source}
                unsavedCount={changes.length}
                onRestored={(pruneWarning, restoredFrom) => afterRestore(active.source, pruneWarning, restoredFrom)}
              />
            </div>
          )}
          {needsSeed && (
            <div className="m-4 flex items-center gap-3 rounded border border-[var(--nim-warning)] p-3 text-sm" data-testid="hook-filechanged-warning">
              <span className="flex-1">
                FileChanged runs only for files on a watch list, and no SessionStart or CwdChanged hook sets one. If one of your scripts already returns
                watchPaths, you can ignore this.
              </span>
              <HelpTooltip testId="hook-add-watch-helper">
                <button type="button" data-testid="hook-add-watch-helper" className={`${BUTTON.secondary} ${BUTTON.small}`} onClick={(event) => setSeedAnchor(event.currentTarget)}>
                  Add the watch list
                </button>
              </HelpTooltip>
            </div>
          )}
          {seedAnchor !== null && (
            <AskFields
              item={{ kind: 'then', answer: 'watchFiles' }}
              anchor={seedAnchor}
              onCancel={() => setSeedAnchor(null)}
              onAdd={(block) => {
                // Not onAdd: a "When" block the user picked and has not filled yet must stay.
                const reason = tryEdit({ kind: 'add', place: { event: 'SessionStart', matcher: null }, block });
                if (reason === null) setSeedAnchor(null);
                return reason;
              }}
            />
          )}
          {document !== null && (
            <div className="flex h-full">
              <DndContext
                sensors={sensors}
                onDragStart={onDragStart}
                onDragEnd={onDragEnd}
                onDragCancel={() => {
                  draggingRef.current = false;
                  setDragLabel(null);
                }}
              >
                <HookPalette
                  source={state.activeSource}
                  target={target}
                  focusSearch={focusPalette}
                  asking={paletteAsk}
                  onAsk={setPaletteAsk}
                  onPickWhen={pickWhen}
                  onAdd={onAdd}
                />
                <WhenDropArea>
                  <HookCanvas
                    document={document}
                    selectedId={selectedId}
                    pendingWhen={pendingWhen}
                    onSelect={select}
                    onEdit={sendEdit}
                    onDelete={onDelete}
                    onPause={onPause}
                  />
                  <HookPausedTray rows={pausedRows(document)} onResume={(index) => sendEdit({ kind: 'resume', pausedIndex: index })} />
                </WhenDropArea>
                {/* The name of the dragged block follows the pointer, so a palette drag shows what moves. */}
                <DragOverlay dropAnimation={null}>
                  {dragLabel !== null && (
                    <div className="hook-drag-overlay rounded border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] px-2 py-1 text-sm shadow">{dragLabel}</div>
                  )}
                </DragOverlay>
              </DndContext>
              {dropAsk !== null && (
                <AskFields
                  item={dropAsk.item}
                  anchor={dropAsk.anchor}
                  onCancel={() => setDropAsk(null)}
                  onAdd={(block) => {
                    const reason = onAdd(dropAsk.place, block);
                    if (reason === null) setDropAsk(null);
                    return reason;
                  }}
                />
              )}
            </div>
          )}
          {deleteIsLatest && (
            <div className="fixed bottom-6 left-1/2 flex -translate-x-1/2 items-center gap-3 rounded bg-[var(--nim-bg-tertiary)] px-4 py-2 text-sm shadow">
              Hook deleted.
              <button
                type="button"
                data-testid="hook-undo-toast"
                className={`${BUTTON.ghost} ${BUTTON.small}`}
                onClick={() => {
                  step('undo');
                  setDeleted(null);
                }}
              >
                Undo
              </button>
            </div>
          )}
        </main>

        <aside className="flex w-[40%] min-w-[320px] flex-col border-l border-[var(--nim-border)]">
          <div className="flex gap-1 border-b border-[var(--nim-border)] px-2">
            {(['json', 'checks', 'changes', 'backups'] as const).map((pane) => (
              <button
                key={pane}
                type="button"
                data-testid={`hook-side-tab-${pane}`}
                // The Review panel takes this space, so these tabs wait until it closes.
                disabled={reviewing}
                title={reviewing ? 'Go back from the review to see this.' : undefined}
                className={`${pane === side ? 'border-b-2 border-[var(--nim-primary)] px-3 py-2' : 'px-3 py-2 text-[var(--nim-text-muted)]'} disabled:cursor-not-allowed disabled:opacity-50`}
                onClick={() => setSide(pane)}
              >
                {SIDE_TAB_NAMES[pane]}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {reviewing && active !== undefined ? (
              <HookReviewPanel
                workspacePath={workspacePath}
                tab={active}
                onBack={() => setReviewing(false)}
                onSaved={(text, pruneWarning, savedPaused) => {
                  dispatch({ type: 'saved', text, paused: savedPaused });
                  // The save clears the notice, so a warning from the save goes in after it.
                  if (pruneWarning !== null) dispatch({ type: 'notice', text: pruneWarning });
                  setForcedChecks(null);
                  setReviewing(false);
                }}
                onReload={() => {
                  setReviewing(false);
                  setSelectedId(null);
                  setForcedChecks(null);
                  void reload(active.source);
                }}
                onRestored={(pruneWarning, restoredFrom) => {
                  setReviewing(false);
                  setSelectedId(null);
                  setForcedChecks(null);
                  afterRestore(active.source, pruneWarning, restoredFrom);
                }}
                onChecksFailed={(checks, reason) => {
                  setForcedChecks(checks);
                  setReviewing(false);
                  setSide('checks');
                  // The Review panel closes, so its reason goes to the notice bar.
                  dispatch({ type: 'notice', text: reason });
                }}
              />
            ) : (
              <>
                {side === 'json' && (
                  <HookJsonPane written={written} fileName={fileNameOf(active?.filePath)} kindOf={(id) => kinds.get(id) ?? 'opaque'} selectedId={selectedId} onSelect={select} />
                )}
                {side === 'checks' && active !== undefined && (
                  <HookChecksPane key={active.source} workspacePath={workspacePath} source={active.source} text={written?.text ?? null} forced={forcedChecks} />
                )}
                {side === 'changes' && written !== null && <HookChangesPane parts={written.diff.parts} />}
                {side === 'backups' && active !== undefined && (
                  <HookRestorePanel
                    key={`${active.source}-${restoreCount}`}
                    workspacePath={workspacePath}
                    source={active.source}
                    emptyText="No backups yet. Nimbalyst makes one before every save."
                    unsavedCount={changes.length}
                    onRestored={(pruneWarning, restoredFrom) => {
                      setSelectedId(null);
                      setForcedChecks(null);
                      afterRestore(active.source, pruneWarning, restoredFrom);
                    }}
                  />
                )}
              </>
            )}
          </div>
        </aside>
      </div>

      <footer className="border-t border-[var(--nim-border)] px-4 py-1 text-xs text-[var(--nim-text-muted)]">
        Changes start in new sessions. Sessions already open keep the old hooks.
      </footer>
    </div>
  );
}
