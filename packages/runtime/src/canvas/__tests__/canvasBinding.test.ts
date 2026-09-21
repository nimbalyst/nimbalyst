// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';

import {
  NIMBALYST_CANVAS_NAMESPACE,
  serializeCanvasDocument,
  type CanvasAnyNode,
  type CanvasDocument,
} from '../CanvasDocument';
import { CanvasBinding } from '../canvasBinding';
import { canvasCollabCodec } from '../canvasCollabCodec';
import { CANVAS_NODE_RANK_FIELD } from '../canvasRank';
import {
  addCanvasNode,
  applyCanvasEdgeChanges,
  applyCanvasNodeChanges,
  connectCanvasEdge,
  reorderCanvasNode,
} from '../canvasFlowMapping';

function node(
  id: string,
  overrides: Partial<CanvasAnyNode> = {}
): CanvasAnyNode {
  return {
    id,
    type: 'text',
    x: 0,
    y: 0,
    width: 200,
    height: 100,
    text: id,
    ...overrides,
  } as CanvasAnyNode;
}

function board(): CanvasDocument {
  return {
    nodes: [node('bottom'), node('top', { x: 300 })],
    edges: [],
    [NIMBALYST_CANVAS_NAMESPACE]: {
      version: 1,
      meta: { name: 'Shared canvas' },
    },
  };
}

function exchange(left: Y.Doc, right: Y.Doc): void {
  const leftUpdate = Y.encodeStateAsUpdate(left, Y.encodeStateVector(right));
  const rightUpdate = Y.encodeStateAsUpdate(right, Y.encodeStateVector(left));
  Y.applyUpdate(left, rightUpdate, 'peer');
  Y.applyUpdate(right, leftUpdate, 'peer');
}

function snapshot(binding: CanvasBinding): CanvasDocument {
  return binding.getDocument();
}

function withoutRanks(document: CanvasDocument): CanvasDocument {
  return {
    ...document,
    nodes: (document.nodes ?? []).map((entry) => {
      const copy = { ...entry };
      delete copy[CANVAS_NODE_RANK_FIELD];
      return copy;
    }),
  };
}

