/**
 * DatamodelLM <-> Y.Doc binding.
 *
 * Wires the Zustand data model store into a shared Y.Doc:
 *
 *   - On construction, the binding REPLACES the local store's content with
 *     the Y.Doc's authoritative state (which may have arrived via sync from
 *     another client OR was just seeded by us). This swaps the file's nanoid
 *     ids for the deterministic stable ids the seed assigns.
 *
 *   - Local store mutations -> Y.Doc: a `store.subscribe` callback diffs the
 *     current state against a kept snapshot and applies entity / relationship
 *     / meta operations inside a single Y.Doc transaction tagged with `this`
 *     so the remote-change observer can ignore them (no feedback loop).
 *
 *   - Y.Doc mutations -> local store: `observeDeep` on entities/relationships
 *     and `observe` on meta. Each observer compares the incoming Y.Doc state
 *     against the local store and applies the minimum set of store actions
 *     (addEntity/updateEntity/deleteEntity, etc.). We DON'T call
 *     `loadFromFile` on every remote change because it resets `selectedEntityId`
 *     and viewport flags -- bad UX while a remote collaborator is editing
 *     someone else's part of the diagram.
 *
 *   - Awareness: publishes `selectedEntityId` and `selectedRelationshipId`
 *     whenever the local selection changes. Other clients can render presence
 *     indicators alongside the standard cursor/avatar.
 *
 *   - Undo: a `Y.UndoManager` tracks only writes tagged with `this`. In collab
 *     mode we install a capture-phase Cmd/Ctrl+Z keyboard handler on the
 *     editor root that routes undo/redo through the manager so a local undo
 *     never clobbers a remote teammate's concurrent edit. In local-only mode
 *     the binding is never constructed, so the editor's native (no-op for
 *     this editor today) undo path remains unchanged.
 *
 * Bootstrap-race safety lives in `seed.ts`; this file deals with the steady
 * state. See COLLABORATION_GUIDE.md for the full architecture.
 */

import * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';
import { COLLAB_INIT_ORIGIN } from '@nimbalyst/extension-sdk';
import type { DataModelStoreApi } from '../store';
import type {
  DataModelFile,
  Database,
  Entity,
  EntityViewMode,
  Field,
  Index,
  Relationship,
} from '../types';
import {
  Y_ENTITIES_KEY,
  Y_META_KEY,
  Y_RELATIONSHIPS_KEY,
} from './seed';

export interface DataModelBindingOptions {
  /**
   * Optional editor root element. When supplied, the binding installs a
   * capture-phase keyboard handler that routes Cmd/Ctrl+Z and
   * Cmd/Ctrl+Shift+Z through Y.UndoManager. Without this the local store has
   * no built-in undo to hijack and undo simply does nothing.
   */
  rootEl?: HTMLElement | null;
}

interface MetaSnapshot {
  database: Database;
  entityViewMode: EntityViewMode;
}

interface Snapshot {
  entities: Map<string, Entity>;
  relationships: Map<string, Relationship>;
  meta: MetaSnapshot;
}

export class DataModelBinding {
  private readonly yDoc: Y.Doc;
  private readonly yEntities: Y.Map<Y.Map<unknown>>;
  private readonly yRelationships: Y.Map<Y.Map<unknown>>;
  private readonly yMeta: Y.Map<unknown>;
  private readonly store: DataModelStoreApi;
  private readonly awareness?: Awareness;
  private readonly undoManager: Y.UndoManager;

  private subscriptions: Array<() => void> = [];

  /** True while we're pushing remote changes into the local store. The
   *  store-subscribe handler early-returns so writes don't echo back. */
  private applyingRemote = false;

  /** Last-known store shape, used to compute local-edit diffs. */
  private snapshot: Snapshot = {
    entities: new Map(),
    relationships: new Map(),
    meta: { database: 'postgres', entityViewMode: 'standard' },
  };

