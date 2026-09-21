// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { buildGeometry, type Size, type Arrangement } from '../layout/geometry';
import { routeConnections } from '../layout/orthogonalRouter';
import { measureArrangement } from '../layout/metrics';
import { autoLayoutEntitiesAsync } from '../utils/autoLayout';
import { createController } from '../layout/controller';
import { createDataModelStore } from '../store';
import { createEmptyDataModel, type Entity, type Relationship } from '../types';
const entity = (id: string, x = 0, y = 0): Entity => ({
  id,
  name: id,
  position: { x, y },
  fields: [],
});
const relation = (id: string, a: string, b: string): Relationship => ({
  id,
  sourceEntityName: a,
  targetEntityName: b,
  type: '1:N',
});
const viewport = { width: 1200, height: 800 };
const sizes = (entities: Entity[]) =>
  new Map(
    entities.map(
      (e, i) =>
        [
          e.id,
          { width: 250, height: i === 0 ? 777 : 300, fields: { id: 70 } },
        ] as [string, Size]
    )
  );
describe('measured layout and routing', () => {
  it('avoids tall cards in both orientations, preserves ports, and is deterministic across runtime ids', async () => {
    const entities = [entity('A'), entity('B'), entity('C'), entity('D')];
    const relationships = [
      relation('ab', 'A', 'B'),
      {
        ...relation('bc', 'B', 'C'),
        sourceFieldName: 'id',
        targetFieldName: 'id',
        name: 'owns',
      },
      relation('ca', 'C', 'A'),
      relation('ab2', 'A', 'B'),
      relation('self', 'C', 'C'),
    ];
    for (const direction of ['horizontal', 'vertical', 'automatic'] as const) {
      const result = await autoLayoutEntitiesAsync(
        entities,
        relationships,
        'standard',
        sizes(entities),
        direction,
        viewport
      );
      expect(measureArrangement(result, viewport)).toMatchObject({
        overlaps: 0,
        obstacleHits: 0,
      });
      expect(result.routes).toHaveLength(5);
      for (const r of result.routes) {
        const n = result.nodes.find((n) => n.id === r.source.nodeId)!;
        expect(r.points[0].x).toBeCloseTo(n.x + r.source.x);
        expect(r.points[0].y).toBeCloseTo(n.y + r.source.y);
      }
    }
    const first = await autoLayoutEntitiesAsync(
      entities,
      relationships,
      'standard',
      sizes(entities),
      'automatic',
      viewport
    );
    const renamed = entities.map((e) => ({ ...e, id: e.id + '-reload' }));
    const second = await autoLayoutEntitiesAsync(
      renamed,
      relationships,
      'standard',
      sizes(renamed),
      'automatic',
      viewport
    );
    expect(first.nodes.map((n) => [n.name, n.x, n.y])).toEqual(
      second.nodes.map((n) => [n.name, n.x, n.y])
    );
  });
  it('routes fixed cards around a third-party obstacle, including parallel edges and self-loops', () => {
    const entities = [
      entity('A', 0, 0),
      entity('B', 700, 0),
      entity('obstacle', 340, -100),
    ];
    const measurements = new Map(
      entities.map((e) => [e.id, { width: 200, height: 200, fields: {} }])
    );
    const geometry = buildGeometry(
      entities,
      [
        relation('ab', 'A', 'B'),
        relation('ab2', 'A', 'B'),
        relation('self', 'A', 'A'),
      ],
      measurements,
      'standard'
    );
    const positions = geometry.nodes.map((n) => [n.x, n.y]);
    const routes = routeConnections(geometry);
    expect(measureArrangement({ ...geometry, routes }, viewport)).toMatchObject(
      { overlaps: 0, obstacleHits: 0 }
    );
    expect(routes[0].points.length).toBeGreaterThan(2);
    expect(geometry.nodes.map((n) => [n.x, n.y])).toEqual(positions);
  });
  it('rejects unmeasured cards and overlapping fixed positions instead of drawing through them', () => {
    const entities = [entity('A'), entity('B', 10, 10)];
    expect(() => buildGeometry(entities, [], new Map(), 'full')).toThrow(
      'measuring'
    );
    expect(() =>
      routeConnections(
        buildGeometry(
          entities,
          [relation('ab', 'A', 'B')],
          sizes(entities),
          'standard'
        )
      )
    ).toThrow('Overlapping');
  });
});

