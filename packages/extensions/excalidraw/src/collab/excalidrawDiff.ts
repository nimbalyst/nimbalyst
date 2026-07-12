/**
 * Excalidraw / Y.Doc diff and operation application.
 *
 * Ported from the prior Crystal codebase. The element store on the Y.Doc is
 * `Y.Array<Y.Map<{ el: ExcalidrawElement; pos: string }>>`. Element ordering
 * is driven by the fractional-index string `pos`, not by Y.Array position --
 * the array is treated as an unordered bag. This avoids the lack of a move
 * operation on Y.Array (see https://discuss.yjs.dev/t/moving-elements-in-lists/92/15)
 * and the per-element memory cost of using a top-level Y.Map.
 *
 * Assets (image blobs) live in a separate `Y.Map<BinaryFileData>` keyed by
 * file id; assets are append/delete only and never updated.
 */

import type {
  ExcalidrawElement,
  NonDeletedExcalidrawElement,
} from '@excalidraw/excalidraw/types/element/types';
import type { BinaryFileData, BinaryFiles } from '@excalidraw/excalidraw/types/types';
import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';
import * as Y from 'yjs';
import { moveArrayItem } from './excalidrawHelpers';
import type { ExcalidrawBinding } from './excalidrawBindings';

export type UpdateOperation = {
  type: 'update';
  id: string;
  index: number;
  element: ExcalidrawElement;
};
export type AppendOperation = {
  type: 'append';
  id: string;
  pos: string;
  element: ExcalidrawElement;
};
export type DeleteOperation = { type: 'delete'; id: string; index: number };
export type MoveOperation = {
  type: 'move';
  id: string;
  fromIndex: number;
  toIndex: number;
  pos: string;
};
export type BulkAppendOperation = {
  type: 'bulkAppend';
  data: { id: string; pos: string; element: ExcalidrawElement }[];
};
export type BulkDeleteOperation = {
  type: 'bulkDelete';
  id: string;
  index: number;
  data: { id: string; index: number }[];
};

export type Operation =
  | UpdateOperation
  | AppendOperation
  | DeleteOperation
  | MoveOperation
  | BulkAppendOperation
  | BulkDeleteOperation;

type OperationTracker = {
  elementIds: string[];
  idMap: {
    [id: string]: { id: string; version: number; pos: string; index: number };
  };
};

export type LastKnownOrderedElement = { id: string; version: number; pos: string };