  /** Last-published awareness selection, so we don't re-publish unchanged. */
  private lastSelection: { entityId: string | null; relationshipId: string | null } = {
    entityId: null,
    relationshipId: null,
  };

  constructor(
    yDoc: Y.Doc,
    store: DataModelStoreApi,
    awareness: Awareness | undefined,
    options?: DataModelBindingOptions,
  ) {
    this.yDoc = yDoc;
    this.yEntities = yDoc.getMap<Y.Map<unknown>>(Y_ENTITIES_KEY);
    this.yRelationships = yDoc.getMap<Y.Map<unknown>>(Y_RELATIONSHIPS_KEY);
    this.yMeta = yDoc.getMap<unknown>(Y_META_KEY);
    this.store = store;
    this.awareness = awareness;

    // Y.UndoManager tracks writes tagged with `this`. Remote writes (no
    // tracked origin) are intentionally excluded so undo never reverts a
    // teammate's edit.
    this.undoManager = new Y.UndoManager(
      [this.yEntities, this.yRelationships, this.yMeta],
      { trackedOrigins: new Set([this]) },
    );

    // 1. Push the authoritative Y.Doc state into the local store, replacing
    //    any nanoid ids the parser produced with the deterministic stable
    //    ids the seed assigned. We use `loadFromFile` here (rather than the
    //    incremental add/update/delete used for remote changes after init)
    //    because the editor has just mounted and selections are guaranteed
    //    null -- so the destructive reset is acceptable.
    this.replaceStoreFromYDoc({ initial: true });

    // 2. Local store -> Y.Doc.
    const unsubStore = this.store.subscribe(() => this.handleStoreChange());
    this.subscriptions.push(unsubStore);

    // 3. Y.Doc -> local store.
    const onEntitiesChange = (
      _events: Array<Y.YEvent<Y.AbstractType<unknown>>>,
      txn: Y.Transaction,
    ) => this.handleRemoteChange(txn);
    const onRelationshipsChange = (
      _events: Array<Y.YEvent<Y.AbstractType<unknown>>>,
      txn: Y.Transaction,
    ) => this.handleRemoteChange(txn);
    const onMetaChange = (_event: Y.YMapEvent<unknown>, txn: Y.Transaction) =>
      this.handleRemoteChange(txn);

    this.yEntities.observeDeep(onEntitiesChange);
    this.yRelationships.observeDeep(onRelationshipsChange);
    this.yMeta.observe(onMetaChange);
    this.subscriptions.push(() => this.yEntities.unobserveDeep(onEntitiesChange));
    this.subscriptions.push(() =>
      this.yRelationships.unobserveDeep(onRelationshipsChange),
    );
    this.subscriptions.push(() => this.yMeta.unobserve(onMetaChange));

    // 4. Optional undo/redo keyboard hijack.
    if (options?.rootEl) {
      this.installUndoKeyboard(options.rootEl);
    }
  }

  destroy(): void {
    for (const s of this.subscriptions) {
      try {
        s();
      } catch (err) {
        console.error('[DataModelBinding] cleanup failed:', err);
      }
    }
    this.subscriptions = [];
    this.undoManager.destroy();
  }

  // ==========================================================================
  // Local store -> Y.Doc
  // ==========================================================================

