/**
 * Excalidraw <-> Y.Doc binding.
 *
 * Ported from the prior Crystal codebase (see plan §Phase 4). The binding is
 * lazy-constructed when the SDK's `useCollaborativeEditor` hook fires
 * `createBinding`. It wires:
 *   - local Excalidraw onChange -> Y.Array<Y.Map> delta operations
 *   - remote Y.Array changes -> Excalidraw `updateScene`
 *   - Excalidraw asset map -> Y.Map<BinaryFileData> (append/delete only)
 *   - awareness pointer/selection -> Excalidraw `collaborators` prop
 *   - Y.UndoManager hijack for undo/redo (replaces the built-in stack)
 */

import type {
  AppState,
  BinaryFileData,
  BinaryFiles,
  Collaborator,
  ExcalidrawImperativeAPI,
  SocketId,
} from '@excalidraw/excalidraw/types';
import type {
  ExcalidrawElement,
  NonDeletedExcalidrawElement,
} from '@excalidraw/excalidraw/element/types';
import type * as awarenessProtocol from 'y-protocols/awareness';
import * as Y from 'yjs';
import { CaptureUpdateAction, restoreElements } from '@excalidraw/excalidraw';
import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';
import {
  areElementsSame,
  debounce,
  yjsToExcalidraw,
  type DebouncedFn,
} from './excalidrawHelpers';
import {
  applyAssetOperations,
  applyElementOperations,
  getDeltaOperationsForAssets,
  getDeltaOperationsForElements,
  type LastKnownOrderedElement,
  type Operation,
} from './excalidrawDiff';

export { yjsToExcalidraw };

export interface UndoConfig {
  excalidrawDom: HTMLElement;
  undoManager: Y.UndoManager;
}

const compareOrderedElements = (
  a: LastKnownOrderedElement,
  b: LastKnownOrderedElement,
): number => {
  if (a.pos !== b.pos) return a.pos > b.pos ? 1 : -1;
  return a.id > b.id ? 1 : a.id < b.id ? -1 : 0;
};

type ElementRevision = {
  id: string;
  version: number;
  versionNonce: number;
};

/**
 * Match Excalidraw's own reconciliation rule: the higher version wins and,
 * when versions tie, the lower versionNonce wins. Array position is not a
 * revision signal and depends on concurrent Yjs insertion order.
 */
const isNewerElementRevision = (
  candidate: ElementRevision,
  current: ElementRevision,
): boolean => candidate.version > current.version || (
  candidate.version === current.version &&
  candidate.versionNonce < current.versionNonce
);

/**
 * Whether every element in a change callback's snapshot is already accounted
 * for -- at the same revision or newer -- somewhere we will not lose it.
 *
 * A snapshot that no longer matches the canvas is usually a stale callback and
 * safe to drop, but only once nothing in it is exclusive to it. An element the
 * snapshot alone knows about reaches the Y.Doc through this callback or not at
 * all.
 */
const isSupersededSnapshot = (
  snapshot: readonly { id: string; version: number }[],
  ...sources: readonly (readonly { id: string; version: number }[])[]
): boolean => {
  const newestById = new Map<string, number>();
  for (const source of sources) {
    for (const element of source) {
      const known = newestById.get(element.id);
      if (known === undefined || element.version > known) {
        newestById.set(element.id, element.version);
      }
    }
  }
  return snapshot.every(
    (element) => (newestById.get(element.id) ?? -1) >= element.version,
  );
};

export class ExcalidrawBinding {
  yElements: Y.Array<Y.Map<unknown>>;
  yAssets: Y.Map<unknown>;
  api: ExcalidrawImperativeAPI;
  awareness?: awarenessProtocol.Awareness;
  undoManager?: Y.UndoManager;

  subscriptions: Array<() => void> = [];
  collaborators: Map<SocketId, Collaborator> = new Map();
  lastKnownElements: LastKnownOrderedElement[] = [];
  lastKnownFileIds: Set<string> = new Set();
  private isApplyingRemoteElements = false;
  private pendingRemoteElementEchoes: Array<
    readonly { id: string; version: number }[]
  > = [];
  private remoteElementEchoTimers = new Set<ReturnType<typeof setTimeout>>();
  private apiChangeUnsubscribe: (() => void) | null = null;
  /**
   * The debounced local-to-shared push. Held on the instance so `syncNow` can
   * flush a pending scene into the Y.Doc on demand -- the host drains this
   * before it reports a write complete, so an AI tool cannot return success on
   * an edit still waiting out the 50ms delay.
   */
  private flushLocalChange!: DebouncedFn<
    [
      readonly NonDeletedExcalidrawElement[],
      LastKnownOrderedElement[],
      AppState['selectedElementIds'],
      BinaryFiles,
    ]
  >;

