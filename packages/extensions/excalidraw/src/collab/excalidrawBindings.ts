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
  BinaryFileData,
  Collaborator,
  ExcalidrawImperativeAPI,
  SocketId,
} from '@excalidraw/excalidraw/types';
import type * as awarenessProtocol from 'y-protocols/awareness';
import * as Y from 'yjs';
import { restoreElements } from '@excalidraw/excalidraw';
import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';
import {
  areElementsSame,
  debounce,
  yjsToExcalidraw,
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

    // Local edits -> Y.Doc (debounced 50ms).
    this.subscriptions.push(
      this.api.onChange(
        debounce((_elements, state, files) => {
          const elements = this.api.getSceneElements();
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
                const currentElements = this.api.getSceneElements();
                const newKeys = generateNKeysBetween(null, null, currentElements.length);
                const yDoc = this.yElements.doc!;
                yDoc.transact(() => {
                  this.yElements.delete(0, this.yElements.length);
                  currentElements.forEach((el, idx) => {
                    const yElement = new Y.Map<unknown>();
                    yElement.set('el', el);
                    yElement.set('pos', newKeys[idx]);
                    this.yElements.push([yElement]);
                  });
                }, this);
                this.lastKnownElements = currentElements.map((el, idx) => ({
                  id: el.id,
                  version: el.version,
                  pos: newKeys[idx],
                }));
              } catch (err) {
                console.error('[ExcalidrawBinding] Failed to recover with full refresh:', err);
              }
            }
          }

          const res = getDeltaOperationsForAssets(this.lastKnownFileIds, files);
          this.lastKnownFileIds = res.lastKnownFileIds;
          if (res.operations.length > 0) {
            applyAssetOperations(this.yAssets, res.operations, this);
          }

          if (this.awareness) {
            this.awareness.setLocalStateField(
              'selectedElementIds',
              state.selectedElementIds,
            );
          }
        }, 50),
      ),
    );

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

      // Defensive dedupe: bootstrap-race CRDT merges can in rare cases land
      // duplicate IDs in the array. Drop later occurrences in a transaction
      // and bail; the next event cycle picks up the cleaned state.
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
        const firstOccurrences = new Map<string, number>();
        const yDoc = this.yElements.doc!;
        yDoc.transact(() => {
          for (let i = this.yElements.length - 1; i >= 0; i--) {
            const item = this.yElements.get(i);
            const id = (item.get('el') as { id: string }).id;
            if (duplicateIds.has(id)) {
              if (firstOccurrences.has(id)) {
                this.yElements.delete(i, 1);
              } else {
                firstOccurrences.set(id, i);
              }
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
          .sort((a, b) => (a.pos > b.pos ? 1 : a.pos < b.pos ? -1 : 0));
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
          .sort((a, b) => (a.pos > b.pos ? 1 : a.pos < b.pos ? -1 : 0));

        let hasOrderingIssue = false;
        for (let i = 1; i < this.lastKnownElements.length; i++) {
          if (this.lastKnownElements[i].pos <= this.lastKnownElements[i - 1].pos) {
            hasOrderingIssue = true;
            break;
          }
        }
        if (hasOrderingIssue) {
          console.warn('[ExcalidrawBinding] Ordering issue detected in remote changes, fixing...');
          this.ensureValidOrderingKeys();
          const reorderedElements = yjsToExcalidraw(this.yElements);
          this.api.updateScene({ elements: reorderedElements });
          return;
        }

        this.api.updateScene({ elements });
      } catch (error) {
        console.error('[ExcalidrawBinding] Error in remote elements handler:', error);
        this.ensureValidOrderingKeys();
        const fallbackElements = yjsToExcalidraw(this.yElements);
        this.api.updateScene({ elements: fallbackElements });
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
      .sort((a, b) => (a.pos > b.pos ? 1 : a.pos < b.pos ? -1 : 0));
    this.ensureValidOrderingKeys();

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
      this.api.updateScene({ elements: normalised });

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
        .sort((a, b) => (a.pos > b.pos ? 1 : a.pos < b.pos ? -1 : 0));

      // Fit content on initial mount.
      setTimeout(() => {
        this.api.scrollToContent(undefined, {
          animate: false,
          fitToContent: true,
        });
      }, 10);
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

  destroy(): void {
    for (const s of this.subscriptions) {
      try {
        s();
      } catch (err) {
        console.error('[ExcalidrawBinding] cleanup failed:', err);
      }
    }
    this.subscriptions = [];
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
    const sortedElements = [...this.lastKnownElements].sort((a, b) =>
      a.pos > b.pos ? 1 : a.pos < b.pos ? -1 : 0,
    );
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
      const sortedElements = [...this.lastKnownElements].sort((a, b) =>
        a.pos > b.pos ? 1 : a.pos < b.pos ? -1 : 0,
      );
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