  private handleStoreChange(): void {
    if (this.applyingRemote) return;

    const state = this.store.getState();

    // Awareness: selection changes (cheap, fire even if there's no Y.Doc diff).
    if (this.awareness) {
      if (state.selectedEntityId !== this.lastSelection.entityId) {
        this.awareness.setLocalStateField('selectedEntityId', state.selectedEntityId);
        // Republish editingEntityId in sync so consumers without per-field
        // edit signals still see a presence hint pinned to the selection.
        this.awareness.setLocalStateField('editingEntityId', state.selectedEntityId);
        this.lastSelection.entityId = state.selectedEntityId;
      }
      if (state.selectedRelationshipId !== this.lastSelection.relationshipId) {
        this.awareness.setLocalStateField(
          'selectedRelationshipId',
          state.selectedRelationshipId,
        );
        this.lastSelection.relationshipId = state.selectedRelationshipId;
      }
    }

    // Diff entities, relationships, meta against the snapshot.
    const ops: Array<() => void> = [];

    const currentEntities = new Map(state.entities.map((e) => [e.id, e] as const));
    for (const [id] of this.snapshot.entities) {
      if (!currentEntities.has(id)) {
        ops.push(() => this.yEntities.delete(id));
      }
    }
    for (const [id, entity] of currentEntities) {
      const prev = this.snapshot.entities.get(id);
      if (!prev) {
        ops.push(() => this.writeEntity(entity, undefined));
      } else if (entityFieldsChanged(prev, entity)) {
        ops.push(() => this.writeEntity(entity, prev));
      }
    }

    const currentRels = new Map(state.relationships.map((r) => [r.id, r] as const));
    for (const [id] of this.snapshot.relationships) {
      if (!currentRels.has(id)) {
        ops.push(() => this.yRelationships.delete(id));
      }
    }
    for (const [id, rel] of currentRels) {
      const prev = this.snapshot.relationships.get(id);
      if (!prev) {
        ops.push(() => this.writeRelationship(rel, undefined));
      } else if (relationshipFieldsChanged(prev, rel)) {
        ops.push(() => this.writeRelationship(rel, prev));
      }
    }

    if (this.snapshot.meta.database !== state.database) {
      ops.push(() => this.yMeta.set('database', state.database));
    }
    if (this.snapshot.meta.entityViewMode !== state.entityViewMode) {
      ops.push(() => this.yMeta.set('entityViewMode', state.entityViewMode));
    }

    if (ops.length === 0) return;

    this.yDoc.transact(() => {
      for (const op of ops) op();
    }, this);

    // Refresh the snapshot to mirror what we just wrote.
    this.captureSnapshot(state);
  }

  /** Write or update one entity inside a Y.Map. Caller already runs inside
   *  a transaction tagged with `this`. */
  private writeEntity(entity: Entity, prev: Entity | undefined): void {
    let yEntity = this.yEntities.get(entity.id);
    if (!yEntity) {
      yEntity = new Y.Map<unknown>();
      this.yEntities.set(entity.id, yEntity);
    }
    if (!prev) yEntity.set('id', entity.id);
    if (!prev || prev.name !== entity.name) {
      yEntity.set('name', entity.name);
    }
    if (!prev || prev.description !== entity.description) {
      if (entity.description !== undefined) yEntity.set('description', entity.description);
      else if (yEntity.has('description')) yEntity.delete('description');
    }
    if (!prev || prev.color !== entity.color) {
      if (entity.color !== undefined) yEntity.set('color', entity.color);
      else if (yEntity.has('color')) yEntity.delete('color');
    }
    if (
      !prev ||
      prev.position.x !== entity.position.x ||
      prev.position.y !== entity.position.y
    ) {
      yEntity.set('position', { x: entity.position.x, y: entity.position.y });
    }
    if (!prev || !arraysShallowEqual(prev.fields, entity.fields)) {
      yEntity.set('fields', entity.fields.map((f) => cloneField(f)));
    }
    if (!prev || !arraysShallowEqual(prev.indexes, entity.indexes)) {
      if (entity.indexes && entity.indexes.length > 0) {
        yEntity.set('indexes', entity.indexes.map((i) => cloneIndex(i)));
      } else if (yEntity.has('indexes')) {
        yEntity.delete('indexes');
      }
    }
  }