describe('layout request ownership', () => {
  it.each(['drag', 'field', 'mode', 'reload', 'remote', 'unmount'] as const)(
    'discards a pending result after %s',
    async (change) => {
      const store = createDataModelStore();
      const entities = [entity('A')];
      store.getState().loadFromFile({ ...createEmptyDataModel(), entities });
      let resolve!: (value: Arrangement) => void;
      const compute = vi.fn(
        () =>
          new Promise<Arrangement>((r) => {
            resolve = r;
          })
      );
      const controller = createController(store, compute),
        fit = vi.fn();
      const unbind = controller.bind({
        measure: () => ({
          ...viewport,
          sizes: sizes(store.getState().entities),
        }),
        fit,
        ready: async () => {},
      });
      const pending = controller.state.getState().run();
      await Promise.resolve();
      if (change === 'drag') controller.dragStart();
      if (change === 'field')
        store.getState().updateEntity('A', {
          fields: [{ id: 'f', name: 'f', dataType: 'string' }],
        });
      if (change === 'mode') store.getState().setEntityViewMode('compact');
      if (change === 'reload')
        store.getState().loadFromFile(store.getState().toFileData());
      if (change === 'remote')
        store.setState({ entities: [entity('A', 44, 55)] });
      if (change === 'unmount') unbind();
      const before = store.getState().toFileData();
      resolve({
        nodes: [
          {
            ...entity('A').position,
            id: 'A',
            name: 'A',
            x: 999,
            y: 999,
            width: 250,
            height: 777,
            fields: {},
          },
        ],
        routes: [],
      });
      await pending;
      expect(store.getState().toFileData()).toEqual(before);
      expect(fit).not.toHaveBeenCalled();
      expect(controller.state.getState().busy).toBe(false);
      unbind();
    }
  );
  it('applies one successful mutation but does not override navigation during calculation', async () => {
    const store = createDataModelStore();
    store
      .getState()
      .loadFromFile({ ...createEmptyDataModel(), entities: [entity('A')] });
    const controller = createController(store, async () => {
      controller.navigated();
      return {
        nodes: [
          {
            id: 'A',
            name: 'A',
            x: 500,
            y: 100,
            width: 250,
            height: 777,
            fields: {},
          },
        ],
        routes: [],
      };
    });
    const fit = vi.fn(),
      dirty = vi.fn();
    store.getState().setCallbacks({ onDirtyChange: dirty });
    const unbind = controller.bind({
      measure: () => ({ ...viewport, sizes: sizes(store.getState().entities) }),
      fit,
      ready: async () => {},
    });
    await controller.state.getState().run();
    expect(store.getState().entities[0].position.x).toBe(500);
    expect(dirty).toHaveBeenCalledTimes(1);
    expect(fit).not.toHaveBeenCalled();
    expect(store.getState().toFileData()).not.toHaveProperty('layoutRevision');
    unbind();
  });
});

describe('collaborative layout transaction', () => {
  it('keeps layout undo separate from adjacent edits and preserves remote changes', async () => {
    const Y = await import('yjs');
    const { DataModelBinding } = await import('../collab/datamodelBinding');
    const { seedDataModelYDoc } = await import('../collab/seed');
    const doc = new Y.Doc();
    seedDataModelYDoc(
      doc,
      'model A {\n id String @id\n}\nmodel B {\n id String @id\n}'
    );
    const store = createDataModelStore(),
      binding = new DataModelBinding(doc, store, undefined);
    const undo = (
      binding as unknown as { undoManager: InstanceType<typeof Y.UndoManager> }
    ).undoManager;
    const [a, b] = store.getState().entities;
    store.getState().updateEntity(a.id, { description: 'Before layout' });
    const before = store.getState().entities.map((e) => ({ ...e.position }));
    const updates = vi.fn();
    doc.on('update', updates);
    store.getState().applyLayout(
      new Map([
        [a.id, { x: 700, y: 100 }],
        [b.id, { x: 1100, y: 100 }],
      ])
    );
    expect(updates).toHaveBeenCalledTimes(1);
    doc.transact(
      () =>
        doc
          .getMap<InstanceType<typeof Y.Map>>('entities')
          .get(b.id)!
          .set('description', 'Remote'),
      'peer'
    );
    store.getState().updateEntity(a.id, { color: 'red' });
    undo.undo();
    expect(store.getState().entities[0].position.x).toBe(700);
    undo.undo();
    expect(store.getState().entities.map((e) => e.position)).toEqual(before);
    expect(store.getState().entities[0].description).toBe('Before layout');
    expect(store.getState().entities[1].description).toBe('Remote');
    binding.destroy();
    doc.destroy();
  });
});