export const getDeltaOperationsForElements = (
  lastKnownElements: LastKnownOrderedElement[],
  newElements: readonly NonDeletedExcalidrawElement[],
  bulkify = true,
): { operations: Operation[]; lastKnownElements: LastKnownOrderedElement[] } => {
  const updateOperations: UpdateOperation[] = [];
  const appendOperations: AppendOperation[] = [];
  const deleteOperations: DeleteOperation[] = [];
  const moveOperations: MoveOperation[] = [];

  const opsTracker: OperationTracker = {
    elementIds: lastKnownElements.map((x) => x.id),
    idMap: lastKnownElements.reduce(
      (map: OperationTracker['idMap'], data, index) => {
        map[data.id] = { id: data.id, version: data.version, pos: data.pos, index };
        return map;
      },
      {},
    ),
  };

  const _updateIdIndexLookup = (): void => {
    opsTracker.idMap = opsTracker.elementIds.reduce(
      (map: OperationTracker['idMap'], id, index) => {
        map[id] = { ...opsTracker.idMap[id], index };
        return map;
      },
      {},
    );
  };

  for (const newElement of newElements) {
    let oldIndex: number | null = null;
    let oldElement: LastKnownOrderedElement | null = null;
    if (opsTracker.idMap[newElement.id]) {
      const { index, ...rest } = opsTracker.idMap[newElement.id];
      oldIndex = index;
      oldElement = rest;
    }
    if (!oldElement) {
      const op = {
        id: newElement.id,
        version: newElement.version,
        pos: !bulkify
          ? generateKeyBetween(
              opsTracker.idMap[opsTracker.elementIds[opsTracker.elementIds.length - 1]]?.pos ?? null,
              null,
            )
          : '',
        index: opsTracker.elementIds.length,
      };
      opsTracker.elementIds.push(op.id);
      opsTracker.idMap[op.id] = op;
      appendOperations.push({
        type: 'append',
        id: newElement.id,
        pos: op.pos,
        element: newElement,
      });
    } else if (oldElement && newElement.version !== oldElement.version) {
      const op = {
        id: newElement.id,
        version: newElement.version,
        pos: oldElement.pos,
        index: oldIndex!,
      };
      opsTracker.idMap[newElement.id] = op;
      updateOperations.push({
        type: 'update',
        id: op.id,
        index: op.index,
        element: newElement,
      });
    }
  }

  const newElementIds = new Set(newElements.map((x) => x.id));
  const newOpsTrackerElementIds: string[] = [];
  let runningIndex = 0;
  for (const id of opsTracker.elementIds) {
    if (!newElementIds.has(id)) {
      deleteOperations.push({ type: 'delete', index: runningIndex, id });
    } else {
      newOpsTrackerElementIds.push(id);
      runningIndex += 1;
    }
  }
  if (deleteOperations.length > 0) {
    opsTracker.elementIds = newOpsTrackerElementIds;
    _updateIdIndexLookup();
  }

  for (let toIndex = 0; toIndex < newElements.length; toIndex++) {
    const id = newElements[toIndex].id;
    const { index: fromIndex } = opsTracker.idMap[id];

    if (toIndex !== fromIndex) {
      let leftSortIndex: string | null = null;
      let rightSortIndex: string | null = null;
      if (fromIndex >= 0 && fromIndex < toIndex) {
        leftSortIndex = opsTracker.idMap[opsTracker.elementIds[toIndex]]?.pos ?? null;
        rightSortIndex = opsTracker.idMap[opsTracker.elementIds[toIndex + 1]]?.pos ?? null;
      } else {
        leftSortIndex = opsTracker.idMap[opsTracker.elementIds[toIndex - 1]]?.pos ?? null;
        rightSortIndex = opsTracker.idMap[opsTracker.elementIds[toIndex]]?.pos ?? null;
      }

      const newSortIndex = generateKeyBetween(leftSortIndex, rightSortIndex);

      opsTracker.elementIds = moveArrayItem(opsTracker.elementIds, fromIndex, toIndex, true);
      opsTracker.idMap[id].pos = newSortIndex;
      _updateIdIndexLookup();
      moveOperations.push({ type: 'move', id, fromIndex, toIndex, pos: newSortIndex });
    }
  }

  const bulkAppendOperations: BulkAppendOperation[] = [];
  const bulkDeleteOperations: BulkDeleteOperation[] = [];
  if (bulkify) {
    if (appendOperations.length > 0) {
      const sortIndexes = generateNKeysBetween(
        lastKnownElements[lastKnownElements.length - 1]?.pos ?? null,
        null,
        appendOperations.length,
      );
      for (let i = 0; i < appendOperations.length; i++) {
        opsTracker.idMap[appendOperations[i].id].pos = sortIndexes[i];
      }
      bulkAppendOperations.push({
        type: 'bulkAppend',
        data: appendOperations.map((op, i) => ({
          id: op.id,
          pos: sortIndexes[i],
          element: op.element,
        })),
      });
    }

    let lastIndex: number | null = null;
    for (const op of deleteOperations) {
      if (lastIndex === null || op.index > lastIndex) {
        bulkDeleteOperations.push({
          type: 'bulkDelete',
          index: op.index,
          id: op.id,
          data: [{ id: op.id, index: op.index }],
        });
        lastIndex = op.index;
      } else {
        bulkDeleteOperations[bulkDeleteOperations.length - 1].data.push({
          id: op.id,
          index: op.index,
        });
      }
    }
  }

  const operations: Operation[] = !bulkify
    ? [...updateOperations, ...appendOperations, ...deleteOperations, ...moveOperations]
    : [...updateOperations, ...bulkAppendOperations, ...bulkDeleteOperations, ...moveOperations];

  const updatedLastKnownElements = opsTracker.elementIds.map((x) => {
    const { index: _index, ...rest } = opsTracker.idMap[x];
    return rest;
  });

  return { operations, lastKnownElements: updatedLastKnownElements };
};

