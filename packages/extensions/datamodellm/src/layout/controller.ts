import { createStore } from 'zustand/vanilla';
import type { DataModelStoreApi } from '../store';
import { autoLayoutEntitiesAsync } from '../utils/autoLayout';
import {
  buildGeometry,
  type Arrangement,
  type Direction,
  type Route,
  type Size,
} from './geometry';
import { routeConnections } from './orthogonalRouter';
export interface Measurement {
  sizes: Map<string, Size>;
  width: number;
  height: number;
}
interface Binding {
  measure: () => Measurement;
  fit: () => void;
  ready: () => Promise<void>;
}
interface LayoutState {
  busy: boolean;
  error: string | null;
  direction: Direction;
  routes: Map<string, Route>;
  setDirection: (direction: Direction) => void;
  run: () => Promise<void>;
}
const controllers = new WeakMap<
  DataModelStoreApi,
  ReturnType<typeof createController>
>();
export function layoutController(store: DataModelStoreApi) {
  let controller = controllers.get(store);
  if (!controller) {
    controller = createController(store);
    controllers.set(store, controller);
  }
  return controller;
}
export function createController(
  store: DataModelStoreApi,
  compute = autoLayoutEntitiesAsync
) {
  let binding: Binding | undefined,
    revision = 0,
    navigation = 0,
    geometryKey = '',
    paused = false;
  let observed = store.getState();
  const state = createStore<LayoutState>(() => ({
    busy: false,
    error: null,
    direction: 'automatic',
    routes: new Map(),
    setDirection: (direction) => state.setState({ direction }),
    run,
  }));
  const invalidate = () => {
    revision++;
    geometryKey = '';
    state.setState({ routes: new Map() });
  };
  const snapshotKey = (measurement: Measurement) =>
    JSON.stringify([
      store.getState().entities,
      store.getState().relationships,
      store.getState().entityViewMode,
      [...measurement.sizes],
    ]);
  let unsubscribe: (() => void) | undefined;
  function bind(next: Binding) {
    binding = next;
    observed = store.getState();
    unsubscribe?.();
    unsubscribe = store.subscribe((current) => {
      if (
        current.entities !== observed.entities ||
        current.relationships !== observed.relationships ||
        current.entityViewMode !== observed.entityViewMode ||
        current.documentGeneration !== observed.documentGeneration
      )
        invalidate();
      observed = current;
    });
    return () => {
      binding = undefined;
      unsubscribe?.();
      unsubscribe = undefined;
      invalidate();
    };
  }
  function refresh() {
    if (!binding || paused || state.getState().busy) return;
    try {
      const measurement = binding.measure(),
        key = snapshotKey(measurement);
      if (key === geometryKey) return;
      invalidate();
      const current = store.getState();
      const geometry = buildGeometry(
        current.entities,
        current.relationships,
        measurement.sizes,
        current.entityViewMode
      );
      const routes = routeConnections(geometry);
      geometryKey = key;
      state.setState({
        routes: new Map(routes.map((r) => [r.id, r])),
        error: null,
      });
    } catch (error) {
      state.setState({
        routes: new Map(),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  async function run() {
    if (state.getState().busy) return;
    state.setState({ busy: true, error: null });
    const attached = binding,
      request = revision,
      nav = navigation;
    let obsolete = false;
    try {
      if (!attached)
        throw new Error('Open the diagram before arranging its cards.');
      attached.measure();
      await attached.ready();
      if (attached !== binding || request !== revision || paused) {
        obsolete = true;
        return;
      }
      const before = store.getState(),
        measurement = attached.measure();
      const key = snapshotKey(measurement);
      const result: Arrangement = await compute(
        before.entities,
        before.relationships,
        before.entityViewMode,
        measurement.sizes,
        state.getState().direction,
        measurement
      );
      if (
        attached !== binding ||
        request !== revision ||
        paused ||
        snapshotKey(attached.measure()) !== key
      ) {
        obsolete = true;
        return;
      }
      store
        .getState()
        .applyLayout(
          new Map(result.nodes.map((n) => [n.id, { x: n.x, y: n.y }]))
        );
      geometryKey = snapshotKey(measurement);
      state.setState({
        routes: new Map(result.routes.map((r) => [r.id, r])),
        error: null,
      });
      if (nav === navigation) attached.fit();
    } catch (error) {
      if (attached === binding && request === revision)
        state.setState({
          error: error instanceof Error ? error.message : String(error),
        });
    } finally {
      state.setState({ busy: false });
      if (obsolete) refresh();
    }
  }
  return {
    state,
    bind,
    refresh,
    invalidate,
    navigated: () => {
      navigation++;
    },
    dragStart: () => {
      paused = true;
      invalidate();
    },
    dragEnd: () => {
      paused = false;
      refresh();
    },
  };
}