  constructor(
    yElements: Y.Array<Y.Map<unknown>>,
    yAssets: Y.Map<unknown>,
    api: ExcalidrawImperativeAPI,
    awareness?: awarenessProtocol.Awareness,
    undoConfig?: UndoConfig,
  ) {
    this.yElements = yElements;
    this.yAssets = yAssets;
    this.api = api;
    this.awareness = awareness;
    this.undoManager = undoConfig?.undoManager;
    const excalidrawDom = undoConfig?.excalidrawDom;

    // Local edits -> Y.Doc (debounced 50ms). Capture the event's element
    // snapshot and Y.Doc baseline immediately. A remote repaint can land
    // during the debounce window; re-reading api.getSceneElements() afterward
    // would silently replace the local edit with that remote canvas.
    this.flushLocalChange = debounce((
      capturedElements: readonly NonDeletedExcalidrawElement[],
      capturedBaseline: LastKnownOrderedElement[],
      selectedElementIds: AppState['selectedElementIds'],
      files: BinaryFiles,
    ) => {
      const baselineVersions = new Map(
        capturedBaseline.map((element) => [element.id, element.version]),
      );
      const capturedIds = new Set(capturedElements.map((element) => element.id));
      const currentElements = yjsToExcalidraw(this.yElements).filter(
        (element): element is NonDeletedExcalidrawElement => !element.isDeleted,
      );
      const currentById = new Map(
        currentElements.map((element) => [element.id, element]),
      );

      // Reconcile the delayed local snapshot with remote changes that arrived
      // after it was captured:
      // - unchanged baseline elements keep the current remote version;
      // - locally added/updated elements use the captured version;
      // - baseline elements omitted by the snapshot remain real deletions;
      // - remote additions absent from the old baseline are preserved.
      const elements: NonDeletedExcalidrawElement[] = [];
      for (const captured of capturedElements) {
        const baselineVersion = baselineVersions.get(captured.id);
        if (baselineVersion === captured.version) {
          const current = currentById.get(captured.id);
          if (current) elements.push(current);
        } else {
          elements.push(captured);
        }
      }
      // The baseline is read when the callback is dispatched, not when
      // Excalidraw produced the snapshot, so "in the baseline but omitted by
      // the snapshot" does not by itself mean the user deleted it -- a remote
      // element that landed in between looks identical. Require the canvas to
      // have dropped it too before treating the omission as a deletion.
      const sceneIds = new Set(
        this.api.getSceneElements().map((element) => element.id),
      );
      for (const current of currentElements) {
        if (capturedIds.has(current.id)) continue;
        if (!baselineVersions.has(current.id) || sceneIds.has(current.id)) {
          elements.push(current);
        }
      }

      let operations: Operation[] = [];
      if (!areElementsSame(this.lastKnownElements, elements)) {
        try {
          const res = getDeltaOperationsForElements(
            this.lastKnownElements,
            elements,
          );
          operations = res.operations;
          this.lastKnownElements = res.lastKnownElements;
          applyElementOperations(this.yElements, operations, this);
        } catch (error) {
          console.error('[ExcalidrawBinding] Error applying element operations:', error);
          this.ensureValidOrderingKeys();
          try {
            const newKeys = generateNKeysBetween(null, null, elements.length);
            const yDoc = this.yElements.doc!;
            yDoc.transact(() => {
              this.yElements.delete(0, this.yElements.length);
              elements.forEach((el, idx) => {
                const yElement = new Y.Map<unknown>();
                yElement.set('el', el);
                yElement.set('pos', newKeys[idx]);
                this.yElements.push([yElement]);
              });
            }, this);
            this.lastKnownElements = elements.map((el, idx) => ({
              id: el.id,
              version: el.version,
              pos: newKeys[idx],
            }));
          } catch (err) {
            console.error('[ExcalidrawBinding] Failed to recover with full refresh:', err);
          }
        }
      }

      // A remote repaint may have replaced the imperative canvas while this
      // local snapshot was waiting in the debounce. The reconciliation above
      // preserves both edits in Y.Doc, but local-origin transactions are
      // intentionally ignored by the remote observer. Paint the merged Y.Doc
      // here as the final half of the local-to-shared bridge.
      const sharedAfterLocalChange = yjsToExcalidraw(this.yElements).filter(
        (element): element is NonDeletedExcalidrawElement =>
          !element.isDeleted,
      );
      if (!areElementsSame(this.api.getSceneElements(), sharedAfterLocalChange)) {
        this.updateRemoteElements(sharedAfterLocalChange);
      }

      const res = getDeltaOperationsForAssets(this.lastKnownFileIds, files);
      this.lastKnownFileIds = res.lastKnownFileIds;
      if (res.operations.length > 0) {
        applyAssetOperations(this.yAssets, res.operations, this);
      }

      if (this.awareness) {
        this.awareness.setLocalStateField(
          'selectedElementIds',
          selectedElementIds,
        );
      }
    }, 50);

    this.subscribeToApi(api);
    this.subscriptions.push(() => {
      this.apiChangeUnsubscribe?.();
      this.apiChangeUnsubscribe = null;
    });

    // Remote element changes -> Excalidraw scene.
    const _remoteElementsChangeHandler = (
      event: Array<Y.YEvent<Y.AbstractType<unknown>>>,
      txn: Y.Transaction,
    ): void => {
      if (txn.origin === this) return;

      const changedElementIds = new Set<string>(
        event.flatMap((e) => {
          if (e instanceof Y.YMapEvent) {
            const el = (e.target as Y.Map<unknown>).get('el') as
              | { id?: string }
              | undefined;
            return el?.id ? [el.id] : [];
          }
          return [];
        }),
      );

      const remoteElements = yjsToExcalidraw(this.yElements);
      // Defensive dedupe: bootstrap-race CRDT merges can land duplicate IDs in
      // the array. Keep the newest Excalidraw revision, never whichever Yjs
      // entry happens to be later in the merged array.
      const idCounts = new Map<string, number>();
      const duplicateIds = new Set<string>();
      for (const el of remoteElements) {
        if (el && el.id) {
          const next = (idCounts.get(el.id) || 0) + 1;
          idCounts.set(el.id, next);
          if (next > 1) duplicateIds.add(el.id);
        }
      }
      if (duplicateIds.size > 0) {
        console.warn('[ExcalidrawBinding] Duplicate element IDs detected:', [...duplicateIds]);
        const winnerIndices = new Map<string, number>();
        for (let i = 0; i < this.yElements.length; i++) {
          const element = this.yElements.get(i).get('el') as ElementRevision;
          if (!duplicateIds.has(element.id)) continue;
          const winnerIndex = winnerIndices.get(element.id);
          if (winnerIndex === undefined) {
            winnerIndices.set(element.id, i);
            continue;
          }
          const winner = this.yElements
            .get(winnerIndex)
            .get('el') as ElementRevision;
          if (isNewerElementRevision(element, winner)) {
            winnerIndices.set(element.id, i);
          }
        }

        const yDoc = this.yElements.doc!;
        yDoc.transact(() => {
          for (let i = this.yElements.length - 1; i >= 0; i--) {
            const item = this.yElements.get(i);
            const id = (item.get('el') as ElementRevision).id;
            if (duplicateIds.has(id) && winnerIndices.get(id) !== i) {
              this.yElements.delete(i, 1);
            }
          }
        }, this);
        this.lastKnownElements = this.yElements
          .toArray()
          .map((x) => ({
            id: (x.get('el') as { id: string }).id,
            version: (x.get('el') as { version: number }).version,
            pos: x.get('pos') as string,
          }))
          .sort(compareOrderedElements);
        this.updateRemoteElements(yjsToExcalidraw(this.yElements));
        return;
      }

      const elements = remoteElements.map((el) => {
        if (changedElementIds.has(el.id)) {
          return el;
        }
        return this.api.getSceneElements().find((existingEl) => existingEl.id === el.id) || el;
      });

      try {
        this.lastKnownElements = this.yElements
          .toArray()
          .map((x) => ({
            id: (x.get('el') as { id: string }).id,
            version: (x.get('el') as { version: number }).version,
            pos: x.get('pos') as string,
          }))
          .sort(compareOrderedElements);

        this.updateRemoteElements(elements);
      } catch (error) {
        console.error('[ExcalidrawBinding] Error in remote elements handler:', error);
        this.ensureValidOrderingKeys();
        const fallbackElements = yjsToExcalidraw(this.yElements);
        this.updateRemoteElements(fallbackElements);
      }
    };
    this.yElements.observeDeep(_remoteElementsChangeHandler);
    this.subscriptions.push(() =>
      this.yElements.unobserveDeep(_remoteElementsChangeHandler),
    );

    // Remote asset changes -> Excalidraw.
    const _remoteFilesChangeHandler = (
      events: Y.YMapEvent<unknown>,
      txn: Y.Transaction,
    ): void => {
      if (txn.origin === this) return;
      const addedFiles = [...events.keysChanged].map(
        (key) => this.yAssets.get(key) as BinaryFileData,
      );
      this.api.addFiles(addedFiles);
    };
    this.yAssets.observe(_remoteFilesChangeHandler);
    this.subscriptions.push(() => {
      this.yAssets.unobserve(_remoteFilesChangeHandler);
    });

    if (this.awareness) {
      this.awareness.on('change', this._remoteAwarenessChangeHandler);
      this.subscriptions.push(() => {
        this.awareness?.off('change', this._remoteAwarenessChangeHandler);
      });
    }

    if (this.undoManager && excalidrawDom) {
      this.setupUndoRedo(excalidrawDom);
    }

    // Init elements -- seed the cache so the first onChange diff has a baseline.
    const initialValue = yjsToExcalidraw(this.yElements);
    this.lastKnownElements = this.yElements
      .toArray()
      .map((x) => ({
        id: (x.get('el') as { id: string }).id,
        version: (x.get('el') as { version: number }).version,
        pos: x.get('pos') as string,
      }))
      .sort(compareOrderedElements);

    if (initialValue.length > 0) {
      // Push the synced Y.Doc state onto the canvas. For recipients of a
      // shared doc this is the first time the canvas sees these elements --
      // the editor was mounted with empty initialData because
      // host.loadContent() returns '' in collab mode. restoreElements
      // normalises shapes seeded by an older client or a different
      // Excalidraw version.
      const normalised = restoreElements(initialValue, null, {
        repairBindings: true,
        refreshDimensions: true,
      });
      this.updateRemoteElements(normalised);

      // Refresh lastKnownElements from the freshly-rendered scene so the
      // first onChange tick (debounced 50ms) sees a matching baseline.
      // If restoreElements or refreshDimensions bumped any versions during
      // normalisation, the cache would otherwise diff non-zero and echo
      // the initial render back into Y.Doc.
      const posById = new Map<string, string>();
      for (const x of this.yElements.toArray()) {
        const el = x.get('el') as { id: string };
        posById.set(el.id, x.get('pos') as string);
      }
      const renderedElements = this.api.getSceneElements();
      this.lastKnownElements = renderedElements
        .map((el) => ({
          id: el.id,
          version: el.version,
          pos: posById.get(el.id) ?? '',
        }))
        .filter((entry) => entry.pos !== '')
        .sort(compareOrderedElements);

      // Fit content on initial mount.
      setTimeout(() => {
        this.api.scrollToContent(undefined, {
          animate: false,
          fitToContent: true,
        });
      }, 10);

      // Excalidraw can finish its own initialization after the imperative API
      // ref becomes available and reset the scene back to `initialData`. A
      // collaborative editor intentionally mounts without file initialData,
      // so replay the already-hydrated Y.Doc on the next task as a per-mount
      // cold-paint bridge. This is especially important on offline restart,
      // where no later server event exists to repaint the canvas.
      const coldPaintTimer = setTimeout(() => {
        const current = this.api.getSceneElements();
        const shared = yjsToExcalidraw(this.yElements).filter(
          (element): element is NonDeletedExcalidrawElement =>
            !element.isDeleted,
        );
        if (!areElementsSame(current, shared)) {
          const restored = restoreElements(shared, null, {
            repairBindings: true,
            refreshDimensions: true,
          });
          this.updateRemoteElements(restored);
        }
      }, 0);
      this.subscriptions.push(() => clearTimeout(coldPaintTimer));
    }

    // Init assets.
    this.api.addFiles(
      [...this.yAssets.keys()].map((key) => this.yAssets.get(key) as BinaryFileData),
    );

    // Init collaborators.
    const collaborators = new Map<SocketId, Collaborator>();
    if (this.awareness) {
      for (const id of this.awareness.getStates().keys()) {
        if (id === this.awareness.clientID) continue;
        const state = this.awareness.getStates().get(id);
        if (state) {
          collaborators.set(id.toString() as SocketId, this.collaboratorFromAwarenessState(state, id));
        }
      }
    }
    this.api.updateScene({ collaborators });
    this.collaborators = collaborators;
  }

