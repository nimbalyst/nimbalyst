// @vitest-environment node

import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

import {
  CANVAS_NODE_RANK_FIELD,
  NIMBALYST_CANVAS_NAMESPACE,
  canvasRankBetween,
  isCanvasSpecNode,
  parseCanvasDocument,
  serializeCanvasDocument,
  type CanvasDocument,
} from '../CanvasDocument';
import { canvasCollabCodec } from '../canvasCollabCodec';
import { canvasCardKind, canvasNodeReference } from '../canvasFlowMapping';
import { CANVAS_SNAP_GRID } from '../canvasSnapping';
import {
  convertMockupProjectToCanvas,
  type MockupProjectCanvasSource,
} from '../mockupProjectConverter';

function representativeBoard(): CanvasDocument {
  return {
    nodes: [
      {
        id: 'local-file',
        type: 'file',
        x: 10,
        y: 20,
        width: 400,
        height: 300,
        file: 'design/login.mockup.html',
        [NIMBALYST_CANVAS_NAMESPACE]: {
          label: 'Login',
          locked: true,
          group: 'auth-flow',
          reference: {
            kind: 'file',
            path: 'design/login.mockup.html',
            sharedAs: {
              uri: 'nimbalyst://doc/org-1/doc-1',
              revisionId: 'revision-4',
              futureBindingField: true,
            },
          },
          futureNodeField: { retained: true },
        },
        thirdPartyNodeField: ['also', 'retained'],
      },
      {
        id: 'shared-doc',
        type: 'link',
        x: 460,
        y: 20,
        width: 400,
        height: 300,
        url: 'nimbalyst://doc/org-1/doc-2',
        [NIMBALYST_CANVAS_NAMESPACE]: {
          reference: {
            kind: 'doc',
            uri: 'nimbalyst://doc/org-1/doc-2',
            revisionId: 'revision-7',
          },
        },
      },
      {
        id: 'note',
        type: 'text',
        x: 10,
        y: 360,
        width: 240,
        height: 160,
        text: 'Review the empty state',
        color: '3',
        [NIMBALYST_CANVAS_NAMESPACE]: {
          reference: {
            kind: 'native',
            nativeKind: 'sticky',
          },
        },
      },
    ],
    edges: [
      {
        id: 'login-flow',
        fromNode: 'local-file',
        fromSide: 'right',
        fromEnd: 'none',
        toNode: 'shared-doc',
        toSide: 'left',
        toEnd: 'arrow',
        label: 'Continue',
        [NIMBALYST_CANVAS_NAMESPACE]: {
          kind: 'flow',
          futureEdgeField: 9,
        },
        thirdPartyEdgeField: 'retained',
      },
    ],
    [NIMBALYST_CANVAS_NAMESPACE]: {
      version: 1,
      meta: {
        name: 'Authentication flow',
        description: 'Current and pinned screens',
        viewport: { x: 12, y: 18, zoom: 0.8, futureViewportField: 'kept' },
        designSystem: { uri: 'design/system.json', theme: 'dark' },
        futureMetaField: { retained: true },
      },
      futureNamespaceField: 'retained',
    },
    thirdPartyTopLevelField: { retained: true },
  };
}

/** Same document, every object's keys in the opposite insertion order. */
function withReversedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withReversedKeys);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, entry]) => [key, withReversedKeys(entry)])
  );
}