  private writeRelationship(rel: Relationship, prev: Relationship | undefined): void {
    let yRel = this.yRelationships.get(rel.id);
    if (!yRel) {
      yRel = new Y.Map<unknown>();
      this.yRelationships.set(rel.id, yRel);
    }
    if (!prev) yRel.set('id', rel.id);
    if (!prev || prev.type !== rel.type) yRel.set('type', rel.type);
    if (!prev || prev.sourceEntityName !== rel.sourceEntityName) {
      yRel.set('sourceEntityName', rel.sourceEntityName);
    }
    if (!prev || prev.targetEntityName !== rel.targetEntityName) {
      yRel.set('targetEntityName', rel.targetEntityName);
    }
    setOrDelete(yRel, 'name', prev?.name, rel.name);
    setOrDelete(yRel, 'sourceFieldName', prev?.sourceFieldName, rel.sourceFieldName);
    setOrDelete(yRel, 'targetFieldName', prev?.targetFieldName, rel.targetFieldName);
    setOrDelete(yRel, 'onDelete', prev?.onDelete, rel.onDelete);
    setOrDelete(yRel, 'onUpdate', prev?.onUpdate, rel.onUpdate);
    setOrDelete(yRel, 'implementationType', prev?.implementationType, rel.implementationType);
  }

  // ==========================================================================
  // Y.Doc -> local store
  // ==========================================================================

  private handleRemoteChange(txn: Y.Transaction): void {
    if (txn.origin === this) return;
    if (txn.origin === COLLAB_INIT_ORIGIN) return;
    this.applyYDocStateToStore();
  }

  /**
   * Reconcile the local store against the Y.Doc, applying the minimum set
   * of store actions. Selection state is preserved (we never touch it here).
   */
  private applyYDocStateToStore(): void {
    this.applyingRemote = true;
    const savedDirtyCallback = this.store.getState().onDirtyChange;
    // Temporarily suppress dirty notifications so remote-driven mutations
    // don't visually flag the tab as having unsaved local changes.
    this.store.getState().setCallbacks({ onDirtyChange: undefined });

    try {
      const state = this.store.getState();

      // ENTITIES
      const yEntityIds = new Set<string>();
      for (const id of this.yEntities.keys()) yEntityIds.add(id);
      const localEntityById = new Map(state.entities.map((e) => [e.id, e] as const));

      // Remove entities no longer present.
      for (const id of localEntityById.keys()) {
        if (!yEntityIds.has(id)) {
          this.store.getState().deleteEntity(id);
        }
      }

      // Add new / update changed.
      for (const id of yEntityIds) {
        const yEntity = this.yEntities.get(id);
        if (!yEntity) continue;
        const remote = yMapToEntity(yEntity);
        const local = localEntityById.get(id);
        if (!local) {
          this.store.getState().addEntity({ ...remote, id: remote.id });
        } else if (entityFieldsChanged(local, remote)) {
          this.store.getState().updateEntity(id, {
            name: remote.name,
            description: remote.description,
            color: remote.color,
            position: remote.position,
            fields: remote.fields,
            indexes: remote.indexes,
          });
        }
      }

      // RELATIONSHIPS
      const yRelIds = new Set<string>();
      for (const id of this.yRelationships.keys()) yRelIds.add(id);
      const localRelById = new Map(
        this.store.getState().relationships.map((r) => [r.id, r] as const),
      );

      for (const id of localRelById.keys()) {
        if (!yRelIds.has(id)) {
          this.store.getState().deleteRelationship(id);
        }
      }
      for (const id of yRelIds) {
        const yRel = this.yRelationships.get(id);
        if (!yRel) continue;
        const remote = yMapToRelationship(yRel);
        const local = localRelById.get(id);
        if (!local) {
          this.store.getState().addRelationship({ ...remote, id: remote.id });
        } else if (relationshipFieldsChanged(local, remote)) {
          this.store.getState().updateRelationship(id, remote);
        }
      }

      // META
      const db = this.yMeta.get('database');
      if (typeof db === 'string' && db !== this.store.getState().database) {
        this.store.getState().setDatabase(db as Database);
      }
      const mode = this.yMeta.get('entityViewMode');
      if (typeof mode === 'string' && mode !== this.store.getState().entityViewMode) {
        this.store.getState().setEntityViewMode(mode as EntityViewMode);
      }

      // Re-capture the snapshot from the post-apply store state so the next
      // local diff doesn't re-emit ops for the remote change.
      this.captureSnapshot(this.store.getState());
    } finally {
      this.store.getState().setCallbacks({ onDirtyChange: savedDirtyCallback });
      this.applyingRemote = false;
    }
  }

