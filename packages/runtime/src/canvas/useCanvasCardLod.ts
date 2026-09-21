/**
 * The DOM side of canvas level of detail.
 *
 * Lifted out of CanvasSurface so the surface holds wiring rather than
 * observation; the decisions themselves are all in `computeCanvasCardLod`,
 * which is pure and tested. This module is the observation layer, and it has
 * exactly two jobs beyond feeding that function.
 *
 * **It refuses intersection batches observed while the surface has no box.**
 * Nimbalyst keeps every mode component mounted and hides the inactive ones with
 * `display: none`, so in Agent mode this whole subtree measures 0x0 and
 * `IntersectionObserver` delivers a confident `isIntersecting: false` for every
 * card. Folding that in would demote the entire board and unmount thirty
 * editors, and the user gets that for free every time they glance at a
 * transcript. The check is a synchronous read of the surface's own box inside
 * the callback rather than a flag set by the ResizeObserver, because the
 * ordering of the two observers is not specified and a flag can be one frame
 * stale in exactly the direction that hurts.
 *
 * **It reports hiddenness so the pure function can freeze.** See the header of
 * canvasCardLod for why freezing is the right answer rather than either
 * demoting or continuing to promote.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  computeCanvasCardLod,
  touchCanvasRecency,
  type CanvasCardLod,
} from './canvasCardLod';

/**
 * How far outside the surface a card still counts as visible.
 *
 * Screen pixels against the surface box, so at low zoom this covers more board
 * area -- which is the right way round: a card is cheaper to warm early when it
 * is small, and a pan at low zoom crosses more board per second.
 */
const VISIBILITY_MARGIN_PX = 240;

const EMPTY_LOD: ReadonlyMap<string, CanvasCardLod> = new Map();

export interface CanvasCardLodOptions {
  referenceIds: readonly string[];
  hotId: string | null;
  /** Already bucketed by `canvasZoomBucket`. */
  zoom: number;
  /** True between `onMoveStart` and `onMoveEnd`. */
  gestureActive: boolean;
  surfaceRef: { current: HTMLElement | null };
}

export function useCanvasCardLod({
  referenceIds,
  hotId,
  zoom,
  gestureActive,
  surfaceRef,
}: CanvasCardLodOptions): {
  lod: ReadonlyMap<string, CanvasCardLod>;
  observeCard: (id: string, element: HTMLElement | null) => void;
} {
  const [lod, setLod] = useState<ReadonlyMap<string, CanvasCardLod>>(EMPTY_LOD);
  const [visibleIds, setVisibleIds] = useState<ReadonlySet<string>>(
    () => new Set<string>()
  );
  const [surfaceHidden, setSurfaceHidden] = useState(false);

  const recencyRef = useRef<readonly string[]>([]);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const elementsRef = useRef(new Map<string, HTMLElement>());
  const visibleRef = useRef(visibleIds);
  visibleRef.current = visibleIds;

  const isSurfaceHidden = useCallback(() => {
    const box = surfaceRef.current?.getBoundingClientRect();
    return box === undefined || box.width === 0 || box.height === 0;
  }, [surfaceRef]);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (isSurfaceHidden()) return;
        let next: Set<string> | null = null;
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.canvasNodeId;
          if (id === undefined) continue;
          if (entry.isIntersecting === visibleRef.current.has(id)) continue;
          next ??= new Set(visibleRef.current);
          if (entry.isIntersecting) next.add(id);
          else next.delete(id);
        }
        if (next) {
          visibleRef.current = next;
          setVisibleIds(next);
        }
      },
      { root: surface, rootMargin: `${VISIBILITY_MARGIN_PX}px`, threshold: 0 }
    );
    observerRef.current = observer;
    for (const element of elementsRef.current.values())
      observer.observe(element);

    // Fires when the pane is hidden or shown (a `display: none` element reports
    // a zero box), which is the signal an IntersectionObserver cannot give us.
    const resize = new ResizeObserver(() =>
      setSurfaceHidden(isSurfaceHidden())
    );
    resize.observe(surface);
    setSurfaceHidden(isSurfaceHidden());

    return () => {
      observer.disconnect();
      resize.disconnect();
      observerRef.current = null;
    };
  }, [surfaceRef, isSurfaceHidden]);

  const observeCard = useCallback((id: string, element: HTMLElement | null) => {
    const previous = elementsRef.current.get(id);
    if (previous === element) return;
    if (previous) observerRef.current?.unobserve(previous);
    if (element) {
      elementsRef.current.set(id, element);
      observerRef.current?.observe(element);
    } else {
      elementsRef.current.delete(id);
    }
  }, []);

  useEffect(() => {
    const recency = touchCanvasRecency(recencyRef.current, [
      ...(hotId === null ? [] : [hotId]),
      ...referenceIds.filter((id) => visibleIds.has(id)),
    ]);
    recencyRef.current = recency;
    setLod((previous) =>
      computeCanvasCardLod({
        candidateIds: referenceIds,
        visibleIds,
        zoom,
        hotId,
        surfaceHidden,
        gestureActive,
        previous,
        recency,
      })
    );
  }, [referenceIds, visibleIds, zoom, hotId, surfaceHidden, gestureActive]);

  return { lod, observeCard };
}