  private readonly handleApiChange = (
    elements: readonly ExcalidrawElement[],
    state: AppState,
    files: BinaryFiles,
  ): void => {
    const nonDeletedElements = elements.filter(
      (element): element is NonDeletedExcalidrawElement => !element.isDeleted,
    );
    if (this.consumeRemoteElementsEcho(nonDeletedElements)) return;
    if (this.isApplyingRemoteElements) return;
    // Excalidraw also fires onChange for updateScene(). Do not let a remote
    // repaint replace an already-queued local snapshot in the trailing-edge
    // debounce. The repaint is exactly the current Y.Doc projection, while a
    // real local change differs from it.
    const sharedElements = yjsToExcalidraw(this.yElements).filter(
      (element): element is NonDeletedExcalidrawElement => !element.isDeleted,
    );
    if (areElementsSame(sharedElements, nonDeletedElements)) {
      if (this.awareness) {
        this.awareness.setLocalStateField(
          'selectedElementIds',
          state.selectedElementIds,
        );
      }
      return;
    }
    // Excalidraw dispatches onChange asynchronously, so the canvas can have
    // moved on since this callback was queued -- typically a remote repaint
    // that landed between a local edit and its dispatch. Dropping the callback
    // outright loses that edit for good: it is then on neither the canvas nor
    // the Y.Doc, and the repaint's own callback is consumed as an echo. Skip a
    // stale snapshot only once everything in it survives elsewhere; otherwise
    // flush it and let the reconcile in flushLocalChange merge it with what
    // arrived in the meantime.
    const currentSceneElements = this.api.getSceneElements();
    if (
      !areElementsSame(currentSceneElements, nonDeletedElements)
      && isSupersededSnapshot(
        nonDeletedElements,
        currentSceneElements,
        sharedElements,
      )
    ) {
      return;
    }
    this.flushLocalChange(
      nonDeletedElements,
      this.lastKnownElements.map((element) => ({ ...element })),
      state.selectedElementIds,
      files,
    );
  };