  /**
   * Wipe and reload the local store from Y.Doc state. Used once at binding
   * setup time; equivalent to "the file just opened, here is its content".
   * Sets `hasCompletedInitialLoad` afterwards so subsequent viewport changes
   * are tracked normally.
   */
  private replaceStoreFromYDoc(opts: { initial: boolean }): void {
    this.applyingRemote = true;
    const savedDirtyCallback = this.store.getState().onDirtyChange;
    this.store.getState().setCallbacks({ onDirtyChange: undefined });
    try {
      const file = this.buildFileFromYDoc();
      this.store.getState().loadFromFile(file);
      this.store.getState().markClean();
      if (opts.initial) {
        this.store.getState().markInitialLoadComplete();
      }
      this.captureSnapshot(this.store.getState());
    } finally {
      this.store.getState().setCallbacks({ onDirtyChange: savedDirtyCallback });
      this.applyingRemote = false;
    }
  }

  private buildFileFromYDoc(): DataModelFile {
    const entities: Entity[] = [];
    for (const id of this.yEntities.keys()) {
      const yEntity = this.yEntities.get(id);
      if (yEntity) entities.push(yMapToEntity(yEntity));
    }

    const relationships: Relationship[] = [];
    for (const id of this.yRelationships.keys()) {
      const yRel = this.yRelationships.get(id);
      if (yRel) relationships.push(yMapToRelationship(yRel));
    }

    const database = (this.yMeta.get('database') as Database) ?? 'postgres';
    const entityViewMode = (this.yMeta.get('entityViewMode') as EntityViewMode) ?? 'standard';

    return {
      version: 1,
      database,
      entities,
      relationships,
      // Viewport stays per-client; pull whatever the store already has.
      viewport: this.store.getState().viewport,
      entityViewMode,
    };
  }

  private captureSnapshot(state: ReturnType<DataModelStoreApi['getState']>): void {
    this.snapshot = {
      entities: new Map(state.entities.map((e) => [e.id, cloneEntity(e)] as const)),
      relationships: new Map(
        state.relationships.map((r) => [r.id, cloneRelationship(r)] as const),
      ),
      meta: { database: state.database, entityViewMode: state.entityViewMode },
    };
  }

  // ==========================================================================
  // Undo / redo
  // ==========================================================================

  private installUndoKeyboard(rootEl: HTMLElement): void {
    const handler = (event: KeyboardEvent) => {
      const lower = event.key?.toLowerCase?.();
      if (!lower) return;
      if (shouldUseNativeTextUndo(event.target)) return;
      // Only intercept in collab mode; the binding wouldn't exist otherwise.
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && lower === 'z') {
        event.stopPropagation();
        event.preventDefault();
        this.undoManager.redo();
      } else if ((event.ctrlKey || event.metaKey) && lower === 'z') {
        event.stopPropagation();
        event.preventDefault();
        this.undoManager.undo();
      } else if ((event.ctrlKey || event.metaKey) && lower === 'y') {
        // Windows redo
        event.stopPropagation();
        event.preventDefault();
        this.undoManager.redo();
      }
    };
    rootEl.addEventListener('keydown', handler, { capture: true });
    this.subscriptions.push(() =>
      rootEl.removeEventListener('keydown', handler, { capture: true } as EventListenerOptions),
    );
  }
}

// ============================================================================
// Helpers
// ============================================================================

