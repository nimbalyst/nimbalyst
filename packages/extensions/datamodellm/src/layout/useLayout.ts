import { useEffect, useRef, type RefObject } from 'react';
import { useReactFlow } from '@xyflow/react';
import { useStore } from 'zustand';
import type { DataModelStoreApi } from '../store';
import { layoutController, type Measurement } from './controller';
import type { Size } from './geometry';

/** Read only this canvas, in graph coordinates, never a hidden sibling editor. */
export function measureCanvas(
  root: HTMLElement,
  store: DataModelStoreApi
): Measurement {
  if (!root.clientWidth || !root.clientHeight)
    throw new Error(
      'Open the diagram and wait for its cards to finish measuring.'
    );
  const sizes = new Map<string, Size>();
  for (const wrapper of root.querySelectorAll<HTMLElement>(
    '.react-flow__node'
  )) {
    const id = wrapper.dataset.id,
      card = wrapper.querySelector<HTMLElement>('.datamodel-entity');
    if (!id || !card || !card.offsetWidth || !card.offsetHeight) continue;
    const bounds = card.getBoundingClientRect(),
      scale = bounds.width / card.offsetWidth;
    if (!scale) continue;
    const fields: Record<string, number> = {};
    for (const row of card.querySelectorAll<HTMLElement>('[data-field-name]')) {
      const rect = row.getBoundingClientRect();
      fields[row.dataset.fieldName!] =
        Math.round(((rect.y + rect.height / 2 - bounds.y) / scale) * 100) / 100;
    }
    sizes.set(id, {
      width: card.offsetWidth,
      height: card.offsetHeight,
      fields,
    });
  }
  if (store.getState().entities.some((e) => !sizes.has(e.id)))
    throw new Error(
      'Open the diagram and wait for its cards to finish measuring.'
    );
  return { sizes, width: root.clientWidth, height: root.clientHeight };
}
export function useLayout(
  store: DataModelStoreApi,
  root: RefObject<HTMLDivElement | null>,
  disabled: boolean
) {
  const controller = layoutController(store),
    flow = useReactFlow();
  const routes = useStore(controller.state, (s) => s.routes);
  const error = useStore(controller.state, (s) => s.error);
  const fitFrame = useRef(0);
  useEffect(() => {
    if (!root.current) return;
    const element = root.current;
    const unbind = controller.bind({
      measure: () => measureCanvas(element, store),
      ready: async () => {
        await document.fonts.ready;
        // React Flow applies the new view mode and measures its nodes on successive frames.
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        );
      },
      fit: () => {
        const viewport = flow.getViewport();
        const snapshot = store.getState();
        fitFrame.current = requestAnimationFrame(() => {
          if (
            snapshot.entities === store.getState().entities &&
            snapshot.documentGeneration ===
              store.getState().documentGeneration &&
            JSON.stringify(viewport) === JSON.stringify(flow.getViewport())
          )
            void flow.fitView({ padding: 0.08, maxZoom: 1, duration: 0 });
        });
      },
    });
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => controller.refresh());
    };
    const observer = new ResizeObserver(schedule);
    const observe = () => {
      observer.disconnect();
      observer.observe(element);
      element
        .querySelectorAll('.datamodel-entity')
        .forEach((e) => observer.observe(e));
      schedule();
    };
    const mutations = new MutationObserver(observe);
    mutations.observe(element, { childList: true, subtree: true });
    const unsubscribe = store.subscribe((next, prev) => {
      if (
        next.entities !== prev.entities ||
        next.relationships !== prev.relationships ||
        next.entityViewMode !== prev.entityViewMode
      )
        schedule();
    });
    observe();
    let active = true;
    void document.fonts.ready.then(() => {
      if (active) schedule();
    });
    return () => {
      active = false;
      cancelAnimationFrame(frame);
      cancelAnimationFrame(fitFrame.current);
      observer.disconnect();
      mutations.disconnect();
      unsubscribe();
      unbind();
    };
  }, [controller, flow, root, store]);
  return { controller, routes, error: disabled ? null : error };
}