  private subscribeToApi(api: ExcalidrawImperativeAPI): void {
    this.apiChangeUnsubscribe = api.onChange(this.handleApiChange);
  }

  /**
   * Reattach the binding after Excalidraw remounts its imperative API.
   *
   * The Y.Doc and awareness outlive theme-keyed canvas mounts. Repaint their
   * current projection onto the replacement API so remote changes and
   * collaborator presence do not continue targeting the retired canvas.
   */
  public replaceApi(api: ExcalidrawImperativeAPI): void {
    if (api === this.api) return;
    this.apiChangeUnsubscribe?.();
    this.api = api;
    this.subscribeToApi(api);

    const elements = yjsToExcalidraw(this.yElements).filter(
      (element): element is NonDeletedExcalidrawElement => !element.isDeleted,
    );
    const restored = restoreElements(elements, null, {
      repairBindings: true,
      refreshDimensions: true,
    });
    this.updateRemoteElements(restored);
    api.addFiles(
      [...this.yAssets.keys()].map((key) => this.yAssets.get(key) as BinaryFileData),
    );
    api.updateScene({ collaborators: new Map(this.collaborators) });
  }

  /** Awareness pointer/button update. Mirrors Excalidraw's onPointerUpdate prop. */
  public onPointerUpdate = (payload: {
    pointer: { x: number; y: number; tool: 'pointer' | 'laser' };
    button: 'down' | 'up';
  }): void => {
    if (this.awareness) {
      this.awareness.setLocalStateField('pointer', payload.pointer);
      this.awareness.setLocalStateField('button', payload.button);
    }
  };