describe('Project Canvas format and codec', () => {
  /*
   * An unfilled sticky and an unplaced image card are ordinary authoring
   * states: the surface creates the node the moment you drop it and you type
   * into it afterwards. Refusing to serialize them made a board editable but
   * not saveable, which broke local `.canvas` save (`onSaveRequested`), every
   * headless collab read, and source mode in the web console -- the one case
   * source mode exists for. Observed on both real shared boards.
   *
   * Only the native card payloads are allowed to be empty. `id`, `type`, a
   * file node's `file`, and every edge endpoint stay strict.
   */
  it('serializes a board holding an empty sticky and an empty image card', () => {
    const halfAuthored: CanvasDocument = {
      nodes: [
        {
          id: 'text-7724a26f8d9e',
          type: 'text',
          x: 3180,
          y: 1440,
          width: 320,
          height: 200,
          text: '',
          [NIMBALYST_CANVAS_NAMESPACE]: {
            reference: { kind: 'native', nativeKind: 'text' },
          },
        },
        {
          id: 'image-4923b31fe158',
          type: 'link',
          x: 3160,
          y: 1420,
          width: 360,
          height: 260,
          url: '',
          [NIMBALYST_CANVAS_NAMESPACE]: {
            reference: { kind: 'native', nativeKind: 'image' },
          },
        },
      ],
      edges: [],
    } as unknown as CanvasDocument;

    const source = serializeCanvasDocument(halfAuthored);
    const parsed = parseCanvasDocument(source);
    expect(parsed.nodes?.[0].text).toBe('');
    expect(parsed.nodes?.[1].url).toBe('');
    expect(serializeCanvasDocument(parsed)).toBe(source);

    // The codec is the path that actually broke: exportToFile is
    // serializeCanvasDocument, and the console's source mode calls it.
    const yDoc = new Y.Doc();
    canvasCollabCodec.seedFromFile(yDoc, source);
    expect(canvasCollabCodec.exportToFile(yDoc)).toBe(source);
  });

  it('still rejects an empty id, node type, file path, or edge endpoint', () => {
    const node = {
      id: 'n',
      type: 'file',
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      file: 'a.md',
    };
    expect(() =>
      serializeCanvasDocument({ nodes: [{ ...node, id: '' }] } as unknown as CanvasDocument)
    ).toThrow(/id must be a non-empty string/);
    expect(() =>
      serializeCanvasDocument({ nodes: [{ ...node, type: '' }] } as unknown as CanvasDocument)
    ).toThrow(/type must be a non-empty string/);
    expect(() =>
      serializeCanvasDocument({ nodes: [{ ...node, file: '' }] } as unknown as CanvasDocument)
    ).toThrow(/file must be a non-empty string/);
    expect(() =>
      serializeCanvasDocument({
        nodes: [node],
        edges: [{ id: 'e', fromNode: 'n', toNode: '' }],
      } as unknown as CanvasDocument)
    ).toThrow(/toNode must be a non-empty string/);
  });

  it('serializes canonically and idempotently without dropping foreign fields', () => {
    const source = serializeCanvasDocument(representativeBoard());
    const parsed = parseCanvasDocument(source);
    expect(Object.keys(parsed.nodes![0][NIMBALYST_CANVAS_NAMESPACE]!)).toEqual([
      'reference', 'label', 'locked', 'group', 'futureNodeField',
    ]);

    // Canonical: a fixed point, and independent of the author's key order.
    expect(serializeCanvasDocument(parsed)).toBe(source);
    expect(
      serializeCanvasDocument(
        parseCanvasDocument(
          JSON.stringify(withReversedKeys(representativeBoard()))
        )
      )
    ).toBe(source);

    expect(parsed.thirdPartyTopLevelField).toEqual({ retained: true });
    expect(parsed.nodes?.[0].thirdPartyNodeField).toEqual(['also', 'retained']);
    expect(
      parsed.nodes?.[0][NIMBALYST_CANVAS_NAMESPACE]?.futureNodeField
    ).toEqual({ retained: true });
    expect(parsed.edges?.[0].thirdPartyEdgeField).toBe('retained');
  });

  it('keeps a vanilla file intact, passes unknown node types through, and rounds dragged geometry', () => {
    const vanilla = JSON.stringify(
      {
        nodes: [
          {
            id: 'text',
            type: 'text',
            x: 0,
            y: 0,
            width: 200,
            height: 100,
            text: '# Note',
          },
          {
            id: 'file',
            type: 'file',
            x: 220,
            y: 0,
            width: 300,
            height: 200,
            file: 'note.md',
            subpath: '#intro',
          },
          {
            id: 'link',
            type: 'link',
            x: 0,
            y: 120,
            width: 200,
            height: 100,
            url: 'https://jsoncanvas.org',
          },
          {
            id: 'group',
            type: 'group',
            x: -20,
            y: -20,
            width: 600,
            height: 400,
            label: 'References',
            backgroundStyle: 'cover',
          },
        ],
        edges: [
          {
            id: 'edge',
            fromNode: 'text',
            fromSide: 'right',
            fromEnd: 'none',
            toNode: 'file',
            toSide: 'left',
            toEnd: 'arrow',
            color: '#ff0000',
            label: 'opens',
          },
        ],
      },
      null,
      2
    );
    expect(serializeCanvasDocument(parseCanvasDocument(vanilla))).toBe(vanilla);

    // A `type` outside spec 1.0 must not make the board unopenable.
    const foreign = parseCanvasDocument(
      JSON.stringify({
        nodes: [
          {
            id: 'future',
            type: 'mermaid',
            x: 0,
            y: 0,
            width: 100,
            height: 100,
            source: 'graph TD',
          },
        ],
      })
    );
    expect(isCanvasSpecNode(foreign.nodes![0])).toBe(false);
    expect(JSON.parse(serializeCanvasDocument(foreign)).nodes[0].source).toBe(
      'graph TD'
    );

    // Dragging produces fractional pixels; serialization rounds, never throws.
    const dragged = parseCanvasDocument(
      serializeCanvasDocument(representativeBoard())
    );
    dragged.nodes![0].x = 100.5;
    expect(JSON.parse(serializeCanvasDocument(dragged)).nodes[0].x).toBe(101);
  });

  it('uses the same lossless mapping for a headless Y.Doc seed and export', () => {
    const source = serializeCanvasDocument(representativeBoard());
    const yDoc = new Y.Doc();

    expect(canvasCollabCodec.isEmpty(yDoc)).toBe(true);
    canvasCollabCodec.seedFromFile(yDoc, new TextEncoder().encode(source));

    expect(canvasCollabCodec.isEmpty(yDoc)).toBe(false);
    expect(canvasCollabCodec.exportToFile(yDoc)).toBe(source);
  });

  it('preserves foreign internal-looking keys and recovers version-skew lock/group fields', () => {
    const document = representativeBoard();
    const node = document.nodes![0];
    node.__canvas_locked = { foreign: 'keep' };
    node.__canvas_group = ['foreign'];
    node['__canvas_file:__canvas_locked'] = 'also keep';
    const source = serializeCanvasDocument(document);
    const yDoc = new Y.Doc();
    canvasCollabCodec.seedFromFile(yDoc, source);
    expect(canvasCollabCodec.exportToFile(yDoc)).toBe(source);
    canvasCollabCodec.applyFromFile(yDoc, source);
    expect(canvasCollabCodec.exportToFile(yDoc)).toBe(source);

    delete node[NIMBALYST_CANVAS_NAMESPACE]!.locked;
    delete node[NIMBALYST_CANVAS_NAMESPACE]!.group;
    node.__canvas_locked = true;
    node.__canvas_group = 'older-peer-group';
    canvasCollabCodec.applyFromFile(yDoc, serializeCanvasDocument(document));
    const recovered = parseCanvasDocument(canvasCollabCodec.exportToFile(yDoc) as string).nodes![0];
    expect(recovered.__canvas_locked).toBe(true);
    expect(recovered.__canvas_group).toBe('older-peer-group');
    expect(recovered[NIMBALYST_CANVAS_NAMESPACE]).toMatchObject({ locked: true, group: 'older-peer-group' });
    yDoc.destroy();
  });

  it('updates and removes lock/group as individual fields and reads legacy namespace blobs', () => {
    const document = representativeBoard();
    const yDoc = new Y.Doc();
    canvasCollabCodec.seedFromFile(yDoc, serializeCanvasDocument(document));
    const fields = yDoc.getMap<Y.Map<unknown>>('nodes').get('local-file')!;
    const namespace = fields.get(NIMBALYST_CANVAS_NAMESPACE);
    const keys = new Set<string>();
    fields.observe(event => event.keysChanged.forEach(key => keys.add(key)));
    document.nodes![0][NIMBALYST_CANVAS_NAMESPACE]!.locked = false;
    document.nodes![0][NIMBALYST_CANVAS_NAMESPACE]!.group = 'new-group';
    canvasCollabCodec.applyFromFile(yDoc, serializeCanvasDocument(document));
    expect(keys).toEqual(new Set(['__canvas_locked', '__canvas_group']));
    expect(fields.get(NIMBALYST_CANVAS_NAMESPACE)).toBe(namespace);
    expect(canvasCollabCodec.exportToFile(yDoc)).toBe(serializeCanvasDocument(document));
    delete document.nodes![0][NIMBALYST_CANVAS_NAMESPACE]!.locked;
    delete document.nodes![0][NIMBALYST_CANVAS_NAMESPACE]!.group;
    canvasCollabCodec.applyFromFile(yDoc, serializeCanvasDocument(document));
    expect(canvasCollabCodec.exportToFile(yDoc)).toBe(serializeCanvasDocument(document));
    fields.delete('__canvas_locked');
    fields.delete('__canvas_group');
    fields.set(NIMBALYST_CANVAS_NAMESPACE, { ...document.nodes![0][NIMBALYST_CANVAS_NAMESPACE], locked: true, group: 'legacy' });
    const legacy = parseCanvasDocument(canvasCollabCodec.exportToFile(yDoc) as string);
    expect(legacy.nodes![0][NIMBALYST_CANVAS_NAMESPACE]).toMatchObject({ locked: true, group: 'legacy', futureNodeField: { retained: true } });
    canvasCollabCodec.applyFromFile(yDoc, serializeCanvasDocument(document));
    expect(canvasCollabCodec.exportToFile(yDoc)).toBe(serializeCanvasDocument(document));
    yDoc.destroy();
  });

  it('diff-patches a populated Y.Doc without replacing entity maps or churning z ranks', () => {
    const yDoc = new Y.Doc();
    canvasCollabCodec.seedFromFile(
      yDoc,
      serializeCanvasDocument(representativeBoard())
    );
    const yNodes = yDoc.getMap<Y.Map<unknown>>('nodes');
    const untouched = yNodes.get('shared-doc')!;
    const changed = yNodes.get('local-file')!;
    const untouchedObserver = vi.fn();
    let changedKeys: string[] = [];
    untouched.observe(untouchedObserver);
    changed.observe((event) => changedKeys.push(...event.keysChanged));

    const moved = representativeBoard();
    moved.nodes![0] = { ...moved.nodes![0], x: 35 };
    canvasCollabCodec.applyFromFile(yDoc, serializeCanvasDocument(moved));

    expect(yNodes.get('shared-doc')).toBe(untouched);
    expect(yNodes.get('local-file')).toBe(changed);
    expect(untouchedObserver).not.toHaveBeenCalled();
    // Unchanged node order must not rewrite ranks.
    expect(changedKeys).toEqual(['x']);
    expect(canvasCollabCodec.exportToFile(yDoc)).toBe(
      serializeCanvasDocument(moved)
    );

    // Node array order is z-order (spec: last entry paints on top). Moving one
    // node to the front of the stack re-ranks only that node.
    changedKeys = [];
    const restacked = {
      ...moved,
      nodes: [moved.nodes![1], moved.nodes![2], moved.nodes![0]],
    };
    canvasCollabCodec.applyFromFile(yDoc, serializeCanvasDocument(restacked));

    expect(untouchedObserver).not.toHaveBeenCalled();
    expect(changedKeys).toEqual([CANVAS_NODE_RANK_FIELD]);
    expect(canvasCollabCodec.exportToFile(yDoc)).toBe(
      serializeCanvasDocument(restacked)
    );

    // Repeated inserts at the same spot must keep narrowing, never collapse.
    // (A rank ending in the lowest digit silently breaks the string compare.)
    let [low, high] = [canvasRankBetween(null, null), null as string | null];
    high = canvasRankBetween(low, null);
    for (let insert = 0; insert < 500; insert += 1) {
      const middle = canvasRankBetween(low, high);
      expect(low < middle && middle < high).toBe(true);
      low = insert % 2 === 0 ? middle : low;
      high = insert % 2 === 0 ? high : middle;
    }
  });

  it('converts every MockupProject card, flow, viewport, and design-system field', () => {
    const project: MockupProjectCanvasSource = {
      version: 1,
      name: 'Checkout',
      description: 'Happy and retry paths',
      designSystem: { styleGuide: 'design/system.mockup.html', theme: 'light' },
      mockups: [
        {
          id: 'cart',
          path: 'cart.mockup.html',
          label: 'Cart',
          position: { x: 10.25, y: 20.75 },
          size: { width: 400.5, height: 300 },
        },
        {
          id: 'receipt',
          path: 'receipt.mockup.html',
          label: 'Receipt',
          position: { x: 500, y: 20 },
          size: { width: 400, height: 300 },
        },
      ],
      connections: [
        {
          id: 'success',
          fromMockupId: 'cart',
          toMockupId: 'receipt',
          fromElementSelector: '#buy',
          label: 'Buy',
          trigger: 'click',
        },
        {
          id: 'retry',
          fromMockupId: 'receipt',
          toMockupId: 'cart',
          trigger: 'navigate',
        },
      ],
      viewport: { x: -120.5, y: 42.25, zoom: 0.75 },
    };

    const canvas = convertMockupProjectToCanvas(project);
    expect(canvas[NIMBALYST_CANVAS_NAMESPACE]?.meta).toEqual({
      name: project.name,
      description: project.description,
      viewport: project.viewport,
      designSystem: project.designSystem,
    });
    expect(canvas.nodes).toHaveLength(project.mockups!.length);
    // Geometry is rounded once, on the way in; the fractional original is not
    // kept anywhere, so the card can never carry two contradictory positions.
    expect(canvas.nodes?.[0]).toEqual({
      id: 'cart',
      type: 'file',
      x: 10,
      y: 21,
      width: 401,
      height: 300,
      file: 'cart.mockup.html',
      [NIMBALYST_CANVAS_NAMESPACE]: {
        label: 'Cart',
        reference: { kind: 'file', path: 'cart.mockup.html' },
      },
    });
    expect(canvas.edges).toEqual([
      {
        id: 'success',
        fromNode: 'cart',
        toNode: 'receipt',
        label: 'Buy',
        [NIMBALYST_CANVAS_NAMESPACE]: {
          kind: 'flow',
          flow: { fromElementSelector: '#buy', trigger: 'click' },
        },
      },
      {
        id: 'retry',
        fromNode: 'receipt',
        toNode: 'cart',
        [NIMBALYST_CANVAS_NAMESPACE]: {
          kind: 'flow',
          flow: { trigger: 'navigate' },
        },
      },
    ]);
    expect(() => serializeCanvasDocument(canvas)).not.toThrow();

    // A partial project file still converts rather than throwing.
    const minimal = convertMockupProjectToCanvas({
      mockups: [{ id: 'only', path: 'a/b/only.mockup.html' }],
    });
    expect(minimal.nodes?.[0]).toMatchObject({
      x: 0,
      y: 0,
      width: 400,
      height: 300,
      [NIMBALYST_CANVAS_NAMESPACE]: { label: 'only.mockup.html' },
    });
    expect(minimal[NIMBALYST_CANVAS_NAMESPACE]?.meta?.viewport).toEqual({
      x: 0,
      y: 0,
      zoom: 1,
    });
  });
});