describe('CanvasBinding', () => {
  it('merges lock, group, and namespace edits independently and undoes only local fields', () => {
    const leftDoc = new Y.Doc();
    const rightDoc = new Y.Doc();
    const original = { nodes: [node('a', { 'x-nimbalyst': { label: 'Original', future: { keep: true } } })], edges: [] };
    canvasCollabCodec.seedFromFile(leftDoc, serializeCanvasDocument(original));
    Y.applyUpdate(rightDoc, Y.encodeStateAsUpdate(leftDoc));
    const left = new CanvasBinding(leftDoc, { enableUndoManager: true });
    const right = new CanvasBinding(rightDoc);
    const before = left.getDocument();
    const change = (base: CanvasDocument, extension: Record<string, unknown>) => ({ ...base, nodes: base.nodes!.map(n => ({ ...n, 'x-nimbalyst': { ...n['x-nimbalyst'], ...extension } })) });
    left.applyLocalDocument(before, change(before, { locked: true }));
    const remote = right.getDocument();
    right.applyLocalDocument(remote, change(remote, { group: 'group-a', label: 'Remote' }));
    exchange(leftDoc, rightDoc);
    expect(left.getDocument()).toEqual(right.getDocument());
    expect(left.getDocument().nodes![0]['x-nimbalyst']).toEqual({ label: 'Remote', future: { keep: true }, locked: true, group: 'group-a' });
    expect(left.undo()).toBe(true);
    exchange(leftDoc, rightDoc);
    expect(left.getDocument().nodes![0]['x-nimbalyst']).toEqual({ label: 'Remote', future: { keep: true }, group: 'group-a' });
    const exported = canvasCollabCodec.exportToFile(leftDoc);
    const reloaded = new Y.Doc();
    canvasCollabCodec.seedFromFile(reloaded, exported as string);
    expect(canvasCollabCodec.exportToFile(reloaded)).toEqual(exported);
    left.destroy(); right.destroy(); leftDoc.destroy(); rightDoc.destroy(); reloaded.destroy();
  });

  it('converges simultaneous content-derived seeds and per-field edits from two bindings', () => {
    const source = serializeCanvasDocument(board());
    const leftDoc = new Y.Doc();
    const rightDoc = new Y.Doc();
    canvasCollabCodec.seedFromFile(leftDoc, source);
    canvasCollabCodec.seedFromFile(rightDoc, source);
    exchange(leftDoc, rightDoc);

    const left = new CanvasBinding(leftDoc);
    const right = new CanvasBinding(rightDoc);
    const leftBase = snapshot(left);
    const rightBase = snapshot(right);
    left.applyLocalDocument(leftBase, {
      ...leftBase,
      nodes: leftBase.nodes!.map((entry) =>
        entry.id === 'bottom' ? { ...entry, x: 40 } : entry
      ),
    });
    right.applyLocalDocument(rightBase, {
      ...rightBase,
      nodes: rightBase.nodes!.map((entry) =>
        entry.id === 'bottom' ? { ...entry, text: 'edited remotely' } : entry
      ),
    });

    exchange(leftDoc, rightDoc);
    expect(snapshot(left)).toEqual(snapshot(right));
    expect(
      snapshot(left).nodes?.find((entry) => entry.id === 'bottom')
    ).toMatchObject({
      x: 40,
      text: 'edited remotely',
    });
  });

  it('settles concurrent inserts at the same rank position deterministically', () => {
    const source = serializeCanvasDocument(board());
    const leftDoc = new Y.Doc();
    canvasCollabCodec.seedFromFile(leftDoc, source);
    const rightDoc = new Y.Doc();
    Y.applyUpdate(rightDoc, Y.encodeStateAsUpdate(leftDoc), 'peer');

    const left = new CanvasBinding(leftDoc);
    const right = new CanvasBinding(rightDoc);
    const leftBase = snapshot(left);
    const rightBase = snapshot(right);
    left.applyLocalDocument(leftBase, {
      ...leftBase,
      nodes: [leftBase.nodes![0], node('insert-a'), leftBase.nodes![1]],
    });
    right.applyLocalDocument(rightBase, {
      ...rightBase,
      nodes: [rightBase.nodes![0], node('insert-b'), rightBase.nodes![1]],
    });

    exchange(leftDoc, rightDoc);
    const leftIds = snapshot(left).nodes?.map((entry) => entry.id);
    const rightIds = snapshot(right).nodes?.map((entry) => entry.id);
    expect(leftIds).toEqual(rightIds);
    expect(leftIds).toEqual(['bottom', 'insert-a', 'insert-b', 'top']);
  });

  it('undoes only this binding origin and preserves a teammate edit', () => {
    const leftDoc = new Y.Doc();
    canvasCollabCodec.seedFromFile(leftDoc, serializeCanvasDocument(board()));
    const rightDoc = new Y.Doc();
    Y.applyUpdate(rightDoc, Y.encodeStateAsUpdate(leftDoc), 'peer');
    const left = new CanvasBinding(leftDoc, { enableUndoManager: true });
    const right = new CanvasBinding(rightDoc);

    const leftBase = snapshot(left);
    left.applyLocalDocument(leftBase, {
      ...leftBase,
      nodes: leftBase.nodes!.map((entry) =>
        entry.id === 'bottom' ? { ...entry, x: 80 } : entry
      ),
    });
    exchange(leftDoc, rightDoc);
    const rightBase = snapshot(right);
    right.applyLocalDocument(rightBase, {
      ...rightBase,
      nodes: rightBase.nodes!.map((entry) =>
        entry.id === 'bottom' ? { ...entry, text: 'teammate edit' } : entry
      ),
    });
    exchange(leftDoc, rightDoc);

    left.undo();
    exchange(leftDoc, rightDoc);
    expect(snapshot(left)).toEqual(snapshot(right));
    expect(
      snapshot(left).nodes?.find((entry) => entry.id === 'bottom')
    ).toMatchObject({
      x: 0,
      text: 'teammate edit',
    });
  });

  it('does not echo a stale React projection over applyFromFile changes', () => {
    const yDoc = new Y.Doc();
    canvasCollabCodec.seedFromFile(yDoc, serializeCanvasDocument(board()));
    const binding = new CanvasBinding(yDoc);
    const renderedBeforeRemote = snapshot(binding);

    const fromFile = board();
    fromFile.nodes![0] = { ...fromFile.nodes![0], y: 75, text: 'from file' };
    canvasCollabCodec.applyFromFile(yDoc, serializeCanvasDocument(fromFile));

    // This is the dangerous one-tick window: React still rendered the old
    // object, and a pointer edit is computed from that stale projection. The
    // binding must apply only the x delta, not mirror the stale y/text fields.
    binding.applyLocalDocument(renderedBeforeRemote, {
      ...renderedBeforeRemote,
      nodes: renderedBeforeRemote.nodes!.map((entry) =>
        entry.id === 'bottom' ? { ...entry, x: 125 } : entry
      ),
    });

    expect(
      snapshot(binding).nodes?.find((entry) => entry.id === 'bottom')
    ).toMatchObject({
      x: 125,
      y: 75,
      text: 'from file',
    });
  });

  it('undoes board structure operations, one gesture at a time', () => {
    const edge = {
      id: 'edge-existing',
      fromNode: 'bottom',
      toNode: 'top',
      toEnd: 'arrow' as const,
    };
    const cases: Array<{
      name: string;
      initial?: CanvasDocument;
      change(document: CanvasDocument): CanvasDocument;
    }> = [
      {
        name: 'move',
        change: (document) =>
          applyCanvasNodeChanges(document, [
            { id: 'bottom', type: 'position', position: { x: 65, y: 45 } },
          ]),
      },
      {
        name: 'resize',
        change: (document) =>
          applyCanvasNodeChanges(document, [
            {
              id: 'bottom',
              type: 'dimensions',
              dimensions: { width: 280, height: 160 },
              resizing: true,
            },
          ]),
      },
      {
        name: 'add card',
        change: (document) => addCanvasNode(document, node('added')),
      },
      {
        name: 'delete card',
        change: (document) =>
          applyCanvasNodeChanges(document, [{ id: 'bottom', type: 'remove' }]),
      },
      {
        name: 'add edge',
        change: (document) =>
          connectCanvasEdge(document, {
            source: 'bottom',
            target: 'top',
            sourceHandle: null,
            targetHandle: null,
          }),
      },
      {
        name: 'delete edge',
        initial: { ...board(), edges: [edge] },
        change: (document) =>
          applyCanvasEdgeChanges(document, [{ id: edge.id, type: 'remove' }]),
      },
      {
        name: 'z-order',
        change: (document) => reorderCanvasNode(document, 'bottom', 'front'),
      },
    ];

    for (const operation of cases) {
      const yDoc = new Y.Doc();
      canvasCollabCodec.seedFromFile(
        yDoc,
        serializeCanvasDocument(operation.initial ?? board())
      );
      const binding = new CanvasBinding(yDoc, { enableUndoManager: true });
      const before = snapshot(binding);
      const after = operation.change(before);
      binding.applyLocalDocument(before, after);
      expect(snapshot(binding), operation.name).not.toEqual(before);
      expect(binding.undo(), operation.name).toBe(true);
      expect(snapshot(binding), operation.name).toEqual(before);
      expect(binding.redo(), operation.name).toBe(true);
      expect(withoutRanks(snapshot(binding)), operation.name).toEqual(
        withoutRanks(after)
      );
      binding.destroy();
      yDoc.destroy();
    }

    // Two gestures inside `Y.UndoManager`'s 500ms capture window merge into one
    // undo step unless the boundary between them is declared. Dragging one card
    // and then dragging another is two gestures and must be two undos.
    const yDoc = new Y.Doc();
    canvasCollabCodec.seedFromFile(yDoc, serializeCanvasDocument(board()));
    const binding = new CanvasBinding(yDoc, { enableUndoManager: true });
    const start = snapshot(binding);
    const movedBottom = applyCanvasNodeChanges(start, [
      { id: 'bottom', type: 'position', position: { x: 65, y: 45 } },
    ]);
    binding.applyLocalDocument(start, movedBottom);
    binding.stopCapturing();
    const movedTop = applyCanvasNodeChanges(movedBottom, [
      { id: 'top', type: 'position', position: { x: 520, y: 90 } },
    ]);
    binding.applyLocalDocument(movedBottom, movedTop);

    expect(binding.undo()).toBe(true);
    expect(snapshot(binding)).toEqual(movedBottom);
    expect(binding.undo()).toBe(true);
    expect(snapshot(binding)).toEqual(start);
  });
});

