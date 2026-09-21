// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
  CANVAS_NODE_RANK_FIELD,
  NIMBALYST_CANVAS_NAMESPACE,
  canvasRankBetween,
  parseCanvasDocument,
  serializeCanvasDocument,
  type CanvasAnyNode,
  type CanvasDocument,
} from '../CanvasDocument';
import {
  applyCanvasNodeChanges,
  canvasCardKind,
  canvasCardReference,
  canvasClickSelection,
  canvasDragFollowers,
  createReferenceCanvasNode,
  canvasNodeDraggable,
  canvasNodeSelectable,
  toFlowNodes,
  zoomViewportAtPoint,
} from '../canvasFlowMapping';

function card(
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

describe('canvas <-> React Flow mapping', () => {
  it('retains unchanged card data across zoom/selection and only updates the changed card', () => {
    const document: CanvasDocument = {
      nodes: [
        card('note'),
        card('file', { type: 'file', file: 'screen.mockup.html' }),
      ],
    };
    const before = toFlowNodes(document, { zoom: 0.2 });
    const selection = toFlowNodes(
      document,
      { zoom: 0.3, selectedIds: new Set(['note']) },
      before
    );
    expect(selection[0].selected).toBe(true);
    expect(
      selection.map((node, index) => node.data === before[index].data)
    ).toEqual([true, true]);
    const warmed = toFlowNodes(
      document,
      { zoom: 0.5, lod: new Map([['file', 'warm']]) },
      selection
    );
    expect(warmed[0].data).toBe(selection[0].data);
    expect(warmed[1].data).not.toBe(selection[1].data);
    const changed = toFlowNodes(
      { nodes: [card('note', { text: 'edited' }), document.nodes![1]] },
      { readOnly: true },
      warmed
    );
    expect(changed[0].data.node.text).toBe('edited');
    expect(changed.every((node) => node.data.readOnly)).toBe(true);
  });

  it('derives zIndex from rank order, falling back to file array order', () => {
    // No ranks: the file's array order is the z-order, exactly as the spec says.
    const fromFile: CanvasDocument = {
      nodes: [card('bottom'), card('middle'), card('top')],
    };
    expect(toFlowNodes(fromFile).map((node) => [node.id, node.zIndex])).toEqual(
      [
        ['bottom', 0],
        ['middle', 1],
        ['top', 2],
      ]
    );

    // Ranked (the shape the collaborative document uses): rank decides, and a
    // node whose rank lands between two others paints between them -- even
    // though it sits last in the array, which is what a concurrent insert
    // produces.
    const low = canvasRankBetween(null, null);
    const high = canvasRankBetween(low, null);
    const ranked: CanvasDocument = {
      nodes: [
        card('bottom', { [CANVAS_NODE_RANK_FIELD]: low }),
        card('top', { [CANVAS_NODE_RANK_FIELD]: high }),
        card('inserted', {
          [CANVAS_NODE_RANK_FIELD]: canvasRankBetween(low, high),
        }),
      ],
    };
    expect(toFlowNodes(ranked).map((node) => node.id)).toEqual([
      'bottom',
      'inserted',
      'top',
    ]);
  });

  it('rounds dragged geometry, carries a frame’s contents, and leaves everything else alone', () => {
    const before: CanvasDocument = {
      nodes: [
        card('frame', { type: 'group', x: 0, y: 0, width: 600, height: 400 }),
        card('inside', { x: 20, y: 20 }),
        card('outside', { x: 900, y: 900 }),
      ],
    };

    const after = applyCanvasNodeChanges(before, [
      {
        id: 'inside',
        type: 'position',
        position: { x: 40.4, y: 60.6 },
        dragging: true,
      },
      { id: 'inside', type: 'select', selected: true },
    ]);
    expect(after.nodes?.[1]).toMatchObject({ x: 40, y: 61 });
    // Untouched nodes keep identity: a drag must not dirty the rest of the board.
    expect(after.nodes?.[0]).toBe(before.nodes?.[0]);
    expect(after.nodes?.[2]).toBe(before.nodes?.[2]);
    // Selection is view state and never reaches the document.
    expect(after.nodes?.[1]).not.toHaveProperty('selected');

    // Dragging the frame moves what it encloses and nothing else.
    const moved = applyCanvasNodeChanges(before, [
      { id: 'frame', type: 'position', position: { x: 100, y: 50 } },
    ]);
    expect(moved.nodes?.[0]).toMatchObject({ x: 100, y: 50 });
    expect(moved.nodes?.[1]).toMatchObject({ x: 120, y: 70 });
    expect(moved.nodes?.[2]).toBe(before.nodes?.[2]);

    // React Flow reports measured dimensions after every render; honouring
    // those would dirty a board nobody edited.
    expect(
      applyCanvasNodeChanges(before, [
        {
          id: 'inside',
          type: 'dimensions',
          dimensions: { width: 201, height: 99 },
        },
      ])
    ).toBe(before);
    expect(
      applyCanvasNodeChanges(before, [
        {
          id: 'inside',
          type: 'dimensions',
          dimensions: { width: 300.2, height: 150.8 },
          setAttributes: true,
        },
      ]).nodes?.[1]
    ).toMatchObject({ width: 300, height: 151 });

    // Removing a node takes its edges with it, and only its edges.
    const connected: CanvasDocument = {
      ...before,
      edges: [
        { id: 'a', fromNode: 'inside', toNode: 'outside' },
        { id: 'b', fromNode: 'frame', toNode: 'outside' },
      ],
    };
    const pruned = applyCanvasNodeChanges(connected, [
      { id: 'inside', type: 'remove' },
    ]);
    expect(pruned.nodes?.map((node) => node.id)).toEqual(['frame', 'outside']);
    expect(pruned.edges?.map((edge) => edge.id)).toEqual(['b']);
  });

  it('survives a load, edit, and save cycle with an unknown node type intact', () => {
    const source = serializeCanvasDocument({
      nodes: [
        {
          id: 'foreign',
          type: 'mermaid',
          x: 0,
          y: 0,
          width: 300,
          height: 200,
          source: 'graph TD',
        },
        card('note', {
          x: 400,
          [NIMBALYST_CANVAS_NAMESPACE]: {
            reference: { kind: 'native', nativeKind: 'sticky' },
          },
        }),
      ],
      edges: [],
    });

    const loaded = parseCanvasDocument(source);
    // The card renders as a labelled placeholder rather than vanishing.
    expect(canvasCardKind(loaded.nodes![0])).toBe('unsupported');
    expect(canvasCardKind(loaded.nodes![1])).toBe('sticky');

    const edited = applyCanvasNodeChanges(loaded, [
      { id: 'note', type: 'position', position: { x: 410.5, y: 0 } },
    ]);
    const saved = JSON.parse(serializeCanvasDocument(edited));
    expect(saved.nodes[0]).toEqual(JSON.parse(source).nodes[0]);
    expect(saved.nodes[1].x).toBe(411);
  });

  /*
   * The regression NIM-3845 actually leaves behind. Popover and Monaco maths
   * measured correct at every scale; what does not survive is an *interactive*
   * card sitting under a scale transform -- RevoGrid's hit-testing is wrong by
   * `d_local * (k - 1)` with no scale floor to sit above.
   *
   * Activation animates to 1.0, so the card is fine at the moment it goes hot.
   * The hazard is everything that changes the zoom *afterwards*: the Controls
   * zoom buttons, ctrl+wheel over the pane, the minimap, `fitView`. None of
   * those consult the activation state. So the gate lives here, at the single
   * function that decides which card is hot, rather than in a handler another
   * zoom path could forget to call.
   */
  it('never reports a card as active while the viewport is scaled', () => {
    const document: CanvasDocument = { nodes: [card('a'), card('b')] };
    const activeOf = (nodes: ReturnType<typeof toFlowNodes>) =>
      nodes.filter((node) => node.data.active).map((node) => node.id);

    // At (and within tolerance of) 1.0 the card is hot and owns the pointer.
    expect(
      activeOf(toFlowNodes(document, { activeNodeId: 'a', zoom: 1 }))
    ).toEqual(['a']);
    expect(
      activeOf(toFlowNodes(document, { activeNodeId: 'a', zoom: 0.99 }))
    ).toEqual(['a']);

    // Zoomed away from 1.0 the card goes inert again, whatever asked for it.
    for (const zoom of [0.5, 0.9, 1.5, 2]) {
      const nodes = toFlowNodes(document, { activeNodeId: 'a', zoom });
      expect(activeOf(nodes)).toEqual([]);
      // ...and it becomes draggable/selectable again, so the board stays usable
      // rather than leaving one card stuck in a half-activated state.
      const card_a = nodes.find((node) => node.id === 'a')!;
      expect(card_a.draggable).toBe(true);
      expect(card_a.selectable).toBe(true);
    }

    // An omitted zoom means "the caller is not driving a viewport" (the codec,
    // a test, a static export) and must not silently disable activation.
    expect(activeOf(toFlowNodes(document, { activeNodeId: 'a' }))).toEqual([
      'a',
    ]);
  });

  it('anchors a Cmd+wheel zoom under the pointer and clamps to the flow limits', () => {
    const limits = { minZoom: 0.1, maxZoom: 2 };
    const viewport = { x: -100, y: -40, zoom: 1 };
    // The canvas point currently under the pointer. It is the one thing that
    // must not move; everything else about the viewport may.
    const point = { x: 300, y: 200 };
    const canvasUnderPointer = {
      x: (point.x - viewport.x) / viewport.zoom,
      y: (point.y - viewport.y) / viewport.zoom,
    };

    for (const deltaY of [-120, -1, 1, 120]) {
      const next = zoomViewportAtPoint(
        viewport,
        point,
        { deltaY, deltaMode: 0 },
        limits
      )!;
      expect(next.zoom).toBeCloseTo(Math.pow(2, -deltaY * 0.002), 10);
      expect(next.x + canvasUnderPointer.x * next.zoom).toBeCloseTo(point.x, 6);
      expect(next.y + canvasUnderPointer.y * next.zoom).toBeCloseTo(point.y, 6);
    }

    // Firefox reports lines rather than pixels; one line must not zoom as far
    // as one pixel-delta of the same number would.
    expect(
      zoomViewportAtPoint(
        viewport,
        point,
        { deltaY: -3, deltaMode: 1 },
        limits
      )!.zoom
    ).toBeCloseTo(Math.pow(2, 3 * 0.05), 10);

    // Clamped, and a tick that cannot move the scale reports "nothing to do"
    // rather than a viewport write -- each one drags pan/zoom events behind it.
    expect(
      zoomViewportAtPoint(
        { x: 0, y: 0, zoom: 2 },
        point,
        { deltaY: -500, deltaMode: 0 },
        limits
      )
    ).toBeNull();
    expect(
      zoomViewportAtPoint(
        { x: 0, y: 0, zoom: 0.1 },
        point,
        { deltaY: 500, deltaMode: 0 },
        limits
      )
    ).toBeNull();
    expect(
      zoomViewportAtPoint(
        { x: 0, y: 0, zoom: 1.5 },
        point,
        { deltaY: -5000, deltaMode: 0 },
        limits
      )!.zoom
    ).toBe(2);
  });

  it('creates reference cards a plain JSON Canvas reader can still make sense of', () => {
    const document: CanvasDocument = { nodes: [card('a')] };

    const file = createReferenceCanvasNode(
      document,
      { kind: 'file', path: 'docs/UI_PATTERNS.md' },
      { x: 0, y: 0 },
      'UI patterns'
    );
    // The spec fields are for the other tool; `x-nimbalyst` is what we read.
    expect(file.type).toBe('file');
    expect(file.file).toBe('docs/UI_PATTERNS.md');
    expect(canvasCardKind(file)).toBe('reference');
    expect(canvasCardReference(file)).toEqual({
      kind: 'file',
      path: 'docs/UI_PATTERNS.md',
    });
    expect(file[NIMBALYST_CANVAS_NAMESPACE]?.label).toBe('UI patterns');

    // A shared document has no spec type of its own, so it rides as a link
    // carrying its URI rather than as an unresolvable `file`.
    const shared = createReferenceCanvasNode(
      document,
      { kind: 'doc', uri: 'nimbalyst://doc/org-1/doc-1' },
      { x: 0, y: 0 }
    );
    expect(shared.type).toBe('link');
    expect(shared.url).toBe('nimbalyst://doc/org-1/doc-1');
    expect(canvasCardKind(shared)).toBe('reference');
    expect(canvasCardReference(shared)).toEqual({
      kind: 'doc',
      uri: 'nimbalyst://doc/org-1/doc-1',
    });
    // No label offered means no empty label written into the file.
    expect(shared[NIMBALYST_CANVAS_NAMESPACE]).not.toHaveProperty('label');

    // Centred on the point, and never colliding with what is already there.
    expect(file.x).toBe(-file.width / 2);
    expect(file.y).toBe(-file.height / 2);
    expect(new Set([file.id, shared.id, 'a']).size).toBe(3);
  });
});

/**
 * Four independent reasons a card may not be dragged, and every one of them is
 * invisible until somebody tries. The two that regressed in review were locked
 * -- a lock that still lets you move the card locks nothing -- and the hand
 * tool, where a card that accepts the drag moves instead of the board.
 */
describe('canvasNodeDraggable', () => {
  const base = { readOnly: false, active: false, locked: false } as const;

  it('allows an ordinary card with the select tool', () => {
    expect(canvasNodeDraggable({ ...base })).toBe(true);
    expect(canvasNodeDraggable({ ...base, tool: 'select' })).toBe(true);
  });

  it('refuses read-only, active, locked, and the hand tool', () => {
    expect(canvasNodeDraggable({ ...base, readOnly: true })).toBe(false);
    expect(canvasNodeDraggable({ ...base, active: true })).toBe(false);
    expect(canvasNodeDraggable({ ...base, locked: true })).toBe(false);
    expect(canvasNodeDraggable({ ...base, tool: 'hand' })).toBe(false);
  });

  it('carries locked and the tool through the mapping', () => {
    const document = {
      nodes: [
        card('free'),
        card('pinned', {
          [NIMBALYST_CANVAS_NAMESPACE]: { locked: true },
        } as Partial<CanvasAnyNode>),
      ],
      edges: [],
    } as unknown as CanvasDocument;

    const select = toFlowNodes(document, { tool: 'select' });
    expect(select.map((node) => node.draggable)).toEqual([true, false]);

    const hand = toFlowNodes(document, { tool: 'hand' });
    expect(hand.map((node) => node.draggable)).toEqual([false, false]);
  });
});

/**
 * A frame is not marquee bait, and the refusal has to happen before React Flow
 * hit-tests: this flow is controlled, so a dropped `select` change never reaches
 * the document, but React Flow has already written `selected` into its own store
 * and drawn a drag-ready rectangle around the frame.
 */
describe('canvasNodeSelectable', () => {
  it('never lets React Flow select a frame, and never an active card', () => {
    expect(canvasNodeSelectable({ active: false, frame: false })).toBe(true);
    expect(canvasNodeSelectable({ active: false, frame: true })).toBe(false);
    expect(canvasNodeSelectable({ active: true, frame: false })).toBe(false);
  });

  it('takes frames out of the hit test through the mapping', () => {
    const document: CanvasDocument = {
      nodes: [
        card('frame', { type: 'group', x: 0, y: 0, width: 600, height: 400 }),
        card('inside', { x: 20, y: 20 }),
      ],
    };
    // Constant, not a mode: React Flow opens a marquee and hit-tests in the
    // same event, so anything it has to be *told* arrives a frame too late.
    expect(toFlowNodes(document).map((node) => node.selectable)).toEqual([
      false,
      true,
    ]);
  });
});

/** What a click on a frame means, since React Flow will not answer it. */
describe('canvasClickSelection', () => {
  const loose = [card('a'), card('b'), card('frame', { type: 'group' })];

  it('replaces the selection on a plain click', () => {
    expect([
      ...canvasClickSelection(new Set(['a', 'b']), 'frame', false, loose),
    ]).toEqual(['frame']);
  });

  it('toggles an ungrouped card into and out of the selection', () => {
    expect([
      ...canvasClickSelection(new Set(['a']), 'frame', true, loose),
    ]).toEqual(['a', 'frame']);
    expect([
      ...canvasClickSelection(new Set(['a', 'frame']), 'frame', true, loose),
    ]).toEqual(['a']);
  });

  describe('a grouped card selects and deselects as a whole group', () => {
    const grouped = [
      card('frame', {
        type: 'group',
        [NIMBALYST_CANVAS_NAMESPACE]: { group: 'g1' },
      } as Partial<CanvasAnyNode>),
      card('sibling', {
        [NIMBALYST_CANVAS_NAMESPACE]: { group: 'g1' },
      } as Partial<CanvasAnyNode>),
      card('loner'),
    ];

    it('takes the whole group on a plain click', () => {
      expect([
        ...canvasClickSelection(new Set(['loner']), 'frame', false, grouped),
      ]).toEqual(['frame', 'sibling']);
    });

    it('adds the whole group on a Shift+click', () => {
      expect([
        ...canvasClickSelection(new Set(['loner']), 'frame', true, grouped),
      ]).toEqual(['loner', 'frame', 'sibling']);
    });

    it('removes the whole group on a Shift+click that deselects', () => {
      // The residual this replaced: dropping only the frame left `sibling`
      // selected, and expanding the result afterwards put the frame back, so
      // Shift+clicking a grouped frame appeared to do nothing.
      expect([
        ...canvasClickSelection(
          new Set(['frame', 'sibling', 'loner']),
          'frame',
          true,
          grouped
        ),
      ]).toEqual(['loner']);
    });

    it('resolves a half-selected group in the clicked card’s direction', () => {
      // `sibling` is selected and `frame` is not: the clicked card decides, so
      // this adds rather than flipping each member independently.
      expect([
        ...canvasClickSelection(new Set(['sibling']), 'frame', true, grouped),
      ]).toEqual(['sibling', 'frame']);
    });
  });
});

/**
 * What travels with a drag, which React Flow cannot answer: it snapshots the
 * nodes a drag moves at pointer-down, so press-dragging an unselected group
 * member moves that member alone no matter what the surface's selection says.
 */
describe('canvasDragFollowers', () => {
  const grouped = (id: string, group: string, rest: object = {}) =>
    card(id, {
      [NIMBALYST_CANVAS_NAMESPACE]: { group },
      ...rest,
    } as Partial<CanvasAnyNode>);

  it('carries unlocked group siblings of a member nobody selected', () => {
    const nodes = [
      grouped('a', 'g1', { x: 0, y: 0 }),
      grouped('b', 'g1', { x: 300, y: 0 }),
      card('loner', { x: 900, y: 900 }),
    ];
    expect(canvasDragFollowers(nodes, nodes[0])).toEqual(['b']);

    const moved = applyCanvasNodeChanges({ nodes }, [
      { id: 'a', type: 'position', position: { x: 10, y: 5 } },
    ]);
    expect(moved.nodes?.[1]).toMatchObject({ x: 310, y: 5 });
    expect(moved.nodes?.[2]).toBe(nodes[2]);
  });

  it('leaves a locked card where it is, inside a frame or inside a group', () => {
    const nodes = [
      card('frame', { type: 'group', x: 0, y: 0, width: 600, height: 400 }),
      card('free', { x: 20, y: 20 }),
      card('pinned', {
        x: 200,
        y: 20,
        [NIMBALYST_CANVAS_NAMESPACE]: { locked: true },
      } as Partial<CanvasAnyNode>),
      grouped('member', 'g1', { x: 900, y: 900 }),
      grouped('pinned-member', 'g1', {
        x: 1200,
        y: 900,
        [NIMBALYST_CANVAS_NAMESPACE]: { group: 'g1', locked: true },
      }),
    ];

    expect(canvasDragFollowers(nodes, nodes[0])).toEqual(['free']);
    expect(canvasDragFollowers(nodes, nodes[3])).toEqual([]);

    const moved = applyCanvasNodeChanges({ nodes }, [
      { id: 'frame', type: 'position', position: { x: 100, y: 0 } },
    ]);
    expect(moved.nodes?.[1]).toMatchObject({ x: 120, y: 20 });
    expect(moved.nodes?.[2]).toBe(nodes[2]);
  });

  it('moves a sibling once when two members of one group are dragged together', () => {
    const nodes = [
      grouped('a', 'g1', { x: 0, y: 0 }),
      grouped('b', 'g1', { x: 300, y: 0 }),
      grouped('c', 'g1', { x: 600, y: 0 }),
    ];
    // React Flow moves the two selected members itself and says nothing about
    // the third; without the batch guard each delta would carry it.
    const moved = applyCanvasNodeChanges({ nodes }, [
      { id: 'a', type: 'position', position: { x: 10, y: 0 } },
      { id: 'b', type: 'position', position: { x: 310, y: 0 } },
    ]);
    expect(moved.nodes?.map((node) => node.x)).toEqual([10, 310, 610]);
  });

  it('follows a group through a frame it contains', () => {
    const nodes = [
      grouped('frame', 'g1', {
        type: 'group',
        x: 0,
        y: 0,
        width: 600,
        height: 400,
      }),
      card('inside', { x: 20, y: 20 }),
      grouped('sibling', 'g1', { x: 900, y: 900 }),
    ];
    // Dragging the far sibling carries the frame, and the frame carries what it
    // encloses -- one walk, not two special cases.
    expect(canvasDragFollowers(nodes, nodes[2]).sort()).toEqual([
      'frame',
      'inside',
    ]);
  });
});