/**
 * The canvas authoring skill ships a hand-written board to AI sessions, and a
 * format change would rot it silently -- the skill is prose, so nothing else
 * ever executes what it teaches. Running its worked example through the real
 * parser is what keeps "what we tell agents to write" and "what we accept"
 * from drifting apart.
 */
describe('canvas authoring skill', () => {
  const SKILL_PATH = join(
    __dirname,
    '../../../../extensions/canvas/claude-plugin/skills/canvas/SKILL.md'
  );

  const blocks = [
    ...readFileSync(SKILL_PATH, 'utf-8').matchAll(/```json\n([\s\S]*?)```/g),
  ].map((match) => match[1]);

  it('every documented snippet is valid JSON', () => {
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) expect(() => JSON.parse(block)).not.toThrow();
  });

  it('the worked example is a board the editor would accept', () => {
    const worked = blocks.find((block) => block.includes('"frame-flow"'));
    expect(worked).toBeDefined();
    const document = parseCanvasDocument(worked as string);

    const ids = new Set((document.nodes ?? []).map((node) => node.id));
    for (const edge of document.edges ?? []) {
      expect(ids.has(edge.fromNode)).toBe(true);
      expect(ids.has(edge.toNode)).toBe(true);
    }

    // Each card draws as the kind the skill's table claims it does.
    expect(
      Object.fromEntries(
        (document.nodes ?? []).map((node) => [node.id, canvasCardKind(node)])
      )
    ).toEqual({
      'frame-flow': 'group',
      signup: 'reference',
      verify: 'reference',
      'first-doc': 'reference',
      'note-question': 'sticky',
    });

    for (const node of document.nodes ?? []) {
      // On the grid the skill tells authors to use, so opening the board and
      // nudging a card does not immediately shift the whole layout.
      for (const value of [node.x, node.y, node.width, node.height]) {
        expect(Math.abs(value % CANVAS_SNAP_GRID)).toBe(0);
      }
      // A file card's spec field and its reference must name one path.
      const reference = canvasNodeReference(node);
      if (reference?.kind === 'file') expect(node.file).toBe(reference.path);
    }
  });
});