/**
 * Presence must carry information or not be sent.
 *
 * `Awareness.setLocalStateField` emits an `update` whether or not the value
 * moved, and every peer in the room decodes and re-renders for it. The callers
 * here are React effects that re-run for reasons that have nothing to do with
 * presence -- a projection identity changing, a card being typed into, a drag
 * frame republishing the same selection -- so without an equality guard at the
 * binding, ordinary document work turns into a stream of presence packets that
 * say nothing. Nothing on screen shows this; it only shows on the wire.
 */
describe('awareness publishing', () => {
  function awarenessHarness() {
    const yDoc = new Y.Doc();
    canvasCollabCodec.seedFromFile(yDoc, serializeCanvasDocument(board()));
    const awareness = new Awareness(yDoc);
    let updates = 0;
    awareness.on('update', () => {
      updates += 1;
    });
    const binding = new CanvasBinding(yDoc, { awareness });
    return {
      binding,
      updates: () => updates,
      destroy: () => {
        binding.destroy();
        awareness.destroy();
        yDoc.destroy();
      },
    };
  }

  it('does not broadcast a state that has not changed', () => {
    const test = awarenessHarness();

    test.binding.setAwareness({ selectedNodeId: 'top' });
    expect(test.updates()).toBe(1);

    // The selection effect re-running because the node array got a new identity.
    test.binding.setAwareness({ selectedNodeId: 'top' });
    test.binding.setAwareness({ selectedNodeId: 'top' });
    expect(test.updates()).toBe(1);

    test.binding.setAwareness({ cursor: { x: 10, y: 20 } });
    expect(test.updates()).toBe(2);
    // A new object each frame, same point: the pointer has not moved.
    test.binding.setAwareness({ cursor: { x: 10, y: 20 } });
    expect(test.updates()).toBe(2);

    // A drag frame that lands on the position the last one already published.
    const moving = [{ nodeId: 'top', x: 40, y: 40, width: 80, height: 40 }];
    test.binding.setAwareness({ moving });
    expect(test.updates()).toBe(3);
    test.binding.setAwareness({
      moving: [{ nodeId: 'top', x: 40, y: 40, width: 80, height: 40 }],
    });
    expect(test.updates()).toBe(3);

    // Real movement still goes out, and clearing it goes out once.
    test.binding.setAwareness({
      moving: [{ nodeId: 'top', x: 60, y: 40, width: 80, height: 40 }],
    });
    expect(test.updates()).toBe(4);
    test.binding.setAwareness({ moving: null });
    expect(test.updates()).toBe(5);
    test.binding.setAwareness({ moving: null });
    expect(test.updates()).toBe(5);

    test.destroy();
  });

  it('drops a peer’s in-flight geometry that is missing a box', () => {
    const test = awarenessHarness();
    test.binding.setAwareness({
      moving: [
        { nodeId: 'top', x: 5, y: 5, width: 80, height: 40 },
        // A peer on a newer build, or a malformed entry: rendered as nothing
        // rather than as a card at the origin.
        { nodeId: '', x: 1, y: 1, width: 1, height: 1 },
      ] as never,
    });

    const local = test.binding.getLocalClientId();
    expect(
      test.binding.getAwarenessEntries().get(local as number)?.moving
    ).toEqual([{ nodeId: 'top', x: 5, y: 5, width: 80, height: 40 }]);
    test.destroy();
  });
});