  private setupUndoRedo(excalidrawDom: HTMLElement): void {
    if (!this.undoManager) return;

    this.undoManager.addTrackedOrigin(this);
    this.subscriptions.push(() => {
      this.undoManager?.removeTrackedOrigin(this);
    });

    // Hijack Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z to route through Y.UndoManager.
    const _keyPressHandler = (event: KeyboardEvent): void => {
      if (!this.undoManager) return;
      const lower = event.key?.toLocaleLowerCase();
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && lower === 'z') {
        event.stopPropagation();
        this.undoManager.redo();
      } else if ((event.ctrlKey || event.metaKey) && lower === 'z') {
        event.stopPropagation();
        this.undoManager.undo();
      }
    };
    excalidrawDom.addEventListener('keydown', _keyPressHandler, { capture: true });
    this.subscriptions.push(() =>
      excalidrawDom?.removeEventListener('keydown', _keyPressHandler, { capture: true }),
    );

    // Hijack Excalidraw's undo/redo buttons. They are recreated on
    // desktop<->mobile viewport flips, so a ResizeObserver re-attaches as
    // needed.
    let undoButton: HTMLButtonElement | null = null;
    let redoButton: HTMLButtonElement | null = null;

    const _undoBtnHandler = (event: MouseEvent): void => {
      if (!this.undoManager) return;
      event.stopImmediatePropagation();
      this.undoManager.undo();
    };
    const _redoBtnHandler = (event: MouseEvent): void => {
      if (!this.undoManager) return;
      event.stopImmediatePropagation();
      this.undoManager.redo();
    };