export type AssetAppendOperation = { type: 'append'; id: string; asset: BinaryFileData };
export type AssetDeleteOperation = { type: 'delete'; id: string };
export type AssetOperation = AssetAppendOperation | AssetDeleteOperation;

export const getDeltaOperationsForAssets = (
  lastKnownFileIds: Set<string>,
  files: BinaryFiles,
): { operations: AssetOperation[]; lastKnownFileIds: Set<string> } => {
  const operations: AssetOperation[] = [];
  const newFields = new Set<string>();

  for (const fileId in files) {
    if (!Object.prototype.hasOwnProperty.call(files, fileId)) continue;
    newFields.add(fileId);
    if (!lastKnownFileIds.has(fileId)) {
      operations.push({ type: 'append', id: fileId, asset: files[fileId] });
    }
  }

  // Note: the original code had a `for (let fileId in lastKnownFileIds)` here
  // which is a bug (iterating a Set with for-in only yields nothing). Asset
  // deletes are intentionally not detected -- Excalidraw never deletes assets
  // when the referencing element is removed, so we keep the same behaviour.

  return { operations, lastKnownFileIds: newFields };
};

export const applyElementOperations = (
  yElements: Y.Array<Y.Map<unknown>>,
  operations: Operation[],
  origin: ExcalidrawBinding,
): void => {
  yElements.doc!.transact(() => {
    const idYjsIndexMap: { [key: string]: number } = {};
    const _updateYjsIndexMap = (): void => {
      for (let i = 0; i < yElements.length; i++) {
        const item = yElements.get(i).get('el') as ExcalidrawElement;
        idYjsIndexMap[item.id] = i;
      }
    };
    _updateYjsIndexMap();

    for (const op of operations) {
      switch (op.type) {
        case 'update': {
          yElements.get(idYjsIndexMap[op.id]).set('el', { ...op.element });
          break;
        }
        case 'append': {
          idYjsIndexMap[op.id] = yElements.length;
          yElements.push([
            new Y.Map<unknown>(
              Object.entries({ pos: op.pos, el: { ...op.element } }),
            ),
          ]);
          break;
        }
        case 'bulkAppend': {
          for (let i = 0; i < op.data.length; i++) {
            idYjsIndexMap[op.data[i].id] = yElements.length + i;
          }
          yElements.push(
            op.data.map(
              (x) =>
                new Y.Map<unknown>(
                  Object.entries({ pos: x.pos, el: { ...x.element } }),
                ),
            ),
          );
          break;
        }
        case 'delete': {
          yElements.delete(idYjsIndexMap[op.id], 1);
          _updateYjsIndexMap();
          break;
        }
        case 'bulkDelete': {
          yElements.delete(idYjsIndexMap[op.id], op.data.length);
          _updateYjsIndexMap();
          break;
        }
        case 'move': {
          yElements.get(idYjsIndexMap[op.id]).set('pos', op.pos);
          break;
        }
      }
    }
  }, origin);
};

export const applyAssetOperations = (
  yAssets: Y.Map<unknown>,
  operations: AssetOperation[],
  origin?: ExcalidrawBinding,
): void => {
  yAssets.doc!.transact(() => {
    for (const op of operations) {
      switch (op.type) {
        case 'append': {
          yAssets.set(op.id, op.asset);
          break;
        }
        case 'delete': {
          yAssets.delete(op.id);
          break;
        }
      }
    }
  }, origin);
};