function cloneField(f: Field): Field {
  const next: Field = { ...f };
  if (f.embeddedSchema) {
    next.embeddedSchema = f.embeddedSchema.map(cloneField);
  }
  return next;
}

function cloneIndex(i: Index): Index {
  return { ...i, fields: i.fields.map((f) => ({ ...f })) };
}

function cloneEntity(e: Entity): Entity {
  return {
    ...e,
    position: { ...e.position },
    fields: e.fields.map(cloneField),
    indexes: e.indexes ? e.indexes.map(cloneIndex) : undefined,
  };
}

function cloneRelationship(r: Relationship): Relationship {
  return { ...r };
}

function setOrDelete<T>(
  yMap: Y.Map<unknown>,
  key: string,
  prev: T | undefined,
  next: T | undefined,
): void {
  if (prev === next) return;
  if (next === undefined) {
    if (yMap.has(key)) yMap.delete(key);
  } else {
    yMap.set(key, next as unknown);
  }
}

function arraysShallowEqual<T>(a: T[] | undefined, b: T[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function shouldUseNativeTextUndo(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const editableAncestor = target.closest('input, textarea, [contenteditable]');
  if (!(editableAncestor instanceof HTMLElement)) return false;
  if (editableAncestor instanceof HTMLTextAreaElement) return true;
  if (editableAncestor instanceof HTMLInputElement) {
    const type = editableAncestor.type.toLowerCase();
    return !['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(type);
  }
  return editableAncestor.isContentEditable;
}

function entityFieldsChanged(a: Entity, b: Entity): boolean {
  return (
    a.name !== b.name ||
    a.description !== b.description ||
    a.color !== b.color ||
    a.position.x !== b.position.x ||
    a.position.y !== b.position.y ||
    !arraysShallowEqual(a.fields, b.fields) ||
    !arraysShallowEqual(a.indexes, b.indexes)
  );
}

function relationshipFieldsChanged(a: Relationship, b: Relationship): boolean {
  return (
    a.type !== b.type ||
    a.name !== b.name ||
    a.sourceEntityName !== b.sourceEntityName ||
    a.targetEntityName !== b.targetEntityName ||
    a.sourceFieldName !== b.sourceFieldName ||
    a.targetFieldName !== b.targetFieldName ||
    a.onDelete !== b.onDelete ||
    a.onUpdate !== b.onUpdate ||
    a.implementationType !== b.implementationType
  );
}

export function yMapToEntity(yEntity: Y.Map<unknown>): Entity {
  const id = (yEntity.get('id') as string) ?? '';
  const name = (yEntity.get('name') as string) ?? '';
  const description = yEntity.get('description') as string | undefined;
  const color = yEntity.get('color') as string | undefined;
  const position = (yEntity.get('position') as { x: number; y: number } | undefined) ?? { x: 0, y: 0 };
  const fields = ((yEntity.get('fields') as Field[]) ?? []).map(cloneField);
  const indexes = yEntity.get('indexes') as Index[] | undefined;
  return {
    id,
    name,
    description,
    color,
    position: { x: position.x, y: position.y },
    fields,
    indexes: indexes ? indexes.map(cloneIndex) : undefined,
  };
}

export function yMapToRelationship(yRel: Y.Map<unknown>): Relationship {
  return {
    id: (yRel.get('id') as string) ?? '',
    type: yRel.get('type') as Relationship['type'],
    sourceEntityName: (yRel.get('sourceEntityName') as string) ?? '',
    targetEntityName: (yRel.get('targetEntityName') as string) ?? '',
    name: yRel.get('name') as string | undefined,
    sourceFieldName: yRel.get('sourceFieldName') as string | undefined,
    targetFieldName: yRel.get('targetFieldName') as string | undefined,
    onDelete: yRel.get('onDelete') as Relationship['onDelete'],
    onUpdate: yRel.get('onUpdate') as Relationship['onUpdate'],
    implementationType: yRel.get('implementationType') as Relationship['implementationType'],
  };
}