    const _rebindButtons = (): void => {
      if (!undoButton || !undoButton.isConnected) {
        undoButton?.removeEventListener('click', _undoBtnHandler);
        undoButton = excalidrawDom.querySelector('[aria-label="Undo"]');
        undoButton?.addEventListener('click', _undoBtnHandler);
      }
      if (!redoButton || !redoButton.isConnected) {
        redoButton?.removeEventListener('click', _redoBtnHandler);
        redoButton = excalidrawDom.querySelector('[aria-label="Redo"]');
        redoButton?.addEventListener('click', _redoBtnHandler);
      }
    };

    const ro = new ResizeObserver(debounce(_rebindButtons, 250));
    ro.observe(excalidrawDom);
    _rebindButtons();

    this.subscriptions.push(() => undoButton?.removeEventListener('click', _undoBtnHandler));
    this.subscriptions.push(() => redoButton?.removeEventListener('click', _redoBtnHandler));
    this.subscriptions.push(() => ro.disconnect());
  }

  /** Push any scene change still waiting in the debounce into the Y.Doc. */
  syncNow(): void {
    this.flushLocalChange.flush();
  }

  destroy(): void {
    this.syncNow();
    for (const s of this.subscriptions) {
      try {
        s();
      } catch (err) {
        console.error('[ExcalidrawBinding] cleanup failed:', err);
      }
    }
    this.subscriptions = [];
    for (const timer of this.remoteElementEchoTimers) clearTimeout(timer);
    this.remoteElementEchoTimers.clear();
    this.pendingRemoteElementEchoes = [];
  }

  private updateRemoteElements(
    elements: readonly NonDeletedExcalidrawElement[],
  ): void {
    const expectedEcho = elements.map(({ id, version }) => ({ id, version }));
    this.pendingRemoteElementEchoes.push(expectedEcho);
    const echoTimer = setTimeout(() => {
      this.remoteElementEchoTimers.delete(echoTimer);
      const index = this.pendingRemoteElementEchoes.indexOf(expectedEcho);
      if (index >= 0) this.pendingRemoteElementEchoes.splice(index, 1);
    }, 1_000);
    this.remoteElementEchoTimers.add(echoTimer);
    this.isApplyingRemoteElements = true;
    try {
      this.api.updateScene({
        elements,
        // Remote/cold-paint updates must not be folded into Excalidraw's next
        // local Store increment. EVENTUALLY (the API default) lets a repaint
        // overwrite a pending local edit before the binding's debounce runs.
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    } catch (error) {
      clearTimeout(echoTimer);
      this.remoteElementEchoTimers.delete(echoTimer);
      const index = this.pendingRemoteElementEchoes.indexOf(expectedEcho);
      if (index >= 0) this.pendingRemoteElementEchoes.splice(index, 1);
      throw error;
    } finally {
      queueMicrotask(() => {
        this.isApplyingRemoteElements = false;
      });
    }
  }

  private consumeRemoteElementsEcho(
    elements: readonly NonDeletedExcalidrawElement[],
  ): boolean {
    const index = this.pendingRemoteElementEchoes.findIndex((expected) =>
      areElementsSame(expected, elements),
    );
    if (index < 0) return false;
    this.pendingRemoteElementEchoes.splice(index, 1);
    return true;
  }

  private _remoteAwarenessChangeHandler = ({
    added,
    updated,
    removed,
  }: {
    added: number[];
    updated: number[];
    removed: number[];
  }): void => {
    if (!this.awareness) return;
    const states = this.awareness.getStates();
    const collaborators = new Map<SocketId, Collaborator>(this.collaborators);
    for (const id of [...added, ...updated]) {
      if (id === this.awareness.clientID) continue;
      const state = states.get(id);
      if (!state) continue;
      collaborators.set(id.toString() as SocketId, this.collaboratorFromAwarenessState(state, id));
    }
    for (const id of removed) {
      collaborators.delete(id.toString() as SocketId);
    }
    this.api.updateScene({ collaborators });
    this.collaborators = collaborators;
  };

  private collaboratorFromAwarenessState(
    state: Record<string, unknown>,
    clientId: number,
  ): Collaborator {
    const user = (state.user ?? {}) as {
      name?: string;
      color?: string;
      avatarUrl?: string;
      state?: 'active' | 'away';
    };
    return {
      pointer: state.pointer as Collaborator['pointer'],
      button: state.button as Collaborator['button'],
      selectedElementIds: state.selectedElementIds as Collaborator['selectedElementIds'],
      username: user.name,
      color: user.color
        ? { background: user.color, stroke: user.color }
        : undefined,
      avatarUrl: user.avatarUrl,
      // Cast: our wire value is the plain string, Excalidraw types it as the
      // UserIdleState enum (same runtime values).
      userState: user.state as unknown as Collaborator['userState'],
      // Excalidraw keys collaborators by socketId at runtime; 0.18 types it as
      // the branded SocketId (a plain string underneath).
      socketId: clientId.toString() as SocketId,
    } as Collaborator;
  }

  /**
   * Regenerate fractional-index ordering keys for all elements. Cheap-ish
   * defensive op when we detect duplicates or non-monotonic positions.
   */
  private ensureValidOrderingKeys(): void {
    const sortedElements = [...this.lastKnownElements].sort(compareOrderedElements);
    const yDoc = this.yElements.doc!;
    const newKeys = generateNKeysBetween(null, null, Math.max(sortedElements.length, 1));
    const newPositions = new Map<string, string>();
    sortedElements.forEach((el, idx) => {
      newPositions.set(el.id, newKeys[idx]);
    });

    yDoc.transact(() => {
      for (let i = 0; i < this.yElements.length; i++) {
        const element = this.yElements.get(i);
        const id = (element.get('el') as { id: string }).id;
        const newPos = newPositions.get(id);
        if (newPos) {
          element.set('pos', newPos);
        }
      }
    }, this);

    this.lastKnownElements = sortedElements.map((el, idx) => ({
      id: el.id,
      version: el.version,
      pos: newKeys[idx],
    }));
  }

  // Reserved for future use -- kept here so the binding API matches the
  // prior Crystal codebase 1:1, easing comparison if we need to debug
  // ordering issues against the older implementation.
  // @ts-expect-error -- unused but intentionally kept.
  private getNewPositionKey(insertAfterPos?: string): string {
    try {
      if (this.lastKnownElements.length === 0 || !insertAfterPos) {
        return generateKeyBetween(null, null);
      }
      const sortedElements = [...this.lastKnownElements].sort(compareOrderedElements);
      const insertIndex = sortedElements.findIndex((el) => el.pos === insertAfterPos);
      if (insertIndex === -1) {
        const lastPos = sortedElements[sortedElements.length - 1]?.pos;
        return generateKeyBetween(lastPos, null);
      }
      if (insertIndex === sortedElements.length - 1) {
        return generateKeyBetween(insertAfterPos, null);
      }
      return generateKeyBetween(insertAfterPos, sortedElements[insertIndex + 1].pos);
    } catch (error) {
      console.error('[ExcalidrawBinding] Error generating position key:', error);
      this.ensureValidOrderingKeys();
      return generateKeyBetween(
        this.lastKnownElements[this.lastKnownElements.length - 1]?.pos || null,
        null,
      );
    }
  }
}
